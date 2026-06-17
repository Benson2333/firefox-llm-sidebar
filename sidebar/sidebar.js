// sidebar/sidebar.js
// Sidebar 主 UI 逻辑：
//   - 与 background 通过 runtime.connect 长连接
//   - 订阅 task/start/chunk/done/error 事件
//   - 渲染：tabs 切换、active model 切换、模板选择、跑任务、历史查看、聊天
//   - 能力感知 UI：根据当前 model 的 capabilities 隐藏/禁用不支持的 tab
//   - 历史写入：监听 task/done 后写 IndexedDB（background event page 没有 indexedDB）

import { createStreamSink } from "../lib/stream-renderer.js";
import {
  loadProviders,
  loadSettings,
  saveSettings,
  loadTemplates,
  listHistory,
  deleteHistory,
  clearHistory,
  addHistory,
  toggleStarHistory,
  listDiag,
  getPageCached,
  setPageCached,
} from "../lib/storage.js";
import { supportsCapability } from "../lib/llm-client.js";
import { reportError, reportWarning, installGlobalHandlers } from "../lib/error-reporter.js";

// 装全局错误兜底（捕获 sidebar 页面未捕获的异常 / Promise 拒绝）
installGlobalHandlers();

// ---------- background 连接（带自动重连）----------

let port = null;
let reconnectTimer = null;
const taskSinks = new Map(); // taskId -> { sink, scope, meta }

// 取当前 port（每次重连后都是新对象）
function sendToBackground(msg) {
  if (!port) {
    console.warn("[sidebar] sendToBackground but no port", msg);
    return;
  }
  try {
    port.postMessage(msg);
  } catch (e) {
    console.warn("[sidebar] postMessage failed (port may be dead):", e);
  }
}

async function connectBackground() {
  if (port) {
    try { port.disconnect(); }
    catch (e) { try { reportWarning('sidebar:connect:oldPortDisconnect', e.message, {}); } catch {} ; console.warn("[sidebar] old port disconnect failed", e); }
  }
  port = browser.runtime.connect({ name: "sidebar-ai" });

  // 连接建立后，立即加载最新设置并应用到 UI（确保 options 的更改即时生效）
  try {
    await reloadState();
    applyTheme(state.settings?.theme || "system");
    applyCapabilityAwareUI();
  } catch (e) {
    try { reportWarning('sidebar:connect:reloadState', e.message, {}); } catch {}
    console.warn('[sidebar] reloadState after connect failed', e);
  }

  port.onMessage.addListener((msg) => {
    try {
      switch (msg.type) {
        case "hello":
          console.log("[sidebar] connected", msg);
          try { sendToBackground({ type: "hello-ack" }); }
          catch (e) { try { reportWarning('sidebar:hello-ack', e.message, {}); } catch {} }
          break;
        case "task/start":
          onTaskStart(msg);
          break;
        case "task/chunk":
          onTaskChunk(msg);
          break;
        case "task/done":
          onTaskDone(msg);
          break;
        case "task/meta":
          // background 告诉 sidebar 这条任务的元数据（chat user question 等）
          if (msg.taskId) {
            const entry = taskSinks.get(msg.taskId) || { sink: null };
            entry.userQuestion = msg.userQuestion;
            entry.persist = msg.persist;
            taskSinks.set(msg.taskId, entry);
          }
          break;
        case "task/error":
          onTaskError(msg);
          break;
        case "task/aborted":
          onTaskAborted(msg);
          break;
        case "command":
          // handle simple commands; also support vision-image which may carry imageUrl
          if (msg.command === "vision-image" && msg.imageUrl) {
            // fetch image in sidebar context (no credentials) and send to background run pipeline
            (async () => {
              try {
                // ask user for confirmation before sending image off-device
                const ok = confirm("确认将此图片发送到已配置的模型进行识别？\n如果不确定，请先在设置里检查 provider。\nURL: " + msg.imageUrl);
                if (!ok) return;
                // fetch without credentials to avoid sending cookies
                const resp = await fetch(msg.imageUrl, { mode: "cors", credentials: "omit" });
                if (!resp.ok) throw new Error(`图片下载失败：HTTP ${resp.status}`);
                const blob = await resp.blob();
                const reader = new FileReader();
                reader.onload = () => {
                  const base64 = String(reader.result || "");
                  // send to background for processing (background may implement vision handling)
                  sendToBackground({ type: "run/vision-image", taskId: crypto.randomUUID(), imageUrl: msg.imageUrl, imageData: base64 });
                  showNotice({ kind: "info", title: "已发送图片进行识别", body: "识别任务已发送，识别结果会在任务完成后显示。" });
                };
                reader.onerror = (e) => { throw new Error("读取图片失败"); };
                reader.readAsDataURL(blob);
              } catch (e) {
                try { reportWarning('sidebar:vision:process', e.message, { imageUrl: msg.imageUrl }); } catch {}
                showNotice({ kind: "error", title: "图片处理失败", body: String(e?.message || e) });
              }
            })();
          } else {
            handleCommand(msg.command);
          }
          break;
        case "error":
          showNotice({ kind: "error", title: "后台错误", body: msg.error });
          setStatus(msg.error, "error");
          break;
      }
    } catch (err) {
      try { reportError('sidebar:portHandler', err, { msg }); } catch {}
      console.error("[sidebar] port handler error", err, msg);
      showNotice({ kind: "error", title: "UI 异常", body: String(err?.message || err) });
    }
  });

  port.onDisconnect.addListener(() => {
    console.warn("[sidebar] port disconnected, will reconnect in 1s");
    setStatus("连接已断开，1 秒后重连…", "error");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connectBackground();
      setStatus("就绪", "");
    }, 1000);
  });

  // 监听 background 推过来的 error/remote 事件（用 error-reporter 推出来的）
  port.onMessage.addListener((msg) => {
    if (msg?.type === "error/remote") {
      showRemoteError(msg);
    } else if (msg?.type === "error/ack") {
      // background 收到 ack 用来清未读
      if (typeof msg.unread === "number") {
        unreadErrorCount = msg.unread;
        renderErrorBadge();
      }
    }
  });
}

// ============================================================
// 错误队列 + 未读徽章
// ============================================================
let errorQueue = [];        // 排队的未确认错误 payload
let unreadErrorCount = 0;   // 未读条数（用户没点开过）
let currentErrorIdx = -1;   // 当前展示的队列 index
const ERROR_QUEUE_MAX = 10;

function showRemoteError(payload) {
  const { level = "error", scope, message, details, ts, hash, kind, userHint } = payload;
  // 同 hash 在 30s 内合并到现有队列
  if (hash && errorQueue.some((e) => e.hash === hash && Date.now() - e.ts < 30_000)) {
    unreadErrorCount++;
    renderErrorBadge();
    return;
  }
  if (errorQueue.length >= ERROR_QUEUE_MAX) errorQueue.shift();
  const enriched = { ...payload, title: `${scope || "unknown"}`, body: message, userHint: userHint || details?.userHint };
  errorQueue.push(enriched);
  currentErrorIdx = errorQueue.length - 1;
  unreadErrorCount++;
  renderErrorBadge();
  renderErrorDialog();
}

function renderErrorBadge() {
  const badge = document.getElementById("errorBadge");
  if (!badge) return;
  if (unreadErrorCount > 0) {
    badge.textContent = unreadErrorCount > 99 ? "99+" : String(unreadErrorCount);
    badge.style.display = "";
  } else {
    badge.style.display = "none";
  }
}

function renderErrorDialog() {
  if (currentErrorIdx < 0 || currentErrorIdx >= errorQueue.length) {
    document.getElementById("noticeDialog")?.close();
    return;
  }
  const p = errorQueue[currentErrorIdx];
  const titleMap = { error: "后台错误", warn: "后台警告", info: "后台信息" };
  const kindMap = { error: "error", warn: "warn", info: "success" };
  const level = p.level || "error";
  const time = new Date(p.ts || Date.now()).toLocaleTimeString();
  const total = errorQueue.length;
  const navHint = total > 1 ? `（${currentErrorIdx + 1}/${total}）` : "";
  showNotice({
    kind: kindMap[level] || "error",
    title: `${titleMap[level] || "后台错误"}${navHint} · ${time}`,
    body: `[${p.scope || "unknown"}] ${p.message}${p.userHint ? `\n\n💡 ${p.userHint}` : ""}`,
    detailJson: {
      level,
      scope: p.scope,
      message: p.message,
      kind: p.kind,
      userHint: p.userHint,
      ts: p.ts,
      details: p.details,
      queue: { current: currentErrorIdx + 1, total },
      hint: "这是 background 主动上报的错误，会写入 IndexedDB 诊断日志。\n如反复出现，请到设置 → 诊断 → 导出完整诊断包发给我。",
    },
    extraButtons: [
      ...(currentErrorIdx > 0 ? [{ id: "errPrev", label: "← 上一条" }] : []),
      ...(currentErrorIdx < errorQueue.length - 1 ? [{ id: "errNext", label: "下一条 →" }] : []),
      { id: "errClearAll", label: `全部已读（${total}）` },
    ],
  });
}

// 弹窗"上一条/下一条/全部已读"按钮
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-extra-id]");
  if (!btn) return;
  const id = btn.dataset.extraId;
  if (id === "errPrev" && currentErrorIdx > 0) {
    currentErrorIdx--;
    renderErrorDialog();
  } else if (id === "errNext" && currentErrorIdx < errorQueue.length - 1) {
    currentErrorIdx++;
    renderErrorDialog();
  } else if (id === "errClearAll") {
    errorQueue = [];
    currentErrorIdx = -1;
    unreadErrorCount = 0;
    renderErrorBadge();
    document.getElementById("noticeDialog")?.close();
  }
});

connectBackground();

// sidebar 在前台时持续保活 background（25s 一次，比 background 的 60s idle 检查早，防误关）
setInterval(() => {
  sendToBackground({ type: "keepalive", ts: Date.now() });
}, 25000);

function onTaskStart(msg) {
  setStatus(`生成中…（${msg.scope}）`, "");
  const target = pickResultEl(msg.scope);
  if (!target) return; // chat 自己处理
  // 同步预创建 sink，避免 chunk 在 sink 未就绪时丢包
  // summary / selection-explain 加"用对话追问"按钮
  const showFollowup = msg.scope === "summary";
  const sink = createStreamSinkSync(target, { showFollowupButton: showFollowup });
  // 记录 task 启动时的 meta（provider/model）— 失败时写历史用
  const meta = {
    providerId: state.settings?.activeProviderId || "",
    modelId: state.settings?.activeModelId || "",
  };
  taskSinks.set(msg.taskId, { sink, scope: msg.scope, meta, target });
}

// 追问按钮点击事件：把目标元素的内容作为上下文，自动跳到 chat tab
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".followup-btn");
  if (!btn) return;
  e.preventDefault();
  const container = btn.closest(".result") || btn.parentElement.parentElement;
  const text = container?.dataset?.raw || container?.textContent || "";
  const tabBtn = document.querySelector('.tab[data-tab="chat"]');
  if (tabBtn) tabBtn.click();
  els.chatInput.value = `基于刚刚的总结：\n\n${text.slice(0, 1500)}\n\n请帮我：`;
  els.chatInput.focus();
  setStatus("已填入追问输入框，请编辑后发送", "");
});

function onTaskChunk({ taskId, delta }) {
  const entry = taskSinks.get(taskId);
  if (entry?.sink) entry.sink.push(delta);
}

async function onTaskDone(msg) {
  const entry = taskSinks.get(msg.taskId);
  if (entry?.sink) {
    entry.sink.finish();
  }
  if (entry?.scope) setBusy(entry.scope, false);

  // 显示 token 用量
  if (msg.usage) {
    const u = msg.usage;
    const total = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
    setStatus(`完成（输入 ${u.prompt_tokens || 0} · 输出 ${u.completion_tokens || 0} · 合计 ${total}）`, "success");
  }

  // 写历史（仅 sidebar 端能做，background 没有 indexedDB）
  const persist = entry?.persist !== false; // 默认 true
  if (msg.content && persist) {
    try {
      const scope = msg.scope || entry?.scope || "chat";
      // chat 用 user 问题作为 title，其他用页面 title
      const title = scope === "chat"
        ? (entry?.userQuestion || "对话").slice(0, 80)
        : (msg.meta?.title || "");
      const id = await addHistory({
        scope,
        url: msg.meta?.url || "",
        title,
        preview: msg.content.slice(0, 240),
        content: msg.content,
        providerId: msg.meta?.providerId || "",
        modelId: msg.meta?.modelId || "",
        domain: msg.meta?.domain || "",
      });
      // 总结类型 + 有 url → 写 page cache（用于"已总结"标记）
      if (id && (scope === "summary" || scope === "selection-explain") && msg.meta?.url) {
        setPageCached(msg.meta.url, id).catch(() => {});
      }
      if (document.getElementById("panel-history")?.classList.contains("active")) {
        refreshHistoryList();
      }
    } catch (e) {
      try { reportWarning('sidebar:onTaskDone:addHistory', e.message, { taskId: msg.taskId }); } catch {}
      console.warn("[sidebar-ai] history write failed", e);
    }
  }
  taskSinks.delete(msg.taskId);
  setStatus("完成", "success");
}

async function onTaskError({ taskId, error }) {
  const entry = taskSinks.get(taskId);
  if (entry?.sink) entry.sink.fail(error);
  if (entry?.scope) setBusy(entry.scope, false);
  taskSinks.delete(taskId);
  setStatus(`失败：${friendlyError(error)}`, "error");

  // 读取最近一条诊断日志（应该就是这次失败的）
  let lastDiag = null;
  try {
    const { listDiag } = await import("../lib/storage.js");
    const diags = await listDiag({ limit: 1, level: "error" });
    lastDiag = diags[0] || null;
  } catch (e) { reportWarning("sidebar:onTaskError:listDiag", e.message); }

  // 弹窗带"复制详情"按钮
  showNotice({
    kind: "error",
    title: "请求失败",
    body: error,
    detailJson: {
      error,
      ts: new Date().toISOString(),
      scope: entry?.scope || "chat",
      lastDiag,
      hint: "把这段 JSON 发给开发者可以快速定位问题。\n" +
            "常见原因：\n" +
            "  1) API key 错误或过期\n" +
            "  2) baseUrl 拼错（注意末尾不要带斜杠）\n" +
            "  3) 模型 id 错误（去服务商文档核对）\n" +
            "  4) CORS：浏览器跨域被拦截（需要服务端配置或反向代理）\n" +
            "  5) 网络不通",
    },
  });
  // 失败也写历史（带完整错误详情，方便复盘）
  addHistory({
    scope: entry?.scope || "chat",
    url: entry?.meta?.url || "",
    title: "(失败)",
    preview: error.slice(0, 200),
    content: `[失败] ${error}`,
    providerId: entry?.meta?.providerId || "",
    modelId: entry?.meta?.modelId || "",
    domain: entry?.meta?.domain || "",
    status: "failed",
    errorDetails: {
      message: error,
      ts: Date.now(),
      scope: entry?.scope || "chat",
      meta: entry?.meta || null,
      lastDiag,
      kind: lastDiag?.details?.kind,
      userHint: lastDiag?.details?.userHint,
    },
  }).catch((e) => reportWarning("sidebar:onTaskError:addHistory", e.message));
  if (document.getElementById("panel-history")?.classList.contains("active")) {
    refreshHistoryList();
  }
}

function onTaskAborted({ taskId }) {
  const entry = taskSinks.get(taskId);
  if (entry?.sink) entry.sink.fail("已取消");
  if (entry?.scope) setBusy(entry.scope, false);
  taskSinks.delete(taskId);
  setStatus("已取消", "");
}

function pickResultEl(scope) {
  if (scope === "summary" || scope === "selection-explain") return el("summaryResult");
  if (scope === "translate" || scope === "translate-selection") return el("translateResult");
  return null;
}

// 同步创建 sink：把 ensureLibs() 提前到模块加载时执行
let _sinkReady = null;
function ensureSinkReady() {
  if (!_sinkReady) {
    _sinkReady = ensureLibsReady();
  }
  return _sinkReady;
}
async function ensureLibsReady() {
  const mod = await import("../lib/stream-renderer.js");
  return mod.createStreamSink;
}
function createStreamSinkSync(target, opts = {}) {
  // 因为 createStreamSink 本身 async (load vendor)，我们先用 stub 占位，
  // ready 后把后续 chunk 喂给真实 sink
  let realSink = null;
  const buffer = { pending: "", finishPending: false, failPending: null };
  ensureSinkReady().then((create) => {
    // 关键修复：create() 本身是 async，必须 await！
    Promise.resolve(create({
      target,
      onDone: opts.onDone || (() => setStatus("完成", "success")),
      onError: opts.onError || ((err) => setStatus(err.message, "error")),
    })).then((sink) => {
      realSink = sink;
      if (buffer.pending) {
        realSink.push(buffer.pending);
        buffer.pending = "";
      }
      if (buffer.finishPending) {
        realSink.finish();
        buffer.finishPending = false;
      }
      if (buffer.failPending != null) {
        realSink.fail(buffer.failPending);
        buffer.failPending = null;
      }
      if (opts.onRealReady) opts.onRealReady(realSink);
    }).catch((err) => {
      console.error("[sidebar-ai] createStreamSink failed", err);
      if (target) {
        target.textContent = "";
        const div = document.createElement("div");
        div.className = "md-error";
        div.textContent = `初始化渲染器失败：${String(err?.message || err)}`;
        target.appendChild(div);
      }
    });
  });
  return {
    push(token) {
      if (realSink) realSink.push(token);
      else buffer.pending += token;
    },
    finish() {
      if (realSink) realSink.finish();
      else buffer.finishPending = true;
    },
    fail(err) {
      if (realSink) realSink.fail(err);
      else buffer.failPending = err;
    },
  };
}

// ---------- UI 引用 ----------

const $ = (id) => document.getElementById(id);
function el(id) { return document.getElementById(id); }

const els = {
  activeModelSelect: el("activeModelSelect"),
  openSettingsBtn: el("openSettingsBtn"),
  collapseBtn: el("collapseBtn"),
  tabs: document.querySelectorAll(".tab"),
  panels: document.querySelectorAll(".panel"),
  summaryBtn: el("summaryBtn"),
  summaryCompareBtn: el("summaryCompareBtn"),
  summaryResult: el("summaryResult"),
  summaryTemplateSelect: el("summaryTemplateSelect"),
  summaryLengthSelect: el("summaryLengthSelect"),
  summaryHint: el("summaryHint"),
  translateBtn: el("translateBtn"),
  translateResult: el("translateResult"),
  translateTemplateSelect: el("translateTemplateSelect"),
  translateBilingualToggle: el("translateBilingualToggle"),
  targetLangSelect: el("targetLangSelect"),
  translateHint: el("translateHint"),
  chatList: el("chatList"),
  chatInput: el("chatInput"),
  chatSendBtn: el("chatSendBtn"),
  chatContextToggle: el("chatContextToggle"),
  chatClearBtn: el("chatClearBtn"),
  chatExportBtn: el("chatExportBtn"),
  historyList: el("historyList"),
  compareResults: el("compareResults"),
  historyClearBtn: el("historyClearBtn"),
  historyExportBtn: el("historyExportBtn"),
  historySearchInput: el("historySearchInput"),
  historyHint: el("historyHint"),
  statusbar: el("statusbar"),
};

// ---------- 启动 ----------

let state = {
  settings: null,
  providers: [],
  templates: [],
  modelInfo: null,
  busy: { summary: false, translate: false, chat: false },
};

// 预热 vendor（让首次创建 sink 时快一点）
ensureSinkReady();

(async function init() {
  await reloadState();
  applyTheme(state.settings?.theme || "system");
  bindUI();
  await refreshActiveModelSelect();
  await refreshTemplateSelects();
  await refreshHistoryList();
  applyCapabilityAwareUI();
  checkFirstRun();
  checkCurrentPageCached();
})();

// 当前页是否已总结过 → 顶部显示提示
async function checkCurrentPageCached() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    if (tab.url.startsWith("about:") || tab.url.startsWith("moz-extension:")) return;
    const cached = await getPageCached(tab.url);
    if (cached && cached.summaryId) {
      showNotice({
        kind: "success",
        title: "已总结过此页",
        body: `总结于 ${new Date(cached.ts).toLocaleString()}，可在"历史"标签查看或重新总结。`,
        autoCloseMs: 5000,
      });
    }
  } catch (e) { try { reportWarning('sidebar:checkCurrentPageCached', e.message, {}); } catch {} }
}

// 监听 options 页修改设置（通过 runtime 消息）
browser.runtime.onMessage?.addListener?.((msg) => {
  if (msg?.type === "settings/changed" && msg.settings) {
    state.settings = msg.settings;
    applyTheme(msg.settings.theme || "system");
    applyCapabilityAwareUI();
  }
});

function applyTheme(theme) {
  document.body.classList.remove("theme-light", "theme-dark", "theme-sepia");
  if (theme === "light") document.body.classList.add("theme-light");
  else if (theme === "dark") document.body.classList.add("theme-dark");
  else if (theme === "sepia") document.body.classList.add("theme-sepia");
  // "system" 跟随 prefers-color-scheme（已在 CSS 处理）
}

// 首次使用：未配置模型时主动引导
function checkFirstRun() {
  if (!state.modelInfo) {
    setTimeout(() => {
      showNotice({
        kind: "warn",
        title: "尚未配置模型",
        body: "点击右上角 ⚙ 进入设置 → 添加 Provider（推荐 DeepSeek / OpenAI / Ollama）→ 添加模型 → 设为当前。\n\n添加完后回到这里就能用总结/翻译/对话了。",
        autoCloseMs: 8000,
      });
    }, 300);
  }
}

async function reloadState() {
  state.settings = await loadSettings();
  state.providers = await loadProviders();
  state.templates = await loadTemplates();

  const activeProviderId = state.settings.activeProviderId;
  const cfg = state.providers.find((p) => p.id === activeProviderId);
  if (cfg && state.settings.activeModelId) {
    const m = (cfg.models || []).find((m) => m.id === state.settings.activeModelId);
    state.modelInfo = {
      provider: {
        capabilities: {
          chat: true,
          streaming: true,
          vision: !!m?.vision,
          tools: !!m?.tools,
        },
      },
      model: m,
    };
  } else {
    state.modelInfo = null;
  }
}

function applyCapabilityAwareUI() {
  const mi = state.modelInfo;
  const hasModel = !!mi;
  els.summaryBtn.disabled = !hasModel || state.busy.summary;
  els.translateBtn.disabled = !hasModel || state.busy.translate;
  els.chatSendBtn.disabled = !hasModel || state.busy.chat;

  const badges = [];
  if (mi?.provider?.capabilities?.vision) badges.push("👁 vision");
  if (mi?.provider?.capabilities?.tools) badges.push("🛠 tools");

  if (!hasModel) {
    els.summaryHint.textContent = "未配置模型，点击右上角 ⚙ 添加。";
    els.summaryHint.className = "hint error";
    els.translateHint.textContent = "未配置模型，点击右上角 ⚙ 添加。";
    els.translateHint.className = "hint error";
  } else {
    const tag = badges.length ? `  · ${badges.join(" · ")}` : "";
    els.summaryHint.textContent = `当前模型：${mi.model?.label || mi.model?.id}${tag}`;
    els.summaryHint.className = "hint";
    els.translateHint.textContent = `目标语言：${state.settings.targetLang}`;
    els.translateHint.className = "hint";
  }
}

// 任务进行中设置 busy 状态（按钮变灰、显示 "生成中…"）
function setBusy(scope, busy) {
  state.busy[scope] = busy;
  const btn = scope === "summary" ? els.summaryBtn
            : scope === "translate" ? els.translateBtn
            : els.chatSendBtn;
  if (!btn) return;
  if (busy) {
    btn.dataset.origText = btn.dataset.origText || btn.textContent;
    btn.textContent = "生成中…";
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.origText || btn.textContent;
    btn.disabled = false;
  }
}

async function refreshActiveModelSelect() {
  const sel = els.activeModelSelect;
  sel.innerHTML = "";

  // 没有任何 provider：显示"未配置模型"占位并直接返回
  if (state.providers.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "未配置模型";
    opt.value = "";
    sel.appendChild(opt);
    return;
  }

  // 按 group 分组（没设 group 的归到"未分组"）
  const groups = state.settings.modelGroups || [];
  const byGroup = new Map();
  for (const p of state.providers) {
    const g = p.group || "未分组";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(p);
  }
  // 按 modelGroups 顺序输出，未分组放最后
  const ordered = [];
  for (const g of groups) if (byGroup.has(g)) ordered.push([g, byGroup.get(g)]);
  for (const [g, list] of byGroup) {
    if (!groups.includes(g)) ordered.push([g, list]);
  }

  for (const [groupName, providers] of ordered) {
    if (providers.length === 0) continue;
    const groupOpt = document.createElement("optgroup");
    groupOpt.label = groupName;
    for (const p of providers) {
      for (const m of (p.models || [])) {
        const opt = document.createElement("option");
        opt.value = JSON.stringify({ providerId: p.id, modelId: m.id });
        opt.textContent = `${p.label} · ${m.label || m.id}`;
        if (p.id === state.settings.activeProviderId && m.id === state.settings.activeModelId) {
          opt.selected = true;
        }
        groupOpt.appendChild(opt);
      }
    }
    sel.appendChild(groupOpt);
  }
}

async function refreshTemplateSelects() {
  const fill = (selectEl, scope) => {
    selectEl.innerHTML = "";
    const filtered = state.templates.filter((t) => t.scope === scope);
    // 没有模板：显示"（无模板）"占位并直接返回
    if (filtered.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "（无模板）";
      opt.value = "";
      selectEl.appendChild(opt);
      return;
    }
    for (const t of filtered) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name + (t.builtin ? "（内置）" : "");
      selectEl.appendChild(opt);
    }
  };
  fill(els.summaryTemplateSelect, "summary");
  fill(els.translateTemplateSelect, "translate");
}

// ---------- 事件绑定 ----------

function bindUI() {
  els.tabs.forEach((t) => {
    t.addEventListener("click", () => {
      els.tabs.forEach((x) => x.classList.remove("active"));
      els.panels.forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      const target = document.getElementById(`panel-${t.dataset.tab}`);
      target?.classList.add("active");
      // 切到历史 tab 时刷新一次
      if (t.dataset.tab === "history") refreshHistoryList();
    });
  });

  els.activeModelSelect.addEventListener("change", async (e) => {
    const v = e.target.value;
    if (!v) return;
    const { providerId, modelId } = JSON.parse(v);
    await saveSettings({ activeProviderId: providerId, activeModelId: modelId });
    await reloadState();
    applyCapabilityAwareUI();
  });

  els.openSettingsBtn.addEventListener("click", () => {
    browser.runtime.openOptionsPage?.();
  });

  // 折叠/展开 sidebar 内容区
  els.collapseBtn?.addEventListener("click", () => {
    document.body.classList.toggle("sidebar-collapsed");
  });

  // 双击顶栏 brand 区域 = ping background（诊断用）
  document.querySelector(".brand")?.addEventListener("dblclick", () => {
    try {
      sendToBackground({ type: "ping" });
      showNotice({ kind: "warn", title: "已发送 ping", body: "如果 sidebar 没反应，说明 port 已断。请重新打开 sidebar 或重新载入扩展。", autoCloseMs: 3000 });
    } catch (e) {
      showNotice({ kind: "error", title: "连接已断", body: "port 已断开，无法通信。", autoCloseMs: 4000 });
    }
  });

  els.summaryLengthSelect.value = state.settings.summaryLength;
  els.summaryLengthSelect.addEventListener("change", async (e) => {
    await saveSettings({ summaryLength: e.target.value });
    state.settings = await loadSettings();
  });

  els.targetLangSelect.value = state.settings.targetLang;
  els.targetLangSelect.addEventListener("change", async (e) => {
    await saveSettings({ targetLang: e.target.value });
    state.settings = await loadSettings();
    applyCapabilityAwareUI();
  });

  els.summaryBtn.addEventListener("click", async () => {
    const taskId = crypto.randomUUID();
    els.summaryResult.innerHTML = "";
    setBusy("summary", true);
    sendToBackground({
      type: "run/summary",
      taskId,
      templateId: els.summaryTemplateSelect.value || undefined,
    });
  });

  els.translateBtn.addEventListener("click", async () => {
    const taskId = crypto.randomUUID();
    els.translateResult.innerHTML = "";
    setBusy("translate", true);
    // 双语模式：自动选"中英对照翻译"模板（如果存在）
    let templateId = els.translateTemplateSelect.value || undefined;
    if (els.translateBilingualToggle?.checked) {
      const bilingual = state.templates.find((t) => t.id === "tpl-translate-bilingual" || /双语|对照/.test(t.name || ""));
      if (bilingual) templateId = bilingual.id;
    }
    sendToBackground({
      type: "run/translate",
      taskId,
      templateId,
    });
  });

  // 双语模式 toggle 变化时给出提示
  els.translateBilingualToggle?.addEventListener("change", async (e) => {
    if (e.target.checked) {
      setStatus("已开启双语对照模式", "");
    }
  });

  els.chatSendBtn.addEventListener("click", sendChat);
  els.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
  els.chatClearBtn?.addEventListener("click", () => {
    if (!confirm("清空当前对话？")) return;
    chatMessages.length = 0;
    els.chatList.innerHTML = "";
  });
  els.chatExportBtn?.addEventListener("click", exportChatMarkdown);

  els.historyClearBtn.addEventListener("click", async () => {
    if (!confirm("清空全部历史记录？")) return;
    await clearHistory();
    await refreshHistoryList();
  });
  els.historySearchInput?.addEventListener("input", () => {
    clearTimeout(refreshHistoryList._t);
    refreshHistoryList._t = setTimeout(refreshHistoryList, 200);
  });
  els.historyExportBtn?.addEventListener("click", exportHistoryMarkdown);

  els.summaryCompareBtn?.addEventListener("click", openCompareDialog);

  // 弹窗关闭
  document.getElementById("noticeCloseBtn")?.addEventListener("click", () => {
    document.getElementById("noticeDialog")?.close();
  });
  // 弹窗 - 复制错误详情
  document.getElementById("noticeCopyBtn")?.addEventListener("click", async (e) => {
    const detail = e.currentTarget.dataset.detail || "";
    try {
      await navigator.clipboard.writeText(detail);
      e.currentTarget.textContent = "已复制 ✓";
      setTimeout(() => { e.currentTarget.textContent = "复制错误详情"; }, 2000);
    } catch {
      // fallback: 选中文本
      const ta = document.createElement("textarea");
      ta.value = detail;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  });
  // 点 dialog 背景关闭
  document.getElementById("noticeDialog")?.addEventListener("click", (e) => {
    const dlg = e.currentTarget;
    if (e.target === dlg) dlg.close();
  });
  // 弹窗关闭时清未读（用户确认过了）
  document.getElementById("noticeDialog")?.addEventListener("close", () => {
    if (errorQueue.length === 0 || currentErrorIdx === errorQueue.length - 1) {
      unreadErrorCount = 0;
      renderErrorBadge();
    }
  });
  // 错误徽章点击 → 重弹当前队列
  document.getElementById("errorBadge")?.addEventListener("click", () => {
    if (errorQueue.length > 0) {
      currentErrorIdx = errorQueue.length - 1;
      renderErrorDialog();
    }
  });
}

const chatMessages = []; // [{role, content}]

async function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  els.chatInput.value = "";
  chatMessages.push({ role: "user", content: text });
  appendChatBubble("user", text);
  const taskId = crypto.randomUUID();
  const placeholder = appendChatBubble("assistant", "生成中…");

  // chat 用特殊 sink：finish 时把 assistant 完整文本写进 chatMessages
  const sink = createStreamSinkSync(placeholder, {
    onDone: () => {
      const raw = placeholder.dataset.raw || placeholder.textContent || "";
      const last = chatMessages[chatMessages.length - 1];
      if (!(last && last.role === "assistant" && last.content === raw)) {
        chatMessages.push({ role: "assistant", content: raw });
      }
      setStatus("完成", "success");
    },
  });
  taskSinks.set(taskId, { sink, scope: "chat", meta: null });
  sendToBackground({
    type: "run/chat",
    taskId,
    messages: chatMessages.slice(),
    useContext: !!els.chatContextToggle?.checked,
  });
}

function appendChatBubble(role, text) {
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  if (role === "assistant") {
    div.dataset.raw = text;
  } else {
    div.textContent = text;
  }
  els.chatList.appendChild(div);
  els.chatList.scrollTop = els.chatList.scrollHeight;
  return div;
}

// ---------- 历史 ----------

async function refreshHistoryList() {
  const query = els.historySearchInput?.value || "";
  const allItems = await listHistory({ limit: 100, query });
  els.historyList.innerHTML = "";
  const failedCount = allItems.filter((x) => x.status === "failed").length;
  const tag = query ? `（搜索 "${query}"）` : "";
  els.historyHint.textContent = `共 ${allItems.length} 条${failedCount ? `（${failedCount} 条失败）` : ""}${tag}`;

  if (allItems.length === 0) {
    const li = document.createElement("li");
    li.className = "history-item";
    const d = document.createElement("div");
    d.className = "history-preview";
    d.textContent = query ? "没有匹配的历史" : "暂无历史";
    li.appendChild(d);
    els.historyList.appendChild(li);
    return;
  }

  // 收藏分组
  const starred = allItems.filter((x) => x.starred);
  const rest = allItems.filter((x) => !x.starred);

  if (starred.length) {
    const header = document.createElement("li");
    header.className = "history-group-header";
    header.textContent = `⭐ 收藏 (${starred.length})`;
    els.historyList.appendChild(header);
    starred.forEach((it) => els.historyList.appendChild(buildHistoryItem(it)));
  }
  if (rest.length) {
    if (starred.length) {
      const header = document.createElement("li");
      header.className = "history-group-header";
      header.textContent = `其他 (${rest.length})`;
      els.historyList.appendChild(header);
    }
    rest.forEach((it) => els.historyList.appendChild(buildHistoryItem(it)));
  }
}

function buildHistoryItem(it) {
  const li = document.createElement("li");
  li.className = "history-item" + (it.status === "failed" ? " history-failed" : "");
  const date = new Date(it.createdAt).toLocaleString();
  const star = it.starred ? '⭐' : '☆';

  const meta = document.createElement("div");
  meta.className = "history-meta";
  const domainSpan = document.createElement("span");
  domainSpan.className = "history-domain";
  domainSpan.textContent = (it.domain || it.url || "—");
  if (it.status === "failed") {
    const failedTag = document.createElement("span");
    failedTag.className = "failed-tag";
    failedTag.textContent = "失败";
    domainSpan.appendChild(document.createTextNode(" "));
    domainSpan.appendChild(failedTag);
  }
  const dateSpan = document.createElement("span");
  dateSpan.textContent = date;
  meta.appendChild(domainSpan);
  meta.appendChild(dateSpan);

  const preview = document.createElement("div");
  preview.className = "history-preview";
  preview.textContent = it.title || it.preview || "";

  const actions = document.createElement("div");
  actions.className = "history-actions";
  if (it.status === "failed" && it.errorDetails) {
    const errBtn = document.createElement("button");
    errBtn.type = "button";
    errBtn.className = "history-btn err-btn";
    errBtn.dataset.id = it.id;
    errBtn.title = "查看失败详情";
    errBtn.textContent = "⚠";
    actions.appendChild(errBtn);
  }
  const starBtn = document.createElement("button");
  starBtn.type = "button";
  starBtn.className = "history-btn star-btn";
  starBtn.dataset.id = it.id;
  starBtn.title = "收藏/取消收藏";
  starBtn.textContent = star;
  actions.appendChild(starBtn);
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "history-btn del-btn";
  delBtn.dataset.id = it.id;
  delBtn.title = "删除";
  delBtn.textContent = "🗑";
  actions.appendChild(delBtn);

  li.appendChild(meta);
  li.appendChild(preview);
  li.appendChild(actions);
  li.addEventListener("click", (e) => {
    if (e.target.closest(".history-btn")) return; // 按钮不触发打开
    openHistoryItem(it);
  });
  li.querySelector(".star-btn")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    await toggleStarHistory(it.id);
    await refreshHistoryList();
  });
  li.querySelector(".err-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    showNotice({
      kind: "error",
      title: "失败详情",
      body: it.errorDetails?.message || it.preview || "未知错误",
      detailJson: {
        ...(it.errorDetails || {}),
        hint: "这是当时的错误快照。完整堆栈可能已被 IndexedDB 覆盖（只保留最近 200 条）。\n如需查最新诊断，到设置 → 诊断 tab。",
      },
    });
  });
  li.querySelector(".del-btn")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("删除这条历史？")) return;
    await deleteHistory(it.id);
    await refreshHistoryList();
  });
  return li;
}

function openHistoryItem(it) {
  // 根据 scope 切到对应 tab，渲染内容
  let tabName;
  if (it.scope === "summary" || it.scope === "selection-explain") tabName = "summary";
  else if (it.scope === "translate" || it.scope === "translate-selection") tabName = "translate";
  else if (it.scope === "chat") tabName = "chat";
  else tabName = "summary";

  els.tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tabName));
  els.panels.forEach((p) => p.classList.toggle("active", p.id === `panel-${tabName}`));

  if (tabName === "chat") {
    // 清空 chatList，把历史内容作为一条 assistant 消息展示。
    // 注：chat 历史在 background runChat 阶段已经通过 task/meta 传了 userQuestion，
    // 在 onTaskDone 里被用作 title；这里只负责把 assistant 输出渲染回 chatList。
    els.chatList.innerHTML = "";
    appendChatBubble("assistant", it.content);
    return;
  }

  const target = el(tabName + "Result");
  if (!target) return;
  target.innerHTML = "";
  // 直接渲染（不流式）
  import("../lib/stream-renderer.js").then(async (mod) => {
    try {
      const sink = await mod.createStreamSink({ target });
      sink.push(it.content || "");
      sink.finish();
    } catch (e) {
      try { reportWarning('sidebar:openHistoryItem:createStreamSink', e.message, { id: it.id }); } catch {}
      target.textContent = "";
      const divErr = document.createElement("div");
      divErr.className = "md-error";
      divErr.textContent = `加载渲染器失败：${String(e?.message || e)}`;
      target.appendChild(divErr);
    }
  });
}

// ---------- 命令（来自快捷键 / 右键菜单）----------

async function handleCommand(cmd) {
  switch (cmd) {
    case "summarize":
      switchToTab("summary");
      els.summaryBtn.click();
      break;
    case "translate":
      switchToTab("translate");
      els.translateBtn.click();
      break;
    case "selection-translate":
      switchToTab("translate");
      sendToBackground({ type: "run/selection", taskId: crypto.randomUUID(), scope: "translate" });
      break;
    case "selection-explain":
      switchToTab("summary");
      sendToBackground({ type: "run/selection", taskId: crypto.randomUUID(), scope: "explain" });
      break;
    case "vision-image":
      // cmd from context menu: payload sent by background contains imageUrl in a separate message,
      // background broadcasts { type: 'command', command: 'vision-image', imageUrl }
      // here we expect background to have forwarded the command; fetch will be handled in port message handler
      // fallback: switch to chat tab and show notice
      switchToTab("chat");
      showNotice({ kind: "info", title: "收到图像识别请求", body: "正在准备识别，请稍候…" });
      break;
  }
}

function switchToTab(name) {
  els.tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  els.panels.forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
}

// ---------- 工具 ----------

function setStatus(text, kind) {
  els.statusbar.textContent = text;
  els.statusbar.className = kind ? `statusbar ${kind}` : "statusbar";
}

// 弹窗提示
function showNotice({ kind = "info", title, body, autoCloseMs, detailJson, extraButtons }) {
  const dlg = document.getElementById("noticeDialog");
  if (!dlg) return;
  document.getElementById("noticeTitle").textContent = title || (kind === "error" ? "错误" : "提示");
  document.getElementById("noticeBody").textContent = body || "";
  dlg.className = "notice-dialog " + kind;
  const copyBtn = document.getElementById("noticeCopyBtn");
  if (copyBtn) {
    if (detailJson) {
      copyBtn.style.display = "inline-block";
      copyBtn.dataset.detail = JSON.stringify(detailJson, null, 2);
    } else {
      copyBtn.style.display = "none";
      copyBtn.dataset.detail = "";
    }
  }
  // 渲染额外按钮（"上一条/下一条/全部已读"等）
  const extras = document.getElementById("noticeExtras");
  if (extras) {
    extras.innerHTML = "";
    if (Array.isArray(extraButtons) && extraButtons.length) {
      for (const b of extraButtons) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-secondary";
        btn.textContent = b.label;
        btn.dataset.extraId = b.id;
        // accessibility: mirror visible label to title/aria-label
        if (b.label) {
          btn.title = b.label;
          btn.setAttribute("aria-label", b.label);
        }
        extras.appendChild(btn);
      }
      extras.style.display = "";
    } else {
      extras.style.display = "none";
    }
  }
  dlg.showModal();
  if (autoCloseMs) {
    setTimeout(() => { try { dlg.close(); } catch (e) { /* dialog 已被关 */ } }, autoCloseMs);
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 把 raw error 转成人话
function friendlyError(msg) {
  const m = String(msg || "");
  if (/页面正文太短|页面正文|提取/.test(m)) return "此页面无正文可总结（试试别的文章页）";
  if (/NetworkError|Failed to fetch|TypeError: Load failed/.test(m)) return "网络不通或服务端拒绝连接";
  if (/HTTP 401|401|Unauthorized/.test(m)) return "API Key 无效或过期";
  if (/HTTP 403|403|Forbidden/.test(m)) return "无权限访问（API Key 权限不足？）";
  if (/HTTP 404|404|Not Found/.test(m)) return "模型 id 或 baseUrl 错误";
  if (/HTTP 429|429|rate/i.test(m)) return "请求太频繁，请稍后再试";
  if (/HTTP 5\d\d|500|502|503/.test(m)) return "服务端错误，请稍后重试";
  if (/timeout/i.test(m)) return "请求超时（服务端没响应）";
  return m;
}

// 复制按钮代理
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  // 找最近的带 data-raw 的祖先
  let container = btn;
  while (container && !container.dataset?.raw && container !== document.body) {
    container = container.parentElement;
  }
  const text = container?.dataset?.raw || container?.textContent || "";
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "已复制 ✓";
    setTimeout(() => { btn.textContent = "复制"; }, 1500);
  } catch (e) {
    reportWarning("sidebar:copy", e.message, { textLength: text.length });
  }
});

// ---------- 多模型对比 ----------

async function openCompareDialog() {
  const dlg = document.getElementById("compareDialog");
  const list = document.getElementById("compareModelList");
  if (!dlg || !list) return;

  if (state.providers.length === 0) {
    showNotice({ kind: "warn", title: "无模型", body: "请先在设置中添加 provider/model", autoCloseMs: 3000 });
    return;
  }

  list.innerHTML = "";
  for (const p of state.providers) {
    for (const m of (p.models || [])) {
      const label = document.createElement("label");
      label.className = "model-row";
      label.style.cssText = "display:flex; align-items:center; gap:6px; padding:4px 0;";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.value = `${p.id}|${m.id}`;
      const span = document.createElement("span");
      span.textContent = `${p.label} · ${m.label || m.id}`;
      label.appendChild(chk);
      label.appendChild(span);
      list.appendChild(label);
    }
  }
  dlg.showModal();
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "run") return;
    const selected = Array.from(list.querySelectorAll("input:checked")).map((c) => {
      const [providerId, modelId] = c.value.split("|");
      return { providerId, modelId };
    });
    if (selected.length < 2) {
      showNotice({ kind: "warn", title: "选少了", body: "请至少勾选 2 个模型", autoCloseMs: 2500 });
      return;
    }
    if (selected.length > 4) {
      showNotice({ kind: "warn", title: "选多了", body: "最多 4 个模型同时对比", autoCloseMs: 2500 });
      return;
    }
    await runCompare(selected);
  }, { once: true });
}

async function runCompare(selected) {
  const container = els.compareResults;
  if (!container) return;
  container.hidden = false;
  container.innerHTML = "";
  setBusy("summary", true);

  // 为每个选中的模型建一列
  const cols = [];
  for (const sel of selected) {
    const col = document.createElement("div");
    col.className = "compare-col";
    const headerText = `${sel.providerId} / ${sel.modelId}`;
    const header = document.createElement("div");
    header.className = "compare-col-header";
    const strong = document.createElement("strong");
    strong.textContent = headerText;
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "生成中…";
    header.appendChild(strong);
    header.appendChild(hint);
    const body = document.createElement("div");
    body.className = "compare-col-body";
    col.appendChild(header);
    col.appendChild(body);
    container.appendChild(col);
    cols.push({ ...sel, col, statusEl: hint, bodyEl: body });
  }

  // 并发跑
  await Promise.all(cols.map(async (c) => {
    const taskId = crypto.randomUUID();
    const sink = createStreamSinkSync(c.bodyEl);
    taskSinks.set(taskId, { sink, scope: "summary", meta: null, persist: false });
    sendToBackground({
      type: "run/summary",
      taskId,
      templateId: els.summaryTemplateSelect.value || undefined,
      forceProvider: c.providerId,  // 告诉 background 用哪个 provider（默认 active）
      forceModel: c.modelId,
    });
  }));
}

// 暂存当前 active provider override（在 background 跑任务时用）

// 导出当前对话为 Markdown
async function exportChatMarkdown() {
  if (chatMessages.length === 0) {
    showNotice({ kind: "warn", title: "无对话可导出", body: "当前对话为空", autoCloseMs: 2500 });
    return;
  }
  const lines = [];
  lines.push("# Sidebar AI 对话");
  lines.push("");
  lines.push(`导出时间：${new Date().toLocaleString()}`);
  lines.push(`共 ${chatMessages.length} 条消息`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const m of chatMessages) {
    const role = m.role === "user" ? "👤 用户" : m.role === "assistant" ? "🤖 AI" : `(${m.role})`;
    lines.push(`## ${role}`);
    lines.push("");
    lines.push(m.content);
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  const md = lines.join("\n");
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sidebar-ai-chat-${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
  showNotice({ kind: "success", title: "导出完成", body: `已下载 ${chatMessages.length} 条消息到 .md 文件`, autoCloseMs: 3000 });
}

// 导出历史为 Markdown（全部，按时间倒序）
async function exportHistoryMarkdown() {
  const items = await listHistory({ limit: 1000 });
  if (items.length === 0) {
    showNotice({ kind: "warn", title: "无历史可导出", body: "还没生成过总结/翻译/对话", autoCloseMs: 3000 });
    return;
  }
  const lines = [];
  lines.push("# Sidebar AI 历史记录");
  lines.push("");
  lines.push("导出时间：" + new Date().toLocaleString());
  lines.push("共 " + items.length + " 条");
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const it of items) {
    const date = new Date(it.createdAt).toLocaleString();
    const scopeMap = { summary: "总结", translate: "翻译", chat: "对话", "translate-selection": "翻译（选区）", "selection-explain": "解释（选区）" };
    const scopeLabel = scopeMap[it.scope] || it.scope;
    const status = it.status === "failed" ? " ⚠️ 失败" : "";
    lines.push("## " + scopeLabel + status + " · " + date);
    if (it.title) lines.push("**" + it.title + "**");
    if (it.url) lines.push("<" + it.url + ">");
    if (it.providerId || it.modelId) {
      lines.push("*模型：" + (it.providerId || "") + (it.modelId ? " / " + it.modelId : "") + "*");
    }
    lines.push("");
    lines.push("`");
    lines.push((it.content || "").replace(/`/g, "'''"));
    lines.push("`");
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  const md = lines.join("\n");
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sidebar-ai-history-" + Date.now() + ".md";
  a.click();
  URL.revokeObjectURL(url);
  showNotice({ kind: "success", title: "导出完成", body: "已下载 " + items.length + " 条历史到 .md 文件", autoCloseMs: 3000 });
}



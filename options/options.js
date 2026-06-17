// options/options.js
// 设置页：管理 providers / 模型 / prompt 模板 / 通用偏好 / 诊断。

import {
  loadProviders,
  saveProviders,
  loadTemplates,
  saveTemplates,
  loadSettings,
  saveSettings,
  listDiag,
  clearDiag,
  exportDiagnosticBundle,
  exportConfig,
  importConfig,
} from "../lib/storage.js";
import { BUILTIN_PROVIDER_META, instantiateProvider } from "../lib/llm-client.js";

const $ = (id) => document.getElementById(id);

// ---------- 启动 ----------

(async function init() {
  await Promise.all([renderProviders(), renderTemplates(), renderGeneral(), renderDiagnostics()]);
  bindNav();
  bindProviderDialog();
  bindTemplateDialog();
  bindGeneral();
  bindDiagnostics();
})();

// ---------- 顶部 nav ----------

// 设置变化广播给 sidebar（让主题等即时生效）
async function broadcastSettingsChanged() {
  try {
    const settings = await loadSettings();
    await browser.runtime.sendMessage({ type: "settings/changed", settings }).catch(() => {});
  } catch {}
}

function bindNav() {
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      $("tab-" + b.dataset.tab).classList.add("active");
    });
  });
}

// ---------- Provider 列表 ----------

async function renderProviders() {
  const list = $("providerList");
  list.innerHTML = "";
  const providers = await loadProviders();
  const settings = await loadSettings();

  if (providers.length === 0) {
    $("providerHint").textContent = "还没有添加任何 provider。点击右上角 + 添加 Provider。";
    return;
  }
  $("providerHint").textContent = `共 ${providers.length} 个 provider`;

  for (const p of providers) {
    const isActive = settings.activeProviderId === p.id;
    const div = document.createElement("div");
    div.className = "card-item";

    const h3 = document.createElement("h3");
    h3.textContent = p.label || "";
    if (isActive) {
      const span = document.createElement("span");
      span.className = "hint";
      span.textContent = "（当前）";
      h3.appendChild(document.createTextNode(" "));
      h3.appendChild(span);
    }

    const meta1 = document.createElement("div");
    meta1.className = "meta";
    meta1.textContent = `${p.id || ""} · ${p.baseUrl || "(默认)"} · ${(p.models || []).length} 个模型`;

    const meta2 = document.createElement("div");
    meta2.className = "meta";
    meta2.textContent = `模型：${(p.models || []).map((m) => (m.label || m.id)).join(", ") || "（无）"}`;

    const actions = document.createElement("div");
    actions.className = "actions";

    const btnEdit = document.createElement("button");
    btnEdit.type = "button";
    btnEdit.className = "ghost-btn";
    btnEdit.dataset.act = "edit";
    btnEdit.dataset.id = p.id;
    btnEdit.textContent = "编辑";

    const btnActive = document.createElement("button");
    btnActive.type = "button";
    btnActive.className = "ghost-btn";
    btnActive.dataset.act = "active";
    btnActive.dataset.id = p.id;
    btnActive.textContent = "设为当前";

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "danger-btn";
    btnDel.dataset.act = "del";
    btnDel.dataset.id = p.id;
    btnDel.textContent = "删除";

    [btnEdit, btnActive, btnDel].forEach((b) => b.addEventListener("click", () => onProviderAction(b.dataset.act, b.dataset.id)));

    actions.appendChild(btnEdit);
    actions.appendChild(btnActive);
    actions.appendChild(btnDel);

    div.appendChild(h3);
    div.appendChild(meta1);
    div.appendChild(meta2);
    div.appendChild(actions);
    list.appendChild(div);
  }
}

async function onProviderAction(act, id) {
  if (act === "edit") {
    openProviderDialog(id);
  } else if (act === "del") {
    if (!confirm("删除该 provider 及其所有模型配置？")) return;
    const providers = (await loadProviders()).filter((p) => p.id !== id);
    await saveProviders(providers);
    await renderProviders();
  } else if (act === "active") {
    const providers = await loadProviders();
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    const firstModel = (p.models || [])[0]?.id || null;
    await saveSettings({ activeProviderId: id, activeModelId: firstModel });
    await renderProviders();
  }
}

// ---------- Provider 弹窗 ----------

let editingProviderId = null;
let dialogModels = [];          // [{ id, label, contextWindow, vision, tools, kind, selected, _remote }]
let lastRemoteList = [];        // 上次远端拉取的清单

function bindProviderDialog() {
  const sel = $("providerBuiltinSelect");
  sel.innerHTML = "";
  for (const m of BUILTIN_PROVIDER_META) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.label;
    sel.appendChild(o);
  }
  // 跟踪用户是否手动改过 baseUrl，避免误覆盖
  let baseUrlTouched = false;
  sel.addEventListener("change", () => {
    const m = BUILTIN_PROVIDER_META.find((x) => x.id === sel.value);
    // 切类型时，如果用户没手动改过 baseUrl，就用对应类型的默认值覆盖
    if (m?.defaultBaseUrl && !baseUrlTouched) {
      $("providerForm").baseUrl.value = m.defaultBaseUrl;
    }
    // 切类型时清空旧的远端列表
    lastRemoteList = [];
    $("fetchHint").textContent = "";
    $("fetchHint").className = "hint";
    updateBulkButtons();
  });
  // 用户手动改 baseUrl 就标记，后续切类型不会覆盖
  $("providerForm").baseUrl.addEventListener("input", () => {
    baseUrlTouched = true;
  });

  $("addProviderBtn").addEventListener("click", async () => {
    await refreshGroupDatalist();
    openProviderDialog(null);
  });
  $("addModelBtn").addEventListener("click", () => {
    dialogModels.push({
      id: "", label: "", contextWindow: 8192, vision: false, tools: false, kind: "chat", selected: true, _remote: false,
    });
    renderDialogModels();
  });

  // 🔍 获取模型列表（核心新增）
  $("fetchModelsBtn").addEventListener("click", fetchRemoteModels);
  $("selectAllModelsBtn").addEventListener("click", () => toggleAllRemote(true));
  $("deselectAllModelsBtn").addEventListener("click", () => toggleAllRemote(false));

  $("providerForm").addEventListener("submit", async (e) => {
    const action = e.submitter?.value;
    if (action !== "save") return;
    e.preventDefault();
    const fd = new FormData($("providerForm"));
    const baseUrl = (fd.get("baseUrl") || "").toString().trim();
    const apiKey = (fd.get("apiKey") || "").toString().trim();
    const label = (fd.get("label") || "").toString().trim();
    const group = (fd.get("group") || "").toString().trim();
    const builtinId = fd.get("builtinId").toString();
    const id = editingProviderId || `p-${crypto.randomUUID().slice(0, 8)}`;
    // 保存：只保留 selected 的（远端拉取的会让用户勾选；手动添加的 selected 默认 true）
    const cleanedModels = dialogModels
      .filter((m) => m.id && m.id.trim() && m.selected !== false)
      .map((m) => ({
        id: m.id.trim(),
        label: (m.label || m.id).trim(),
        contextWindow: Number(m.contextWindow) || 8192,
        vision: !!m.vision,
        tools: !!m.tools,
      }));

    const cfg = { id, builtinId, label, baseUrl, apiKey, group, models: cleanedModels };
    const providers = await loadProviders();
    const idx = providers.findIndex((p) => p.id === id);
    if (idx >= 0) providers[idx] = cfg;
    else providers.push(cfg);
    await saveProviders(providers);

    const settings = await loadSettings();
    if (!settings.activeProviderId) {
      await saveSettings({ activeProviderId: id, activeModelId: cleanedModels[0]?.id || null });
    }

    $("providerDialog").close();
    await renderProviders();
  });
}

async function fetchRemoteModels() {
  const form = $("providerForm");
  const builtinId = form.builtinId.value;
  const baseUrl = (form.baseUrl.value || "").trim();
  const apiKey = (form.apiKey.value || "").trim();

  const btn = $("fetchModelsBtn");
  const hint = $("fetchHint");

  // 校验
  if (!baseUrl) {
    hint.textContent = "❌ 请先填写 Base URL";
    hint.className = "hint error";
    return;
  }
  if (!apiKey && builtinId !== "ollama") {
    hint.textContent = "❌ 请先填写 API Key";
    hint.className = "hint error";
    return;
  }

  // URL 形态检查
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`Base URL 协议必须是 http(s)，当前是 ${u.protocol}`);
    }
  } catch (e) {
    hint.textContent = `❌ Base URL 格式不对：${e.message}`;
    hint.className = "hint error";
    return;
  }

  btn.classList.add("loading");
  btn.disabled = true;
  btn.querySelector(".btn-label").textContent = "⏳ 正在获取…";
  hint.textContent = "正在请求…";
  hint.className = "hint";

  try {
    const tmp = instantiateProvider({
      id: builtinId,
      baseUrl,
      apiKey,
      models: [],
    });
    if (!tmp.listRemoteModels) {
      throw new Error("当前 provider 类型不支持拉取模型列表");
    }
    const remote = await tmp.listRemoteModels();

    const annotated = remote.map((m) => ({
      ...m,
      selected: m.kind === "chat" || m.kind === "vision",
      _remote: true,
    }));

    lastRemoteList = annotated;

    const manualOnes = dialogModels.filter((m) => !m._remote);
    dialogModels = [...annotated, ...manualOnes];

    renderDialogModels();

    const chatCount = annotated.filter((m) => m.selected).length;
    const total = annotated.length;
    hint.textContent = `✓ 拉到 ${total} 个模型，已勾选 ${chatCount} 个 chat 类`;
    hint.className = "hint success";

    updateBulkButtons();
  } catch (err) {
    // 关键：把 fetch 的网络错误翻译成人话，并上报到 error-reporter
    try { const { reportError } = await import('../lib/error-reporter.js'); reportError('options:fetchRemoteModels', err, { context: { builtinId, baseUrl } }); } catch {}
    const diagnosis = diagnoseFetchError(err, builtinId, baseUrl);
    // diagnosis 可能包含用户/远端文本，若仅需显示文本使用 textContent
    hint.textContent = diagnosis;
    hint.className = "hint error";
    try { console.error("[sidebar-ai] fetchRemoteModels error:", err); } catch {}
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
    btn.querySelector(".btn-label").textContent = "🔍 从服务端获取模型列表";
  }
}

function diagnoseFetchError(err, builtinId, baseUrl) {
  const msg = String(err?.message || err);
  const isNetwork = /NetworkError|Failed to fetch|TypeError: Load failed|network/i.test(msg);

  if (!isNetwork) {
    return `❌ ${escape(msg)}`;
  }

  // 浏览器原生 fetch 抛的 TypeError 是这样："TypeError: Failed to fetch" / "NetworkError"
  // 这种情况几乎都是 CORS 或 DNS / 协议 / 离线。
  const lines = [];
  lines.push(`❌ 网络错误：浏览器拿不到 ${escape(baseUrl)} 的响应。`);
  lines.push(`最可能的几个原因：`);
  lines.push(`1. CORS 限制（最常见）：options 页面是普通网页上下文，浏览器同源策略会拦截。官方 OpenAI/DeepSeek/Kimi/通义 都允许浏览器跨域调用，但自定义/私有部署端点通常需要服务端返回 Access-Control-Allow-Origin: *。`);

  if (builtinId === "anthropic" || builtinId === "gemini") {
    lines.push(`${escape(builtinId)} 官方 API 不允许浏览器直接调用，需要反向代理或后端中转。`);
  }
  if (builtinId === "ollama") {
    lines.push(`Ollama 需本地服务在跑：先在终端跑 ollama serve，确认 http://127.0.0.1:11434/api/tags 能访问。`);
  }
  lines.push(`URL 拼错（协议不是 http/https、域名拼错、缺路径前缀）。`);
  lines.push(`本机网络/代理问题：可以先在终端跑：curl -s ${escape(baseUrl)}/models -H "Authorization: Bearer ***" 看能不能通。`);

  lines.push(`绕过方法：跳过自动获取，直接点 "+ 手动添加模型" 按 id 输入（id 可去服务商文档查，例如 DeepSeek 就是 deepseek-chat、deepseek-reasoner）。`);
  return lines.join("");
}

function toggleAllRemote(selectAll) {
  for (const m of dialogModels) {
    if (m._remote) m.selected = selectAll;
  }
  renderDialogModels();
}

function updateBulkButtons() {
  const has = lastRemoteList.length > 0;
  $("selectAllModelsBtn").classList.toggle("hidden", !has);
  $("deselectAllModelsBtn").classList.toggle("hidden", !has);
}

async function openProviderDialog(id) {
  editingProviderId = id;
  dialogModels = [];
  lastRemoteList = [];
  const form = $("providerForm");
  form.reset();

  $("providerDialogTitle").textContent = id ? "编辑 Provider" : "添加 Provider";
  $("fetchHint").textContent = "";
  $("fetchHint").className = "hint";
  updateBulkButtons();

  if (id) {
    const providers = await loadProviders();
    const p = providers.find((x) => x.id === id);
    if (p) {
      form.builtinId.value = p.builtinId || p.id;
      form.label.value = p.label || "";
      form.baseUrl.value = p.baseUrl || "";
      form.apiKey.value = p.apiKey || "";
      form.group.value = p.group || "";
      dialogModels = (p.models || []).map((m) => ({ ...m, selected: true, _remote: false }));
    }
  } else {
    // 新增：默认选 DeepSeek（国内用户首选），自动填对应 baseUrl
    // 想用 OpenAI / Gemini / Anthropic 之类的，从下拉里切即可
    const DEFAULT_NEW = "deepseek";
    const m = BUILTIN_PROVIDER_META.find((x) => x.id === DEFAULT_NEW) || BUILTIN_PROVIDER_META[0];
    form.builtinId.value = m.id;
    form.baseUrl.value = m.defaultBaseUrl || "";
  }

  $("providerDialog").showModal();
  renderDialogModels();
}

function renderDialogModels() {
  const wrap = $("providerModels");
  wrap.innerHTML = "";
  let selectedCount = 0;

  dialogModels.forEach((m, i) => {
    if (m.selected !== false) selectedCount++;

    const row = document.createElement("div");
    row.className = "model-row";

    // 远端拉取的：显示勾选框 + 能力 tag
    // 手动添加的：跟之前一样可编辑
    if (m._remote) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      if (m.selected) checkbox.checked = true;
      checkbox.dataset.k = "selected";
      checkbox.title = "勾选才会保存";
      checkbox.addEventListener("change", (e) => {
        dialogModels[i].selected = e.target.checked;
        $("modelCountHint").textContent = `（${dialogModels.filter((x) => x.selected !== false).length}/${dialogModels.length} 选中）`;
      });

      const nameSpan = document.createElement("span");
      nameSpan.className = "name";
      nameSpan.title = m.id || "";
      nameSpan.textContent = m.id || "";

      const tagsContainer = document.createElement("span");
      // build capability tags
      const addTag = (txt, cls) => {
        const s = document.createElement("span");
        s.className = `cap-tag${cls ? " " + cls : ""}`;
        s.textContent = txt;
        tagsContainer.appendChild(s);
      };
      if (m.kind === "embed") addTag("embed", "embed");
      else if (m.kind === "image") addTag("image");
      else if (m.kind === "audio") addTag("audio");
      else if (m.kind === "rerank") addTag("rerank");
      else if (m.kind === "vision" || m.vision) addTag("vision", "vision");
      else addTag("chat", "chat");
      if (m.tools) addTag("tools", "tools");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost-btn";
      btn.dataset.del = String(i);
      btn.title = "从列表移除";
      btn.setAttribute("aria-label", "从列表移除");
      btn.textContent = "删";
      btn.addEventListener("click", () => {
        const removed = dialogModels[i];
        dialogModels.splice(i, 1);
        if (removed._remote) {
          lastRemoteList = lastRemoteList.filter((x) => x.id !== removed.id);
          updateBulkButtons();
        }
        renderDialogModels();
      });

      row.appendChild(checkbox);
      row.appendChild(nameSpan);
      row.appendChild(tagsContainer);
      row.appendChild(btn);
    } else {
      const idInput = document.createElement("input");
      idInput.type = "text";
      idInput.placeholder = "model id (如 gpt-4o-mini)";
      idInput.value = m.id || "";
      idInput.dataset.k = "id";
      idInput.className = "name";
      idInput.addEventListener("input", () => { dialogModels[i].id = idInput.value; });

      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.placeholder = "显示名";
      labelInput.value = m.label || "";
      labelInput.dataset.k = "label";
      labelInput.className = "label-input";
      labelInput.addEventListener("input", () => { dialogModels[i].label = labelInput.value; });

      const ctxInput = document.createElement("input");
      ctxInput.type = "number";
      ctxInput.placeholder = "context";
      ctxInput.value = m.contextWindow || 8192;
      ctxInput.dataset.k = "contextWindow";
      ctxInput.className = "mini";
      ctxInput.addEventListener("input", () => { dialogModels[i].contextWindow = Number(ctxInput.value) || 8192; });

      const lblVision = document.createElement("label");
      lblVision.title = "支持图像";
      const chkVision = document.createElement("input");
      chkVision.type = "checkbox";
      chkVision.dataset.k = "vision";
      if (m.vision) chkVision.checked = true;
      chkVision.addEventListener("change", () => { dialogModels[i].vision = chkVision.checked; });
      lblVision.appendChild(chkVision);
      lblVision.appendChild(document.createTextNode(" 👁"));

      const lblTools = document.createElement("label");
      lblTools.title = "支持 tools";
      const chkTools = document.createElement("input");
      chkTools.type = "checkbox";
      chkTools.dataset.k = "tools";
      if (m.tools) chkTools.checked = true;
      chkTools.addEventListener("change", () => { dialogModels[i].tools = chkTools.checked; });
      lblTools.appendChild(chkTools);
      lblTools.appendChild(document.createTextNode(" 🛠"));

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ghost-btn";
      delBtn.dataset.del = String(i);
      delBtn.title = "删除";
      delBtn.setAttribute("aria-label", "删除");
      delBtn.textContent = "删";
      delBtn.addEventListener("click", () => {
        const removed = dialogModels[i];
        dialogModels.splice(i, 1);
        renderDialogModels();
      });

      row.appendChild(idInput);
      row.appendChild(labelInput);
      row.appendChild(ctxInput);
      row.appendChild(lblVision);
      row.appendChild(lblTools);
      row.appendChild(delBtn);
    }

    row.querySelector("[data-del]").addEventListener("click", () => {
      const removed = dialogModels[i];
      dialogModels.splice(i, 1);
      if (removed._remote) {
        lastRemoteList = lastRemoteList.filter((x) => x.id !== removed.id);
        updateBulkButtons();
      }
      renderDialogModels();
    });
    wrap.appendChild(row);
  });

  $("modelCountHint").textContent = dialogModels.length
    ? `（${selectedCount}/${dialogModels.length} 选中）`
    : "";
}

// ---------- Prompt 模板 ----------

async function renderTemplates() {
  const list = $("templateList");
  list.innerHTML = "";
  const templates = await loadTemplates();
  for (const t of templates) {
    const div = document.createElement("div");
    div.className = "card-item";

    const h3 = document.createElement("h3");
    h3.textContent = t.name || "";
    if (t.builtin) {
      const span = document.createElement("span");
      span.className = "hint";
      span.textContent = "（内置）";
      h3.appendChild(document.createTextNode(" "));
      h3.appendChild(span);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `作用域：${t.scope || ""}`;

    const ta = document.createElement("textarea");
    ta.readOnly = true;
    ta.textContent = t.content || "";

    const actions = document.createElement("div");
    actions.className = "actions";

    const btnEdit = document.createElement("button");
    btnEdit.type = "button";
    btnEdit.className = "ghost-btn";
    btnEdit.dataset.act = "edit";
    btnEdit.dataset.id = t.id;
    btnEdit.textContent = "编辑";
    btnEdit.addEventListener("click", () => onTemplateAction(btnEdit.dataset.act, btnEdit.dataset.id));
    actions.appendChild(btnEdit);

    if (!t.builtin) {
      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "danger-btn";
      btnDel.dataset.act = "del";
      btnDel.dataset.id = t.id;
      btnDel.textContent = "删除";
      btnDel.addEventListener("click", () => onTemplateAction(btnDel.dataset.act, btnDel.dataset.id));
      actions.appendChild(btnDel);
    }

    div.appendChild(h3);
    div.appendChild(meta);
    div.appendChild(ta);
    div.appendChild(actions);
    list.appendChild(div);
  }
}

async function onTemplateAction(act, id) {
  if (act === "edit") {
    openTemplateDialog(id);
  } else if (act === "del") {
    if (!confirm("删除该模板？")) return;
    const templates = (await loadTemplates()).filter((t) => t.id !== id);
    await saveTemplates(templates);
    await renderTemplates();
  }
}

function bindTemplateDialog() {
  $("addTemplateBtn").addEventListener("click", () => openTemplateDialog(null));
  $("templateForm").addEventListener("submit", async (e) => {
    const action = e.submitter?.value;
    if (action !== "save") return;
    e.preventDefault();
    const fd = new FormData($("templateForm"));
    const id = (fd.get("id") || `tpl-${crypto.randomUUID().slice(0, 8)}`).toString();
    const t = {
      id,
      name: fd.get("name").toString().trim(),
      scope: fd.get("scope").toString(),
      content: fd.get("content").toString(),
      builtin: false,
    };
    const templates = await loadTemplates();
    const idx = templates.findIndex((x) => x.id === id);
    if (idx >= 0) templates[idx] = { ...templates[idx], ...t };
    else templates.push(t);
    await saveTemplates(templates);
    $("templateDialog").close();
    await renderTemplates();
  });
}

async function openTemplateDialog(id) {
  const form = $("templateForm");
  form.reset();
  if (id) {
    const templates = await loadTemplates();
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    form.id.value = t.id;
    form.name.value = t.name;
    form.scope.value = t.scope;
    form.content.value = t.content;
  } else {
    form.id.value = "";
  }
  $("templateDialog").showModal();
}

// ---------- 通用 ----------

async function renderGeneral() {
  const settings = await loadSettings();
  $("generalLang").value = settings.targetLang || "zh-CN";
  $("generalLength").value = settings.summaryLength || "medium";
  $("generalStreaming").value = settings.streaming ? "true" : "false";
  $("generalTheme").value = settings.theme || "system";
  $("autoSummarizeDomains").value = (settings.autoSummarizeDomains || []).join("\n");
  $("visionDefaultMode").value = settings.visionDefaultMode || "ask";
  $("visionRememberConsent").checked = !!settings.visionRememberConsent;
}

function bindGeneral() {
  $("generalLang").addEventListener("change", async (e) => {
    await saveSettings({ targetLang: e.target.value });
    await broadcastSettingsChanged();
  });
  $("generalLength").addEventListener("change", async (e) => {
    await saveSettings({ summaryLength: e.target.value });
    await broadcastSettingsChanged();
  });
  $("generalStreaming").addEventListener("change", async (e) => {
    await saveSettings({ streaming: e.target.value === "true" });
    await broadcastSettingsChanged();
  });
  $("generalTheme").addEventListener("change", async (e) => {
    await saveSettings({ theme: e.target.value });
    await broadcastSettingsChanged();
  });
  $("autoSummarizeDomains").addEventListener("input", async (e) => {
    const domains = e.target.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    await saveSettings({ autoSummarizeDomains: domains });
    await broadcastSettingsChanged();
  });

  // vision privacy settings
  $("visionDefaultMode").addEventListener("change", async (e) => {
    await saveSettings({ visionDefaultMode: e.target.value });
    await broadcastSettingsChanged();
  });
  $("visionRememberConsent").addEventListener("change", async (e) => {
    await saveSettings({ visionRememberConsent: !!e.target.checked });
    await broadcastSettingsChanged();
  });

  // 配置导入导出
  $("exportConfigBtn")?.addEventListener("click", async () => {
    try {
      const bundle = await exportConfig();
      const json = JSON.stringify(bundle, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sidebar-ai-config-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      alert(`已导出配置（${bundle.providers.length} 个 provider，${bundle.templates.length} 个模板）\n\n注意：API Key 已脱敏，导入后需重新填。`);
    } catch (e) {
      alert("导出失败：" + e.message);
    }
  });
  $("importConfigBtn")?.addEventListener("click", () => {
    $("importConfigInput")?.click();
  });
  $("importConfigInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const mode = confirm("点击「确定」= 合并（推荐，保留现有数据），\n点击「取消」= 替换（清空现有所有配置）") ? "merge" : "replace";
      const report = await importConfig(bundle, mode);
      alert(
        `导入完成！\n\n` +
        `设置：${report.settings ? "✓" : "—"}\n` +
        `Provider：+${report.providersAdded} 新增，${report.providersSkipped} 跳过（id 重复）\n` +
        `模板：+${report.templatesAdded} 新增，${report.templatesSkipped} 跳过\n\n` +
        `⚠️ API Key 已脱敏，请到「模型」tab 重新填。`
      );
      // 刷新所有 tab
      await renderProviders();
      await renderTemplates();
      await renderGeneral();
    } catch (err) {
      alert("导入失败：" + err.message);
    } finally {
      e.target.value = ""; // 允许重选同一文件
    }
  });
}

// ---------- utils ----------

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- 诊断 ----------

async function renderDiagnostics() {
  const levels = [];
  if ($("diagFilterError")?.checked) levels.push("error");
  if ($("diagFilterWarn")?.checked) levels.push("warn");
  if ($("diagFilterInfo")?.checked) levels.push("info");
  const scopeQuery = $("diagFilterScope")?.value?.trim() || "";

  // 一次拉全部，前端过滤（最多 200 条）
  const items = await listDiag({ limit: 200 });
  let filtered = levels.length ? items.filter((d) => levels.includes(d.level)) : items;
  if (scopeQuery) {
    // 支持正则（用户填 `/^summary/` 这种）
    let matcher;
    try {
      const m = scopeQuery.match(/^\/(.+)\/$/);
      matcher = m ? new RegExp(m[1]) : new RegExp(scopeQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch {
      matcher = new RegExp("^$"); // 不匹配任何
    }
    filtered = filtered.filter((d) => matcher.test(d.scope || ""));
  }
  const list = $("diagList");
  list.innerHTML = "";
  $("diagHint").textContent = `共 ${items.length} 条（显示 ${filtered.length} 条）`;

  if (filtered.length === 0) {
    const li = document.createElement("li");
    li.className = "diag-item info";
    const sum = document.createElement("div");
    sum.className = "diag-summary";
    sum.textContent = "暂无诊断记录";
    const det = document.createElement("div");
    det.className = "diag-details";
    det.textContent = "只有任务失败 / 警告 / 关键事件才会写诊断。如果扩展从来没报错，这里就是空的。";
    li.appendChild(sum);
    li.appendChild(det);
    list.appendChild(li);
    return;
  }

  for (const d of filtered) {
    const li = document.createElement("li");
    li.className = "diag-item " + d.level;
    const date = new Date(d.createdAt).toLocaleString();
    const meta = document.createElement("div");
    meta.className = "diag-meta";
    const span1 = document.createElement("span");
    span1.textContent = `[${d.level}] ${d.scope || ""}`;
    const span2 = document.createElement("span");
    span2.textContent = date;
    meta.appendChild(span1);
    meta.appendChild(span2);
    const sum = document.createElement("div");
    sum.className = "diag-summary";
    sum.textContent = d.summary || "";
    li.appendChild(meta);
    li.appendChild(sum);
    if (d.details) {
      const pre = document.createElement("pre");
      pre.className = "diag-details";
      pre.textContent = JSON.stringify(d.details, null, 2);
      li.appendChild(pre);
    }
    list.appendChild(li);
  }
}

function bindDiagnostics() {
  $("diagRefreshBtn")?.addEventListener("click", renderDiagnostics);
  $("diagFilterError")?.addEventListener("change", renderDiagnostics);
  $("diagFilterWarn")?.addEventListener("change", renderDiagnostics);
  $("diagFilterInfo")?.addEventListener("change", renderDiagnostics);
  let _scopeT;
  $("diagFilterScope")?.addEventListener("input", () => {
    clearTimeout(_scopeT);
    _scopeT = setTimeout(renderDiagnostics, 200);
  });
  $("diagClearBtn")?.addEventListener("click", async () => {
    if (!confirm("清空全部诊断日志？")) return;
    await clearDiag();
    try {
      const { clearDedupeCache } = await import("../lib/error-reporter.js");
      try { clearDedupeCache(); } catch (e) { try { const { reportWarning } = await import('../lib/error-reporter.js'); reportWarning('options:clearDiag', e.message, {}); } catch {} }
    } catch {}
    await renderDiagnostics();
  });
  $("diagTestBtn")?.addEventListener("click", async () => {
    // 触发 4 种典型错误，验证整条上报链路
    try {
      const { reportError, reportWarning, reportInfo } = await import("../lib/error-reporter.js");
      await reportInfo("test:button", "这是一条 info 级别测试消息", { test: true });
      await reportWarning("test:button", "这是一条 warn 级别测试消息", { test: true });
      await reportError("test:button", new Error("HTTP 401 Unauthorized - API key 无效"), { test: true });
      await reportError("test:button", new TypeError("Failed to fetch (网络层)"), { test: true });
      alert("已触发 4 条测试错误。请到 sidebar 顶部的红色徽章查看弹窗（模拟 network 错误 + 401 错误，看分类提示对不对）。");
      await renderDiagnostics();
    } catch (e) {
      try { const { reportError } = await import('../lib/error-reporter.js'); reportError('options:diagTest', e); } catch {}
      alert("测试出错：" + e.message);
    }
  });
  $("diagExportBtn")?.addEventListener("click", async () => {
    const bundle = await exportDiagnosticBundle();
    const json = JSON.stringify(bundle, null, 2);
    try {
      await navigator.clipboard.writeText(json);
    } catch {}
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sidebar-ai-diag-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    alert("诊断包已下载，并复制到剪贴板。\n\n把 JSON 内容直接发给我（贴聊天框就行），我就能看到你的完整配置和最近的错误日志。");
  });
  $("diagCopyAllBtn")?.addEventListener("click", async () => {
    const levels = [];
    if ($("diagFilterError")?.checked) levels.push("error");
    if ($("diagFilterWarn")?.checked) levels.push("warn");
    if ($("diagFilterInfo")?.checked) levels.push("info");
    const items = (await listDiag({ limit: 200 })).filter((d) => !levels.length || levels.includes(d.level));
    const text = items.map((d) => {
      const date = new Date(d.createdAt).toISOString();
      const details = d.details ? JSON.stringify(d.details) : "";
      return `[${date}] [${d.level}] [${d.scope}] ${d.summary}\n${details}\n---`;
    }).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      alert(`已复制 ${items.length} 条到剪贴板`);
    } catch (e) {
      try { const { reportWarning } = await import('../lib/error-reporter.js'); reportWarning('options:diagCopy', e.message, {}); } catch {}
      alert("复制失败：" + e.message);
    }
  });
}

// 刷新 provider 分组 datalist
async function refreshGroupDatalist() {
  const settings = await loadSettings();
  const groups = settings.modelGroups || [];
  const list = groupOptions;
  if (!list) return;
  list.innerHTML = "";
  for (const g of groups) {
    const o = document.createElement("option");
    o.value = g;
    list.appendChild(o);
  }
}

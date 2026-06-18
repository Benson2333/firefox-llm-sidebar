// background/background.js
// 后台中枢：
//   - 接收 sidebar / 快捷键 发来的请求
//   - 通过 executeScript 在目标页运行 extractor（DOMParser 在 background 里没有）
//   - 调 lib/llm-client.js 发起流式调用
//   - 通过 port 把 token chunk 推回 sidebar
//   - 历史写入由 sidebar 端做（background event page 没有 indexedDB）

import {
  getActiveModelInfo,
  buildMessagesFromTemplate,
  streamChat,
  oneShotChat,
  visionSendImage,
  supportsCapability,
  instantiateProvider,
} from "../lib/llm-client.js";
import { loadSettings, loadProviders, addDiag } from "../lib/storage.js";
import { reportError, reportWarning, installGlobalHandlers, setPortBroadcaster } from "../lib/error-reporter.js";

// ---------- 设置端口广播器（让 error-reporter 能推送错误到 sidebar）----------

setPortBroadcaster((payload) => {
  for (const entry of ports.values()) {
    try { entry.port.postMessage(payload); }
    catch (e) { reportWarning("background:port-broadcast", e.message, { error: e.name }); }
  }
});

// 安装全局错误处理（捕获 background 上下文里未捕获的异常）
installGlobalHandlers();

// ---------- 辅助：按指定 id 解析 model info ----------

async function resolveModelInfo(msg) {
  if (msg?.forceProvider && msg?.forceModel) {
    const providers = await loadProviders();
    const cfg = providers.find((p) => p.id === msg.forceProvider);
    if (cfg) {
      const model = (cfg.models || []).find((m) => m.id === msg.forceModel);
      if (model) {
        return { provider: instantiateProvider(cfg), model, providerCfg: cfg };
      }
    }
  }
  return await getActiveModelInfo();
}

// ---------- 长连接（sidebar ↔ background）----------

const ports = new Map(); // portId -> port

// 内存缓存最近的设置，便于快速访问（options 改动时会通过 runtime.message 广播）
let currentSettings = null;

// 接收来自 options 页的设置变更广播，立即更新内存缓存
browser.runtime.onMessage?.addListener?.((msg) => {
  try {
    if (msg?.type === "settings/changed" && msg.settings) {
      currentSettings = msg.settings;
      console.log('[background] received settings/changed', { keys: Object.keys(msg.settings) });
      // 广播到当前已连接的 sidebar ports
      for (const [pid, entry] of ports.entries()) {
        try { entry.port.postMessage({ type: "settings/changed", settings: currentSettings }); } catch (e) { reportWarning("background:settings-broadcast", e.message, { pid }); }
      }
    }
  } catch (e) {
    console.warn('[background] settings/changed handler error', e);
    try { reportError('background:settings-handler', e); } catch {}
  }
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidebar-ai") return;
  const id = crypto.randomUUID();
  ports.set(id, { port, lastSeen: Date.now(), helloAcked: false });
  try { port.postMessage({ type: "hello", portId: id }); } catch (e) { reportWarning('background:port-hello', e.message, { id }); }
  if (currentSettings) {
    try { port.postMessage({ type: "settings/changed", settings: currentSettings }); } catch (e) { reportWarning("background:settings-initial", e.message, { id }); }
  }

  port.onDisconnect.addListener(() => {
    ports.delete(id);
    console.log("[sidebar-ai] port disconnected", id);
  });
  port.onMessage.addListener((msg) => {
    const entry = ports.get(id);
    if (entry) entry.lastSeen = Date.now();
    if (msg?.type === "hello-ack") {
      if (entry) entry.helloAcked = true;
      return;
    }
    if (msg?.type === "pong") return; // 心跳响应
    if (msg?.type === "keepalive") {
      // sidebar 主动保活心跳
      return;
    }
    handlePortMessage(port, msg);
  });
});

// 心跳：每 30 秒检查所有 port，60 秒没活动就主动关闭
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of ports.entries()) {
      if (now - entry.lastSeen > 60000) {
        console.warn("[sidebar-ai] port idle > 60s, closing", id);
        try { entry.port.disconnect(); }
        catch (e) { try { reportWarning("background:idle-close", "port.disconnect failed", { id, error: e.message }); } catch {} }
        ports.delete(id);
      }
  }
}, 30000);

async function handlePortMessage(port, msg) {
  try {
    switch (msg?.type) {
      case "run/summary":
        return await runTask(port, msg, "summary");
      case "run/translate":
        return await runTask(port, msg, "translate");
      case "run/chat":
        return await runChat(port, msg);
      case "run/selection":
        return await runSelection(port, msg);
      case "run/vision-image":
        return await runVisionImage(port, msg);
      case "ping":
        return port.postMessage({ type: "pong", ts: Date.now() });
      default:
        port.postMessage({ type: "error", error: `unknown msg type: ${msg?.type}` });
    }
  } catch (err) {
      console.error("[sidebar-ai] handlePortMessage error:", err);
      try { reportError('background:handlePortMessage', err, { msgType: msg?.type, taskId: msg?.taskId }); } catch {}
      try { port.postMessage({ type: "error", taskId: msg?.taskId, error: String(err?.message || err) }); } catch (e) { try { reportWarning('background:postmessage-failed', e.message, { originalError: String(err) }); } catch {} }
  }
}

async function runVisionImage(port, msg) {
  const taskId = msg.taskId || crypto.randomUUID();
  port.postMessage({ type: "task/start", taskId, scope: "vision" });
  try {
    // basic validation
    if (!msg.imageData && !msg.imageUrl) {
      throw new Error("没有收到图片数据或 URL");
    }
    // get active model/provider
    const modelInfo = await getActiveModelInfo();
    if (!modelInfo) throw new Error("未配置 provider/model，请先在设置中添加并设为当前模型");
    if (!supportsCapability(modelInfo, "vision")) throw new Error("当前模型不支持视觉能力");

    // Try provider-specific visionSendImage first (more efficient / privacy-friendly)
    try {
      const imgDataUrl = msg.imageData ? msg.imageData : msg.imageUrl;
      let imageBlob = null;
      if (msg.imageData && msg.imageData.startsWith("data:")) {
        // convert DataURL to blob
        try {
          const res = await fetch(msg.imageData);
          imageBlob = await res.blob();
        } catch (e) {
          console.warn('[background] failed to convert data URL to blob', e);
        }
      }
      const prompt = `请基于下面的图片内容进行识别与描述：\n请返回简洁的中文描述、识别出的对象与可能的标签。`;
      const resp = await visionSendImage({ provider: modelInfo.provider, model: modelInfo.model, imageBlob, imageDataUrl: imgDataUrl, prompt, signal: undefined });
      if (resp && resp.content) {
        port.postMessage({ type: "task/done", taskId, scope: "vision", content: resp.content, usage: resp.usage || null, meta: { providerId: modelInfo.provider.id, modelId: modelInfo.model.id } });
        return;
      }
      // else fallthrough to chat fallback
    } catch (e) {
      console.warn('[background] provider.visionSendImage failed, falling back to chat DataURL method', e);
    }

    // Fallback: Construct a simple user message containing the image data (data URL) and a prompt
    const imagePayload = msg.imageData ? msg.imageData : msg.imageUrl;
    const prompt = `请基于下面的图片内容进行识别与描述：\n[IMAGE]\n${imagePayload}\n[/IMAGE]\n请返回简洁的中文描述、识别出的对象与可能的标签。`;

    // call one-shot chat (providers are expected to accept data URLs in message content for vision-enabled models)
    const response = await oneShotChat({ provider: modelInfo.provider, model: modelInfo.model, messages: [{ role: "user", content: prompt }], temperature: 0.2 });
    if (!response || !response.content) {
      port.postMessage({ type: "task/error", taskId, error: "模型未返回识别结果" });
      return;
    }
    // send done with content
    port.postMessage({ type: "task/done", taskId, scope: "vision", content: response.content, usage: response.usage || null, meta: { providerId: modelInfo.provider.id, modelId: modelInfo.model.id } });
    return;
  } catch (e) {
    try { reportError('background:runVisionImage', e, { context: { taskId } }); } catch {}
    port.postMessage({ type: "task/error", taskId, error: String(e?.message || e) });
  }
}

// ---------- 在目标页里跑 extractor ----------
// 注意：DOMParser / document 在 background event page 里都没有，
// 所以通过 executeScript 把提取逻辑注入到目标页执行。

async function extractInPage(tabId) {
  const [{ result }] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => {
      // 这段代码在目标页里跑，能访问 document 和 DOMParser
      const doc = document;

      // === 内联 extractor（与 lib/extractor.js 保持一致）===
      const title =
        doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
        doc.querySelector("title")?.textContent?.trim() ||
        doc.querySelector("h1")?.textContent?.trim() ||
        "";

      const removeSelectors = [
        "script", "style", "noscript", "iframe", "svg", "canvas",
        "nav", "header", "footer", "aside",
        "[role=navigation]", "[role=banner]", "[role=contentinfo]",
        ".advertisement", ".ad", ".ads", ".sidebar", ".comment",
        ".comments", ".share", ".related", ".recommend",
        "[aria-hidden=true]"
      ];
      // 克隆以避免污染原页 DOM
      const cloned = doc.cloneNode(true);
      for (const sel of removeSelectors) {
        cloned.querySelectorAll(sel).forEach((n) => n.remove());
      }

      const paragraphs = Array.from(cloned.querySelectorAll("p, article, section, main, div"));
      const scored = paragraphs
        .map((el) => {
          const text = (el.textContent || "").trim();
          if (text.length < 40) return null;
          const tagDensity = el.getElementsByTagName("*").length || 1;
          const density = text.length / tagDensity;
          const links = el.querySelectorAll("a").length;
          const linkDensity = links / Math.max(1, text.length / 50);
          return { score: density * (1 - Math.min(0.9, linkDensity)), text };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      let text = scored.map((s) => s.text).join("\n\n").trim();
      if (text.length < 200) {
        text = (cloned.body?.textContent || "").trim();
      }
      text = text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");

      const MAX_CHARS = 24000;
      const truncated = text.length > MAX_CHARS;
      if (truncated) text = text.slice(0, MAX_CHARS) + "\n\n[...内容已截断...]";

      return {
        title,
        text,
        excerpt: text.slice(0, 240).replace(/\s+/g, " ").trim(),
        length: text.length,
        truncated,
      };
    },
    // 不需要 world，默认就是 ISOLATED，足够
  });
  return result;
}

// ---------- 抓取活动标签 + 提取 ----------

async function fetchActiveTabAndExtract() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("没有活动标签");
  if (!tab.url || tab.url.startsWith("about:") || tab.url.startsWith("moz-extension:")) {
    throw new Error("此页面无法提取内容");
  }
  
  // 检测本地文件和PDF
  const isFileUrl = tab.url.startsWith("file://");
  const isPdf = tab.url.toLowerCase().endsWith(".pdf");
  
  try {
    // 先尝试常规提取
    const extracted = await extractInPage(tab.id);
    if (extracted && extracted.text && extracted.text.length >= 20) {
      return { extracted, tab };
    }
  } catch (e) {
    // 如果常规提取失败，尝试备用方案
    console.warn("[sidebar-ai] 常规提取失败，尝试备用方案", e);
  }
  
  // 备用方案：对于本地文件和PDF等特殊页面
  try {
    const extracted = await extractFallback(tab);
    return { extracted, tab };
  } catch (e) {
    throw new Error(`提取页面失败：${e.message || e}`);
  }
}

// ---------- 备用提取方案（处理本地文件、PDF等）----------

async function extractFallback(tab) {
  const url = tab.url;
  const isPdf = url.toLowerCase().endsWith(".pdf");
  const isFileUrl = url.startsWith("file://");
  
  // 方案1：尝试从页面获取可见文本
  try {
    const [{ result }] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // 获取页面标题
        const title =
          document.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
          document.querySelector("title")?.textContent?.trim() ||
          document.querySelector("h1")?.textContent?.trim() ||
          document.location.href.split("/").pop() ||
          "";
        
        // 对于PDF viewer，尝试获取文本内容
        let text = "";
        
        // 检查是否是PDF viewer
        if (document.querySelector('embed[type="application/pdf"]') || 
            document.querySelector('iframe[src*=".pdf"]') ||
            document.location.pathname.toLowerCase().endsWith(".pdf")) {
          
          // 尝试获取PDF viewer中的文本元素
          const pdfTextElements = document.querySelectorAll('text, .textLayer > div, [class*="text"]');
          if (pdfTextElements.length > 0) {
            text = Array.from(pdfTextElements)
              .map(el => el.textContent?.trim())
              .filter(Boolean)
              .join("\n");
          }
        }
        
        // 如果还没有文本，获取body中所有可见文本
        if (!text || text.length < 20) {
          // 移除脚本和样式
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll("script, style, noscript").forEach(n => n.remove());
          text = clone.textContent || "";
        }
        
        // 清理文本
        text = text
          .replace(/\s+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/[ \t]{2,}/g, " ")
          .trim();
        
        // 截断过长文本
        const MAX_CHARS = 24000;
        const truncated = text.length > MAX_CHARS;
        if (truncated) text = text.slice(0, MAX_CHARS) + "\n\n[...内容已截断...]";
        
        return {
          title,
          text,
          excerpt: text.slice(0, 240).replace(/\s+/g, " ").trim(),
          length: text.length,
          truncated,
          isFallback: true,
        };
      },
    });
    
    if (result && result.text && result.text.length >= 20) {
      return result;
    }
  } catch (e) {
    console.warn("[sidebar-ai] 备用提取方案1失败", e);
  }
  
  // 方案2：对于本地文件，至少返回文件名和URL
  const fallbackTitle = isPdf ? "PDF 文件" : 
                        isFileUrl ? "本地文件" :
                        tab.title || url.split("/").pop() || "未知";
  const fallbackText = `${fallbackTitle}\n\nURL: ${url}\n\n` +
    (isPdf ? "提示：此页面是PDF文件，当前浏览器可能限制直接访问PDF内容。" :
     isFileUrl ? "提示：此页面是本地文件，部分内容可能受浏览器安全策略限制。" :
     "提示：无法直接提取此页面的内容。");
  
  return {
    title: fallbackTitle,
    text: fallbackText,
    excerpt: fallbackText.slice(0, 240).replace(/\s+/g, " ").trim(),
    length: fallbackText.length,
    truncated: false,
    isFallback: true,
    isPdf,
    isFileUrl,
  };
}

// ---------- 主任务流程：summary / translate ----------

async function runTask(port, msg, scope) {
  const taskId = msg.taskId || crypto.randomUUID();
  port.postMessage({ type: "task/start", taskId, scope });

  let extracted, tab;
  try {
    ({ extracted, tab } = await fetchActiveTabAndExtract());
  } catch (e) {
    const errMsg = e.message || String(e);
    addDiag({
      level: "error",
      scope,
      summary: `提取页面失败：${errMsg}`,
      details: { taskId, errorName: e.name, errorStack: e.stack?.split("\n").slice(0, 5).join("\n") },
    });
    try { reportError('background:runTask:extract', e, { context: { taskId, scope } }); } catch {}
    port.postMessage({ type: "task/error", taskId, error: errMsg });
    return;
  }
  if (!extracted || !extracted.text || extracted.text.length < 20) {
    port.postMessage({ type: "task/error", taskId, error: "页面正文太短或提取失败" });
    return;
  }

  const settings = await loadSettings();
  let modelInfo;
  try {
    modelInfo = await resolveModelInfo(msg);
  } catch (e) {
    const errMsg = `加载模型配置失败：${e.message || e}`;
    addDiag({
      level: "error",
      scope,
      summary: errMsg,
      details: { taskId, errorName: e.name, errorStack: e.stack?.split("\n").slice(0, 5).join("\n") },
    });
    port.postMessage({ type: "task/error", taskId, error: errMsg });
    return;
  }
  if (!modelInfo) {
    addDiag({
      level: "warn",
      scope,
      summary: "未配置当前模型",
      details: { taskId },
    });
    port.postMessage({ type: "task/error", taskId, error: "未配置当前模型，请到设置页添加 provider/model" });
    return;
  }

  const templateId = msg.templateId
    || (scope === "translate" ? "tpl-translate-default" : "tpl-summary-default");
  const lengthMap = {
    short: "精简（3-5 个要点）",
    medium: "中等（5-8 个要点）",
    long: "详尽（10+ 要点，含子节）",
  };
  const vars = {
    title: extracted.title,
    content: extracted.text,
    targetLang: settings.targetLang || "zh-CN",
    length: lengthMap[settings.summaryLength] || lengthMap.medium,
  };

  let messages;
  try {
    messages = await buildMessagesFromTemplate(templateId, vars);
  } catch (e) {
    try { reportError('background:runTask:template', e, { context: { taskId, templateId } }); } catch {}
    port.postMessage({ type: "task/error", taskId, error: `模板错误：${e.message || e}` });
    return;
  }

  await runStream(port, taskId, {
    scope,
    provider: modelInfo.provider,
    model: modelInfo.model,
    messages,
    meta: { url: tab.url, title: extracted.title },
  });
}

async function runChat(port, msg) {
  const taskId = msg.taskId || crypto.randomUUID();
  port.postMessage({ type: "task/start", taskId, scope: "chat" });

  let modelInfo;
  try {
    modelInfo = await resolveModelInfo(msg);
  } catch (e) {
    port.postMessage({ type: "task/error", taskId, error: `加载模型配置失败：${e.message || e}` });
    return;
  }
  if (!modelInfo) {
    port.postMessage({ type: "task/error", taskId, error: "未配置当前模型，请到设置页添加" });
    return;
  }

  const useContext = msg.useContext !== false;
  // 新增：每次 chat 任务都持久化（user 提问 + assistant 回答），便于跨会话恢复
  const persist = msg.persist !== false;

  let messages = (msg.messages || []).slice();
  let meta = { ...(msg.meta || {}) };
  let userQuestion = "";

  if (useContext) {
    try {
      const { extracted, tab } = await fetchActiveTabAndExtract();
      if (extracted && extracted.text && extracted.text.length >= 20) {
        const pageSnippet = extracted.text.length > 12000
          ? extracted.text.slice(0, 12000) + "\n\n[...页面内容已截断...]"
          : extracted.text;
        const ctxMsg = {
          role: "system",
          content:
            `以下是用户当前正在浏览的网页内容摘要，作为回答用户问题的参考背景。` +
            `网页标题：${extracted.title || "（无标题）"}\n\n` +
            `网页正文：\n${pageSnippet}\n\n` +
            `请基于以上内容回答用户的后续问题。如果用户的问题与网页无关，可以忽略网页内容，正常回答。`,
        };
        messages = [ctxMsg, ...messages];
        meta = {
          ...meta,
          url: tab.url,
          title: extracted.title,
          domain: safeDomain(tab.url),
        };
      }
    } catch (e) {
      console.warn("[sidebar-ai] chat context extraction failed:", e.message);
    }
  }

  // 抓最后一条 user 消息作为"问题标题"，存到历史里
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userQuestion = messages[i].content || "";
      break;
    }
  }

  // 告诉 sidebar 端要持久化哪条 user 问题
  port.postMessage({ type: "task/meta", taskId, persist, userQuestion });

  await runStream(port, taskId, {
    scope: "chat",
    provider: modelInfo.provider,
    model: modelInfo.model,
    messages,
    meta,
  });
}

// 划词处理：直接拿选中内容，不抓页面
async function runSelection(port, msg) {
  const taskId = msg.taskId || crypto.randomUUID();
  const scope = msg.scope || "translate-selection";
  port.postMessage({ type: "task/start", taskId, scope });

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    try { port.postMessage({ type: "task/error", taskId, error: "没有活动标签" }); } catch (e) { try { reportWarning('background:no-active-tab', e.message, { taskId }); } catch {} }
    return;
  }
  let selection = "";
  try {
    const [{ result }] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString() || "",
    });
    selection = result;
  } catch (e) {
    try { reportError('background:runSelection:extract', e, { context: { taskId } }); } catch {}
    try { port.postMessage({ type: "task/error", taskId, error: `读取选中文本失败：${e.message || e}` }); } catch (pe) { try { reportWarning('background:postmessage-failed', pe.message, { taskId }); } catch {} }
    return;
  }
  if (!selection || selection.length < 2) {
    port.postMessage({ type: "task/error", taskId, error: "没有选中文本" });
    return;
  }
  const settings = await loadSettings();
  let modelInfo;
  try {
    modelInfo = await resolveModelInfo(msg);
  } catch (e) {
    port.postMessage({ type: "task/error", taskId, error: `加载模型配置失败：${e.message || e}` });
    return;
  }
  if (!modelInfo) {
    port.postMessage({ type: "task/error", taskId, error: "未配置当前模型" });
    return;
  }

  const messages = scope === "explain"
    ? [{
        role: "user",
        content: `请用 ${settings.targetLang || "zh-CN"} 简要解释下面这段话的含义（如果含术语或专有名词，请额外注明）：\n\n${selection}`,
      }]
    : [{
        role: "user",
        content: `请把下面这段话翻译成 ${settings.targetLang || "zh-CN"}：\n\n${selection}`,
      }];

  await runStream(port, taskId, {
    scope,
    provider: modelInfo.provider,
    model: modelInfo.model,
    messages,
    meta: { url: tab.url, title: selection.slice(0, 60) },
  });
}

// ---------- 流式核心 ----------

async function runStream(port, taskId, { scope, provider, model, messages, meta }) {
  // 读取用户偏好：默认非流式（更稳定，DeepSeek/部分国产端点流式有兼容性坑）
  const settings = await loadSettings();
  const useStreaming = !!settings.streaming;
  const wantStreaming = useStreaming && supportsCapability({ provider, model }, "streaming");

  // 任务开始时记一条 info
  addDiag({
    level: "info",
    scope,
    summary: `开始任务 ${scope}（${wantStreaming ? "流式" : "非流式"}）`,
    details: {
      taskId,
      providerId: provider.id,
      modelId: model.id,
      url: meta?.url || "",
      title: meta?.title || "",
      streaming: wantStreaming,
      messageCount: messages.length,
    },
  });

  if (!wantStreaming) {
    // 非流式分支
    try {
      const data = await oneShotChat({ provider, model, messages });
      const content = data?.content || "";
      if (!content) {
        port.postMessage({ type: "task/error", taskId, error: "模型返回了空响应（检查模型 id 是否正确）" });
        return;
      }
      port.postMessage({ type: "task/chunk", taskId, delta: content });
      port.postMessage({
        type: "task/done",
        taskId,
        content,
        scope,
        meta: {
          url: meta?.url || "",
          title: meta?.title || "",
          domain: safeDomain(meta?.url),
          providerId: provider.id,
          modelId: model.id,
        },
      });
    } catch (err) {
      port.postMessage({ type: "task/error", taskId, error: String(err?.message || err) });
    }
    return;
  }

  // 流式分支
  if (!supportsCapability({ provider, model }, "streaming")) {
    port.postMessage({ type: "task/error", taskId, error: "当前模型不支持流式输出" });
    return;
  }

  const ac = new AbortController();
  // 保存监听器引用，finally 里统一清理（避免 listener 泄漏导致 port 被 Firefox 强制断开）
  const disconnectHandler = () => ac.abort();
  port.onDisconnect.addListener(disconnectHandler);
  const abortHandler = (m) => { if (m?.type === "abort" && m?.taskId === taskId) ac.abort(); };
  port.onMessage.addListener(abortHandler);

  // Watchdog: 60 秒没收到任何 chunk 就主动报错（防止 SSE 卡死）
  const IDLE_TIMEOUT_MS = 60000;
  let watchdog = setTimeout(() => {
    ac.abort();
    try {
      port.postMessage({
        type: "task/error",
        taskId,
        error: `流式响应超时（${IDLE_TIMEOUT_MS / 1000} 秒内没有任何数据），请检查网络或模型配置`,
      });
    } catch {}
  }, IDLE_TIMEOUT_MS);
  const feedWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      ac.abort();
      try {
        port.postMessage({
          type: "task/error",
          taskId,
          error: `流式响应超时（${IDLE_TIMEOUT_MS / 1000} 秒内没有任何数据）`,
        });
      } catch {}
    }, IDLE_TIMEOUT_MS);
  };

  try {
    const stream = await streamChat({
      provider,
      model,
      messages,
      signal: ac.signal,
    });

    // 用 Promise.race 做"15 秒拿不到首 chunk 就 fallback 到非流式"
    let full = "";
    let chunkCount = 0;
    let firstChunk = false;
    const FIRST_CHUNK_TIMEOUT_MS = 15000;
    const firstChunkTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("FIRST_CHUNK_TIMEOUT")), FIRST_CHUNK_TIMEOUT_MS);
    });

    try {
      // 第一次迭代只取第一个 chunk（用 race 触发超时）
      const iter = stream[Symbol.asyncIterator]();
      const racePromise = (async () => {
        while (true) {
          const { value, done } = await iter.next();
          if (done) return null;
          if (value) return value;
        }
      })();
      const first = await Promise.race([racePromise, firstChunkTimeout]);
      if (first != null) {
        firstChunk = true;
        chunkCount++;
        full += first;
        port.postMessage({ type: "task/chunk", taskId, delta: first });
      }
      // 继续读剩余
      for await (const chunk of iter) {
        feedWatchdog();
        chunkCount++;
        full += chunk;
        port.postMessage({ type: "task/chunk", taskId, delta: chunk });
      }
    } catch (e) {
      if (e?.message === "FIRST_CHUNK_TIMEOUT") {
        console.warn("[sidebar-ai] stream first chunk timeout, fallback to non-streaming");
        // fallback: 用非流式重新调一次
        ac.abort();
        const data = await oneShotChat({
          provider,
          model,
          messages,
          signal: undefined,
        });
        const content = data?.content || "";
        if (content) {
          port.postMessage({ type: "task/chunk", taskId, delta: content });
          chunkCount = 1;
          full = content;
        }
      } else {
        throw e;
      }
    }

    clearTimeout(watchdog);

    // 防御：流式结束但零 chunk（服务端协议可能不是标准 SSE）
    if (chunkCount === 0) {
      console.warn("[sidebar-ai] stream finished but 0 chunks received, fallback to non-streaming");
      ac.abort();
      const data = await oneShotChat({
        provider,
        model,
        messages,
        signal: undefined,
      });
      const content = data?.content || "";
      if (!content) {
        throw new Error("模型返回了空响应（流式和非流式都是空）。可能是模型 id 错误或服务端问题。");
      }
      port.postMessage({ type: "task/chunk", taskId, delta: content });
      chunkCount = 1;
      full = content;
    }
    port.postMessage({
      type: "task/done",
      taskId,
      content: full,
      scope,
      usage: typeof stream.usage === "function" ? stream.usage() : null,
      meta: {
        url: meta?.url || "",
        title: meta?.title || "",
        domain: safeDomain(meta?.url),
        providerId: provider.id,
        modelId: model.id,
      },
    });
  } catch (err) {
    clearTimeout(watchdog);
    const errMsg = String(err?.message || err);
    addDiag({
      level: "error",
      scope,
      summary: `任务失败：${errMsg}`,
      details: {
        taskId,
        providerId: provider.id,
        modelId: model.id,
        url: meta?.url || "",
        title: meta?.title || "",
        streaming: wantStreaming,
        errorName: err?.name,
        errorStack: err?.stack?.split("\n").slice(0, 5).join("\n"),
        aborted: ac.signal.aborted,
      },
    });
    if (ac.signal.aborted) {
      try { port.postMessage({ type: "task/aborted", taskId }); } catch {}
    } else {
      try {
        port.postMessage({
          type: "task/error",
          taskId,
          error: errMsg,
        });
      } catch {}
    }
  } finally {
    clearTimeout(watchdog);
    try { port.onMessage.removeListener(abortHandler); } catch {}
    try { port.onDisconnect.removeListener(disconnectHandler); } catch {}
  }
}

function safeDomain(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

// ---------- 快捷键 / 命令 ----------

browser.commands?.onCommand.addListener(async (cmd) => {
  if (cmd === "summarize-page") {
    await openSidebar();
    broadcast({ type: "command", command: "summarize" });
  } else if (cmd === "translate-page") {
    await openSidebar();
    broadcast({ type: "command", command: "translate" });
  } else if (cmd === "toggle-sidebar") {
    await toggleSidebar();
  }
});

async function openSidebar() {
  try { await browser.sidebarAction.open(); }
  catch (e) { reportWarning("background:openSidebar", "open failed", { error: e.message }); }
}
async function toggleSidebar() {
  try {
    await browser.sidebarAction.open();
  } catch {}
}

function broadcast(msg) {
  for (const entry of ports.values()) {
    try { entry.port.postMessage(msg); }
    catch (e) { /* 端口已断开，下次会被 GC，忽略 */ }
  }
}

// ---------- 上下文菜单（划词）----------

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus?.create({
    id: "sidebar-ai-translate-sel",
    title: "用 Sidebar AI 翻译选中文本",
    contexts: ["selection"],
  });
  browser.contextMenus?.create({
    id: "sidebar-ai-explain-sel",
    title: "用 Sidebar AI 解释选中文本",
    contexts: ["selection"],
  });
  browser.contextMenus?.create({
    id: "sidebar-ai-vision-image",
    title: "用 Sidebar AI 识别图片",
    contexts: ["image"],
  });
});

browser.contextMenus?.onClicked.addListener(async (info, _tab) => {
  await openSidebar();
  if (info.menuItemId === "sidebar-ai-translate-sel" ||
      info.menuItemId === "sidebar-ai-explain-sel") {
    const cmd = info.menuItemId === "sidebar-ai-translate-sel" ? "selection-translate" : "selection-explain";
    for (let i = 0; i < 20; i++) {
      if (ports.size > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (ports.size === 0) {
      reportWarning("context-menu", "no sidebar port after 2s, command dropped", { cmd });
      return;
    }
    broadcast({ type: "command", command: cmd });
    return;
  }
  if (info.menuItemId === "sidebar-ai-vision-image" && info.srcUrl) {
    // 等 sidebar 连上
    for (let i = 0; i < 20; i++) {
      if (ports.size > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (ports.size === 0) {
      reportWarning("context-menu", "no sidebar port, vision dropped", { srcUrl: info.srcUrl });
      return;
    }
    // 让 sidebar 端去下载图片 + 调 vision（因为 background fetch 图片 CORS 风险大）
    broadcast({ type: "command", command: "vision-image", imageUrl: info.srcUrl });
    return;
  }
});

// ---------- 启动日志 ----------

(async () => {
  const settings = await loadSettings();
  console.log("[sidebar-ai] background ready", {
    activeProvider: settings.activeProviderId,
    activeModel: settings.activeModelId,
  });
})();

// ---------- 新标签自动总结 ----------
// 用户配置的域名列表，新加载完整页面时自动触发总结。

const _autoTriggered = new Set(); // tabId -> 是否已经为这个 tab 触发过

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // tab 开始 loading 时清掉去重记录，让用户 reload 时可以再次自动总结
  if (changeInfo.status === "loading") {
    _autoTriggered.delete(tabId);
    return;
  }
  if (changeInfo.status !== "complete") return;
  if (!tab.url || tab.url.startsWith("about:") || tab.url.startsWith("moz-extension:")) return;
  if (_autoTriggered.has(tabId)) return;

  let settings;
  try { settings = await loadSettings(); }
  catch (e) { reportWarning("auto-summarize:loadSettings", e.message, { tabId }); return; }
  const domains = settings.autoSummarizeDomains || [];
  if (domains.length === 0) return;

  let host = "";
  try { host = new URL(tab.url).hostname; }
  catch (e) { return; }
  if (!domains.includes(host)) return;

  _autoTriggered.add(tabId);
  // 打开 sidebar
  try { await browser.sidebarAction.open(); }
  catch (e) { reportWarning("auto-summarize:openSidebar", e.message, { host }); }
  // 等 port 连上
  for (let i = 0; i < 20; i++) {
    if (ports.size > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (ports.size === 0) {
    reportWarning("auto-summarize", "no sidebar port after 2s", { host });
    return;
  }
  broadcast({ type: "command", command: "summarize", autoTrigger: true, url: tab.url });
});

// tab 关闭时清掉记录
browser.tabs.onRemoved.addListener((tabId) => {
  _autoTriggered.delete(tabId);
});

// ---------- Alarms 兜底唤醒 ----------
// Firefox MV3 event page 空闲 30s 后会卸载。
// 用 alarms API 每分钟唤醒一次做轻量维护（即使 sidebar 没开）。
// 注：alarms 最小间隔 1 分钟（Firefox 限制），唤醒后 background 存活几秒到十几秒。

const KEEPALIVE_ALARM = "sidebar-ai-keepalive";
const MAINTENANCE_ALARM = "sidebar-ai-maintenance";

browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
browser.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 30 }); // 半小时一次的深度维护

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // 仅做心跳保活，不做耗时操作
    console.log("[sidebar-ai] keepalive tick at", new Date().toISOString(), "active ports:", ports.size);
    return;
  }

  if (alarm.name === MAINTENANCE_ALARM) {
    // 深度维护窗口：统计当前诊断日志和历史条目数量
    // (addDiag 内部已经限制最多保留 200 条，listHistory 不限但通常规模较小)
    try {
      const { listDiag, listHistory } = await import("../lib/storage.js");
      const diags = await listDiag({ limit: 500 });
      const history = await listHistory({ limit: 1000 });
      console.log(`[sidebar-ai] maintenance: diag logs=${diags.length}, history items=${history.length}`);
    } catch (e) {
      console.warn("[sidebar-ai] maintenance failed", e);
    }
  }
});

// ---------- 处理 sidebar 的 keepalive ping ----------
// 在 onMessage 里识别 keepalive 帧，刷新 lastSeen（防 60s idle 误关）。
// 实际实现见 connectBackground 里的 listener —— 已经会刷新 lastSeen 了，
// 但我们额外记一个 "lastKeepalive" 用于诊断。

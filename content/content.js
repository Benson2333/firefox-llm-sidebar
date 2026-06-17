// content/content.js
// 注入到目标页面：负责把页面"交给" sidebar 使用。
// 本身不做提取逻辑（提取放 lib/extractor.js，被 background 调用后注入到页面执行）
// 这里只提供轻量桥接 + 一个 action 触发入口。

(function () {
  "use strict";

  // 暴露一个标记，sidebar 触发 summary/translate 时由 background 通过
  // tabs.executeScript 调用 extractor.js 注入到页面，这里保持内容脚本轻量。
  if (window.__sidebarAI_injected) return;
  window.__sidebarAI_injected = true;

  // 监听来自 background 的消息（content script 不能直接 import background 的模块，
  // 但可以接收一次性指令。这里提供一个 debug ping 用例）。
  browser.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
    try {
      if (msg && msg.type === "sidebar-ai/content/ping") {
        sendResponse({ ok: true, url: location.href, title: document.title });
        return true;
      }
      return false;
    } catch (e) {
      // content script 是 isolated world（非 ES module），无法直接 import 扩展内部模块。
      // 这里降级为 console.warn，并通过 runtime.sendMessage 把错误转发给 background 写入诊断日志。
      try {
        console.warn("[sidebar-ai] content:onMessage error:", e);
      } catch {}
      try {
        browser.runtime.sendMessage({
          type: "diag/report",
          scope: "content:onMessage",
          level: "warn",
          message: e?.message || String(e),
          context: { url: location.href },
        }).catch(() => { /* background 可能未响应，忽略 */ });
      } catch {}
      try { sendResponse({ ok: false, error: String(e) }); } catch {}
      return true;
    }
  });
})();

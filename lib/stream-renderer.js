// lib/stream-renderer.js
// 在 sidebar 页面里订阅 background 推过来的流式 token，逐字渲染 Markdown。
// 配合 vendor 目录里的 marked + DOMPurify 使用。

let _marked = null;
let _dompurify = null;

async function ensureLibs() {
  if (_marked && _dompurify) return;
  // 通过动态 import 加载本地 vendor 模块（避免 inline 大量代码）
  const [{ marked }, { default: DOMPurify }] = await Promise.all([
    import("../vendor/marked.esm.js"),
    import("../vendor/purify.es.mjs"),
  ]);
  _marked = marked;
  _dompurify = DOMPurify;
  // 启用 GFM
  _marked.setOptions({ gfm: true, breaks: true });
}

export async function createStreamSink({
  target,
  onDone,
  onError,
  showCopyButton = true,
  showFollowupButton = false,
}) {
  // target: HTMLElement，会被替换为最终渲染的 markdown HTML
  await ensureLibs();
  let buffer = "";
  let lastRenderedLen = 0;
  let renderTimer = null;
  target.innerHTML = '<div class="md-pending">生成中…</div>';
  target.dataset.raw = "";

  function render() {
    if (!_marked || !_dompurify) return;
    const html = _marked.parse(buffer);
    const safe = _dompurify.sanitize(html, { ADD_ATTR: ["target"] });
    // 在渲染内容前面插入工具栏（复制按钮 + 追问按钮）
    // `safe` 已由 DOMPurify 处理，因此将其作为容器的 innerHTML 是可接受的。
    // 这里分离 toolbar 的创建以避免将未受信内容拼接到字符串中。
    // 先清空 target，然后构建 DOM：toolbar（元素）+ contentContainer（innerHTML = safe）
    target.textContent = "";
    if (showCopyButton) {
      const tb = document.createElement("div");
      tb.className = "md-toolbar";
      const copyBtn = document.createElement("button");
      copyBtn.className = "copy-btn";
      copyBtn.type = "button";
      copyBtn.textContent = "复制";
      copyBtn.title = "复制内容";
      copyBtn.setAttribute("aria-label", "复制内容");
      tb.appendChild(copyBtn);
      if (showFollowupButton) {
        const fbtn = document.createElement("button");
        fbtn.className = "followup-btn";
        fbtn.type = "button";
        fbtn.dataset.action = "followup";
        fbtn.textContent = "💬 用对话追问";
        fbtn.title = "用对话追问";
        fbtn.setAttribute("aria-label", "用对话追问");
        tb.appendChild(fbtn);
      }
      target.appendChild(tb);
    }
    const contentEl = document.createElement("div");
    contentEl.className = "md-content";
    // safe 已经过 DOMPurify，直接设置 innerHTML 在这里是合理的
    contentEl.innerHTML = safe;
    target.appendChild(contentEl);
    lastRenderedLen = buffer.length;
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 30);
  }

  return {
    push(token) {
      buffer += token;
      target.dataset.raw = buffer;
      scheduleRender();
      if (buffer.length - lastRenderedLen > 80) {
        if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
        render();
      }
    },
    async finish() {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      render();
      if (onDone) onDone(buffer);
    },
    fail(err) {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      target.textContent = "";
      const div = document.createElement("div");
      div.className = "md-error";
      div.textContent = `生成失败：${String(err?.message || err)}`;
      target.appendChild(div);
      if (onError) onError(err);
    },
  };
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

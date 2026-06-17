// lib/extractor.js
// Readability 风格的正文提取。
//
// 这个文件**同时在 background 和 content script 里运行**：
//   - content script 里：直接 document
//   - background 里：通过 executeScript 注入目标页执行（通过 eval 字符串注入）
//
// 所以函数接受 html 字符串 + 在传入 html 模式下用 DOMParser；
// 也提供一个直接接收 document 的版本（content script 里用）。

// ---------- HTML 字符串版（在 content script 里跑）----------

export function extractReadableFromHtml(html, baseUrl = "") {
  if (!html || typeof html !== "string") {
    return { title: "", text: "", excerpt: "", length: 0 };
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  return extractFromDoc(doc, baseUrl);
}

// ---------- 文档对象版（直接拿 document，最准）----------

export function extractReadableFromDocument(doc, baseUrl = "") {
  if (!doc) {
    return { title: "", text: "", excerpt: "", length: 0 };
  }
  return extractFromDoc(doc, baseUrl);
}

// ---------- 共享核心 ----------

function extractFromDoc(doc, baseUrl) {
  // 1. 标题
  const title =
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
    doc.querySelector("title")?.textContent?.trim() ||
    doc.querySelector("h1")?.textContent?.trim() ||
    "";

  // 2. 噪音剔除（克隆出来，避免污染原始 DOM）
  const cloned = doc.cloneNode(true);
  const removeSelectors = [
    "script", "style", "noscript", "iframe", "svg", "canvas",
    "nav", "header", "footer", "aside",
    "[role=navigation]", "[role=banner]", "[role=contentinfo]",
    ".advertisement", ".ad", ".ads", ".sidebar", ".comment",
    ".comments", ".share", ".related", ".recommend",
    "[aria-hidden=true]"
  ];
  for (const sel of removeSelectors) {
    cloned.querySelectorAll(sel).forEach((n) => n.remove());
  }

  // 3. 候选段落评分
  const paragraphs = Array.from(cloned.querySelectorAll("p, article, section, main, div"));
  const scored = paragraphs
    .map((el) => {
      const text = (el.textContent || "").trim();
      if (text.length < 40) return null;
      const tagDensity = el.getElementsByTagName("*").length || 1;
      const density = text.length / tagDensity;
      const links = el.querySelectorAll("a").length;
      const linkDensity = links / Math.max(1, text.length / 50);
      const score = density * (1 - Math.min(0.9, linkDensity));
      return { score, text };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  let text = scored.map((s) => s.text).join("\n\n").trim();

  // 兜底
  if (text.length < 200) {
    text = (cloned.body?.textContent || "").trim();
  }

  // 4. 压缩空白
  text = text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");

  // 5. 长度截断
  const MAX_CHARS = 24000;
  const truncated = text.length > MAX_CHARS;
  if (truncated) text = text.slice(0, MAX_CHARS) + "\n\n[...内容已截断...]";

  const excerpt = text.slice(0, 240).replace(/\s+/g, " ").trim();

  return {
    title,
    text,
    excerpt,
    length: text.length,
    truncated,
    baseUrl,
  };
}

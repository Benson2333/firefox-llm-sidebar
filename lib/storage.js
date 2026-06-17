// lib/storage.js
// 三类持久化数据：
//   1) settings       — 配置（首选 provider/model、UI 偏好），用 browser.storage.local
//   2) providers      — 模型配置（含 API key），用 browser.storage.local
//   3) history        — 历史记录，用 IndexedDB（可能很大、可能富文本）
//   4) promptTemplates— prompt 模板，用 browser.storage.local

const STORE_KEYS = {
  SETTINGS: "settings",
  PROVIDERS: "providers",
  TEMPLATES: "promptTemplates",
  PAGE_CACHE: "pageCache", // 页面摘要缓存：{ url: { summaryId, ts } }
};

// ---------- browser.storage.local helpers ----------

export async function loadSettings() {
  const data = await browser.storage.local.get(STORE_KEYS.SETTINGS);
  return (
    data[STORE_KEYS.SETTINGS] || {
      activeProviderId: null,
      activeModelId: null,
      theme: "system", // "light" | "dark" | "system"
      targetLang: "zh-CN",
      summaryLength: "medium", // "short" | "medium" | "long"
      autoOpenOnSelection: false,
      streaming: false, // 默认非流式（更稳，避免某些端点流式协议不兼容）
      autoSummarizeDomains: [], // 自动总结的域名列表
      sidebarPosition: "left", // "left" | "right"
      shortcutSummarize: "Alt+Shift+S",
      shortcutTranslate: "Alt+Shift+T",
      shortcutToggle: "Alt+Shift+A",
      modelGroups: ["主力", "备用", "实验性"], // 模型分组标签
    }
  );
}

export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  await browser.storage.local.set({ [STORE_KEYS.SETTINGS]: next });
  return next;
}

export async function loadProviders() {
  const data = await browser.storage.local.get(STORE_KEYS.PROVIDERS);
  return data[STORE_KEYS.PROVIDERS] || [];
}

export async function saveProviders(providers) {
  await browser.storage.local.set({ [STORE_KEYS.PROVIDERS]: providers });
  return providers;
}

export async function loadTemplates() {
  const data = await browser.storage.local.get(STORE_KEYS.TEMPLATES);
  return (
    data[STORE_KEYS.TEMPLATES] || [
      {
        id: "tpl-summary-default",
        name: "通用总结",
        scope: "summary",
        builtin: true,
        content:
          "请用 {{targetLang}} 对下面的网页内容做一份 {{length}} 风格的总结。\n" +
          "要求：\n- 抓核心论点\n- 保留关键数据/引用\n- 输出 Markdown，使用要点列表\n- 不要复述「这是一篇关于...」之类的套话\n\n网页标题：{{title}}\n\n网页正文：\n{{content}}",
      },
      {
        id: "tpl-translate-default",
        name: "通用翻译",
        scope: "translate",
        builtin: true,
        content:
          "请把下面的网页内容翻译成 {{targetLang}}。\n" +
          "要求：\n- 保留 Markdown/段落结构\n- 术语前后一致\n- 仅翻译，不要总结或评论\n\n原文：\n{{content}}",
      },
      {
        id: "tpl-summary-academic",
        name: "学术总结",
        scope: "summary",
        builtin: true,
        content:
          "请用 {{targetLang}} 对下面的论文/技术文章做学术总结（{{length}}）。\n" +
          "要求：\n- 提取研究问题、方法、关键数据、结论\n- 保留专业术语（首次出现时附原文）\n- 标注作者提出的局限性\n- 输出结构：背景 / 方法 / 结果 / 局限 / 启示\n\n标题：{{title}}\n\n正文：\n{{content}}",
      },
      {
        id: "tpl-summary-bullet",
        name: "要点速览",
        scope: "summary",
        builtin: true,
        content:
          "请用 {{targetLang}} 把下面网页内容压缩成 {{length}} 风格的纯要点列表（短 3-5 条，中 5-8 条，长 8-12 条）。\n" +
          "要求：\n- 每条不超过 20 字\n- 用动词开头\n- 不要任何前言/总结/过渡\n\n标题：{{title}}\n\n正文：\n{{content}}",
      },
      {
        id: "tpl-summary-meeting",
        name: "会议纪要",
        scope: "summary",
        builtin: true,
        content:
          "请把以下会议/对话内容整理成结构化纪要（{{length}}，{{targetLang}}）：\n\n" +
          "格式：\n## 议题\n- 议题 1\n  - 关键观点：\n  - 决策：\n  - 行动项：[负责人] [截止时间] [具体动作]\n## 待办\n- [ ] ...\n## 未解决问题\n- ...\n\n内容：\n{{content}}",
      },
      {
        id: "tpl-summary-eli5",
        name: "通俗解释",
        scope: "summary",
        builtin: true,
        content:
          "请用 {{targetLang}} 把下面的内容用初中生能懂的语言重新解释（{{length}}）。\n" +
          "要求：\n- 避免专业术语；必须用的话加白话注解\n- 用类比/例子\n- 不要堆术语装懂\n\n标题：{{title}}\n\n正文：\n{{content}}",
      },
      {
        id: "tpl-translate-bilingual",
        name: "中英对照翻译",
        scope: "translate",
        builtin: true,
        content:
          "请把下面内容翻译成 {{targetLang}}，并保留中英对照格式：\n\n" +
          "格式：\n- 每段原文下面紧跟译文\n- 术语首次出现时附原文（如「Apple（苹果）」）\n- 保持原段落结构\n\n原文：\n{{content}}",
      },
    ]
  );
}

export async function saveTemplates(templates) {
  await browser.storage.local.set({ [STORE_KEYS.TEMPLATES]: templates });
  return templates;
}

// ---------- 页面缓存（哪些页面已经总结过）----------

export async function getPageCache() {
  const data = await browser.storage.local.get(STORE_KEYS.PAGE_CACHE);
  return data[STORE_KEYS.PAGE_CACHE] || {};
}

export async function setPageCached(url, summaryId) {
  const cache = await getPageCache();
  cache[url] = { summaryId, ts: Date.now() };
  await browser.storage.local.set({ [STORE_KEYS.PAGE_CACHE]: cache });
  return cache;
}

export async function getPageCached(url) {
  const cache = await getPageCache();
  return cache[url] || null;
}

export async function clearPageCache() {
  await browser.storage.local.remove(STORE_KEYS.PAGE_CACHE);
}

// ---------- IndexedDB history ----------

const DB_NAME = "sidebar-ai";
const DB_VERSION = 2;  // v2 加 diagnostics 表
const HISTORY_STORE = "history";
const DIAG_STORE = "diagnostics";

let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const oldVersion = e.oldVersion;
      if (oldVersion < 1) {
        // v0 -> v1: 创建 history 表
        const store = db.createObjectStore(HISTORY_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("by_createdAt", "createdAt", { unique: false });
        store.createIndex("by_domain", "domain", { unique: false });
      }
      if (oldVersion < 2) {
        // v1 -> v2: 创建 diagnostics 表
        const store = db.createObjectStore(DIAG_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("by_createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

export async function addHistory(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, "readwrite");
    const store = tx.objectStore(HISTORY_STORE);
    const payload = {
      createdAt: Date.now(),
      ...record,
    };
    const req = store.add(payload);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listHistory({ limit = 50, offset = 0, query = "" } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, "readonly");
    const idx = tx.objectStore(HISTORY_STORE).index("by_createdAt");
    const out = [];
    let skipped = 0;
    const q = (query || "").toLowerCase().trim();
    const req = idx.openCursor(null, "prev");
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) {
        resolve(out);
        return;
      }
      const v = cur.value;
      // 搜索匹配：title / preview / content / domain / url 任一命中
      let hit = true;
      if (q) {
        const hay = `${v.title || ""} ${v.preview || ""} ${v.content || ""} ${v.domain || ""} ${v.url || ""}`.toLowerCase();
        hit = hay.includes(q);
      }
      if (!hit) {
        cur.continue();
        return;
      }
      if (skipped < offset) {
        skipped++;
        cur.continue();
        return;
      }
      if (out.length < limit) {
        out.push(v);
      }
      if (out.length >= limit) {
        resolve(out);
        return;
      }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteHistory(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, "readwrite");
    const req = tx.objectStore(HISTORY_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// 切换收藏
export async function toggleStarHistory(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, "readwrite");
    const store = tx.objectStore(HISTORY_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const v = getReq.result;
      if (!v) { resolve(null); return; }
      v.starred = !v.starred;
      const putReq = store.put(v);
      putReq.onsuccess = () => resolve(v);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function clearHistory() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, "readwrite");
    const req = tx.objectStore(HISTORY_STORE).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------- 诊断日志（Diagnostic logs）----------
// 每次任务失败 / Provider 配置错误 / 关键事件都写一条。
// 数据结构：{ id, createdAt, level, scope, summary, details }
// 通过 port 让 sidebar/options 能读。

const MAX_DIAG_LOGS = 200;

export async function addDiag({ level = "info", scope = "", summary = "", details = {} }) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DIAG_STORE, "readwrite");
      const store = tx.objectStore(DIAG_STORE);
      const payload = {
        createdAt: Date.now(),
        level, // "info" | "warn" | "error"
        scope, // "summary" | "translate" | "chat" | "config" | "system"
        summary,
        details, // 任意对象
      };
      const req = store.add(payload);
      req.onsuccess = () => {
        resolve(req.result);
        // 异步清理超出限制的条目
        setTimeout(() => trimDiag(db), 0);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn("[diag] addDiag failed", e);
  }
}

async function trimDiag(db) {
  try {
    const tx = db.transaction(DIAG_STORE, "readwrite");
    const idx = tx.objectStore(DIAG_STORE).index("by_createdAt");
    const cursorReq = idx.openCursor(null, "prev");
    let count = 0;
    const toDelete = [];
    cursorReq.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) {
        if (toDelete.length) {
          const tx2 = db.transaction(DIAG_STORE, "readwrite");
          toDelete.forEach((id) => tx2.objectStore(DIAG_STORE).delete(id));
        }
        return;
      }
      count++;
      if (count > MAX_DIAG_LOGS) toDelete.push(cur.value.id);
      cur.continue();
    };
  } catch (e) {
    // ignore
  }
}

export async function listDiag({ limit = 100, level = null } = {}) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DIAG_STORE, "readonly");
      const idx = tx.objectStore(DIAG_STORE).index("by_createdAt");
      const out = [];
      const req = idx.openCursor(null, "prev");
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { resolve(out); return; }
        if (!level || cur.value.level === level) {
          out.push(cur.value);
        }
        if (out.length >= limit) { resolve(out); return; }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn("[diag] listDiag failed", e);
    return [];
  }
}

export async function clearDiag() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DIAG_STORE, "readwrite");
      const req = tx.objectStore(DIAG_STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn("[diag] clearDiag failed", e);
  }
}

// 导出当前所有诊断 + 配置 + 最近历史（用于一键导出）
export async function exportDiagnosticBundle() {
  const settings = await loadSettings();
  const providers = await loadProviders();
  const templates = await loadTemplates();
  const history = await listHistory({ limit: 20 });
  const diags = await listDiag({ limit: 50 });
  // error-reporter 内部状态（去重/未读数）— 调试 reporter bug 用
  let reporterStats = null;
  try {
    const { getReporterStats } = await import("./error-reporter.js");
    reporterStats = getReporterStats();
  } catch {}
  return {
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    extensionVersion: (globalThis.browser?.runtime?.getManifest?.()?.version) || "unknown",
    settings,
    providers: providers.map((p) => ({ ...p, apiKey: p.apiKey ? "***" + p.apiKey.slice(-4) : "" })),
    templates,
    recentHistory: history.map((h) => ({ ...h, content: h.content?.slice(0, 500) })),
    recentDiagnostics: diags,
    reporterStats,
  };
}

// 导出可恢复的配置（用于多设备同步）
// 包含：settings、providers（key 脱敏）、templates
// 不包含：history、diag（这些是设备本地的）
export async function exportConfig() {
  const settings = await loadSettings();
  const providers = await loadProviders();
  const templates = await loadTemplates();
  return {
    kind: "sidebar-ai-config",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    providers: providers.map((p) => ({
      ...p,
      apiKey: p.apiKey ? "***" + p.apiKey.slice(-4) : "",
      _apiKeyMasked: true,  // 标记，导入时需要用户重新填
    })),
    templates,
  };
}

// 导入配置。返回报告。
// mode: "merge" 合并（保留现有不冲突的）；"replace" 替换（覆盖所有）
export async function importConfig(bundle, mode = "merge") {
  if (!bundle || bundle.kind !== "sidebar-ai-config") {
    throw new Error("配置文件格式不对（不是 sidebar-ai-config）");
  }
  const report = { settings: false, providersAdded: 0, providersSkipped: 0, templatesAdded: 0, templatesSkipped: 0 };

  if (bundle.settings) {
    if (mode === "replace") {
      await browser.storage.local.set({ settings: bundle.settings });
    } else {
      const cur = await loadSettings();
      await browser.storage.local.set({ settings: { ...cur, ...bundle.settings } });
    }
    report.settings = true;
  }

  if (Array.isArray(bundle.providers)) {
    const existing = mode === "replace" ? [] : await loadProviders();
    const existingIds = new Set(existing.map((p) => p.id));
    for (const p of bundle.providers) {
      // 如果导入 bundle 标记为 _apiKeyMasked 表示导出时被脱敏：
      // - 不要写入空字符串覆盖本地 apiKey
      // - 保留 _apiKeyMasked 标记，让 UI 提示用户在 Provider 编辑界面补全
      const copy = { ...p };
      if (copy._apiKeyMasked) {
        // 删除实际 apiKey 字段（不要将空字符串写入），保留标记
        delete copy.apiKey;
      }
      if (existingIds.has(copy.id)) {
        report.providersSkipped++;
        continue;
      }
      existing.push(copy);
      report.providersAdded++;
    }
    await saveProviders(existing);
  }

  if (Array.isArray(bundle.templates)) {
    const existing = mode === "replace" ? [] : await loadTemplates();
    const existingIds = new Set(existing.map((t) => t.id));
    for (const t of bundle.templates) {
      if (existingIds.has(t.id)) {
        report.templatesSkipped++;
        continue;
      }
      existing.push(t);
      report.templatesAdded++;
    }
    await saveTemplates(existing);
  }

  return report;
}


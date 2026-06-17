// lib/error-reporter.js
// 统一错误收集与上报模块（v2 — 全面升级版）
//
// 设计目标：
//   1. 把分散的 console.warn / 静默 catch 统一收口
//   2. 自动捕获未处理异常 (unhandledrejection / window.onerror)
//   3. 通过 addDiag 写入 IndexedDB（让设置页能看）
//   4. 重要错误通过 broadcast 推给 sidebar 弹窗（带队列/去重/分类）
//   5. 暴露 safeBrowser.* 包装所有 browser API 调用
//   6. 暴露 safeFetch 全局 fetch 包装
//
// 调用方：
//   import { reportError, safeBrowser, safeFetch, installGlobalHandlers } from "../lib/error-reporter.js";
//   try { await safeBrowser.tabs.query({...}); } catch (e) { reportError(...) }
//   const r = await safeFetch(url, opts);

import { addDiag } from "./storage.js";

// ============================================================
// 状态
// ============================================================

let _portBroadcaster = null;
let _unreadCount = 0;
let _lastErrorMap = new Map(); // hash -> { ts, count, message }
const DEDUPE_WINDOW_MS = 60_000; // 60s 内同错只报一次
const MAX_DEDUPE_ENTRIES = 100;
const ERROR_QUEUE_MAX = 10; // 弹窗队列最多保留 10 个未读

// 错误分类器：把 raw error 转成结构化分类
function classifyError(err) {
  const msg = String(err?.message || err || "");
  const name = err?.name || "";
  if (name === "AbortError" || /abort|cancel/i.test(msg)) {
    return { kind: "abort", userHint: "操作被取消" };
  }
  if (/HTTP 401|Unauthorized|invalid.*api.*key|api.*key.*invalid/i.test(msg)) {
    return { kind: "auth", userHint: "API Key 无效或过期，请到设置页检查" };
  }
  if (/HTTP 403|Forbidden|permission/i.test(msg)) {
    return { kind: "forbidden", userHint: "无权限（API Key 权限不足？）" };
  }
  if (/HTTP 404|Not Found|model.*not.*found/i.test(msg)) {
    return { kind: "notfound", userHint: "模型 id 或 baseUrl 错误" };
  }
  if (/HTTP 429|rate.?limit|too.?many.?requests/i.test(msg)) {
    return { kind: "ratelimit", userHint: "请求太频繁，请稍后再试" };
  }
  if (/HTTP 5\d\d|server error|internal error/i.test(msg)) {
    return { kind: "server", userHint: "服务端错误，请稍后重试" };
  }
  if (/timeout|timed.?out|aborted/i.test(msg)) {
    return { kind: "timeout", userHint: "请求超时" };
  }
  if (/NetworkError|Failed to fetch|TypeError: Load failed|CORS|跨域/i.test(msg)) {
    return { kind: "network", userHint: "网络不通或 CORS 拦截，检查 baseUrl / 网络 / 服务端 CORS 配置" };
  }
  if (/页面正文|提取/.test(msg)) {
    return { kind: "extract", userHint: "此页面无正文可总结" };
  }
  if (err instanceof TypeError) {
    return { kind: "code", userHint: "代码逻辑错误（TypeError）" };
  }
  if (err instanceof SyntaxError) {
    return { kind: "code", userHint: "代码逻辑错误（SyntaxError）" };
  }
  if (err instanceof ReferenceError) {
    return { kind: "code", userHint: "代码逻辑错误（ReferenceError）" };
  }
  return { kind: "unknown", userHint: msg || "未知错误" };
}

const SEVERITY_LEVELS = { info: 0, warn: 1, error: 2 };
function pickLevel(input) {
  if (typeof input === "string") {
    if (SEVERITY_LEVELS[input] != null) return input;
    return "error";
  }
  if (input?.name === "AbortError" || /abort|cancel/i.test(input?.message || "")) {
    return "info";
  }
  return "error";
}

// 简单 hash 用于去重
function hashError(scope, message) {
  const s = `${scope || "unknown"}|${message || ""}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return String(h);
}

// ============================================================
// 公开 API
// ============================================================

export function setPortBroadcaster(fn) { _portBroadcaster = fn; }

export function getUnreadCount() { return _unreadCount; }
export function clearUnread() { _unreadCount = 0; }
export function markRead() { _unreadCount = 0; }

// 主入口：reportError(scope, error, options)
export async function reportError(scope, error, options = {}) {
  try {
    const level = options.level || pickLevel(error);
    const message = String(error?.message || error || "未知错误");
    const stack = error?.stack || "";
    const cls = classifyError(error);
    const hash = hashError(scope, message);

    // 去重节流
    const now = Date.now();
    const last = _lastErrorMap.get(hash);
    if (last && now - last.ts < DEDUPE_WINDOW_MS) {
      last.count++;
      last.ts = now;
      return; // 60s 内不重报
    }
    _lastErrorMap.set(hash, { ts: now, count: 1, message, scope });
    if (_lastErrorMap.size > MAX_DEDUPE_ENTRIES) {
      // 删最早的一半
      const keys = [..._lastErrorMap.keys()];
      for (const k of keys.slice(0, keys.length / 2)) _lastErrorMap.delete(k);
    }

    const details = {
      ...(options.context || {}),
      kind: cls.kind,
      userHint: cls.userHint,
      errorName: error?.name,
      errorStack: stack.split("\n").slice(0, 10).join("\n"),
    };

    // 1) IndexedDB
    await addDiag({
      level,
      scope: scope || "unknown",
      summary: message,
      details,
    });

    // 2) console
    const consoleMsg = `[sidebar-ai:${level}] ${scope || "unknown"}: ${message}`;
    if (level === "error") console.error(consoleMsg, details);
    else if (level === "warn") console.warn(consoleMsg, details);
    else console.log(consoleMsg, details);

    // 3) 弹窗
    if (!options.silent && (level === "error" || options.fatal)) {
      _unreadCount++;
      const payload = {
        type: "error/remote",
        level,
        scope: scope || "unknown",
        message,
        kind: cls.kind,
        userHint: cls.userHint,
        details,
        ts: Date.now(),
        hash,
      };
      try { _portBroadcaster?.(payload); } catch {}
    }
  } catch (e) {
    console.error("[error-reporter] reportError failed:", e);
  }
}

export function reportWarning(scope, message, context) {
  return reportError(scope, message, { level: "warn", context });
}
export function reportInfo(scope, message, context) {
  return reportError(scope, message, { level: "info", context });
}

// 主动清空去重缓存（清空诊断日志时也调一下，避免旧错重新冒出来）
export function clearDedupeCache() {
  _lastErrorMap.clear();
}

// 暴露内部状态快照（诊断包用），不暴露 Map 引用
export function getReporterStats() {
  const now = Date.now();
  const recent = [..._lastErrorMap.entries()]
    .map(([hash, v]) => ({
      hash,
      scope: v.scope,
      message: v.message,
      count: v.count,
      ageMs: now - v.ts,
    }))
    .sort((a, b) => a.ageMs - b.ageMs);
  return {
    dedupeEntries: _lastErrorMap.size,
    dedupeWindowMs: DEDUPE_WINDOW_MS,
    unreadCount: _unreadCount,
    recentDedupe: recent.slice(0, 20),
  };
}

// ============================================================
// 浏览器 API 安全包装：safeBrowser.* / safeFetch
// ============================================================

// 用 Proxy 包裹任意对象的方法，自动 catch 抛出的 rejection
function wrapAsync(obj, path = "") {
  if (obj == null) return obj;
  return new Proxy(obj, {
    get(target, key) {
      const v = target[key];
      if (typeof v === "function") {
        return (...args) => {
          try {
            const r = v.apply(target, args);
            if (r && typeof r.then === "function") {
              return r.catch((e) => {
                reportError(`browser${path}.${String(key)}`, e, { context: { args: safeArgsForLog(args) } });
                throw e;
              });
            }
            return r;
          } catch (e) {
            reportError(`browser${path}.${String(key)}`, e, { context: { sync: true, args: safeArgsForLog(args) } });
            throw e;
          }
        };
      }
      // 子对象（如 storage.local、runtime）继续包
      if (v && typeof v === "object" && (path === "" || !path.endsWith(String(key)))) {
        return wrapAsync(v, `${path}.${String(key)}`);
      }
      return v;
    },
  });
}

function safeArgsForLog(args) {
  return args.map((a) => {
    if (typeof a === "string") return a.length > 100 ? a.slice(0, 100) + "..." : a;
    if (typeof a === "function") return "[Function]";
    try { return JSON.stringify(a).slice(0, 200); } catch { return "[Object]"; }
  });
}

// 全局 fetch 包装：把 fetch 错误也上报
export async function safeFetch(url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok) {
      const text = await r.clone().text().catch(() => "");
      throw new Error(`HTTP ${r.status} ${r.statusText} ${text.slice(0, 200)}`);
    }
    return r;
  } catch (e) {
    reportError(`fetch:${opts?.method || "GET"} ${shortenUrl(url)}`, e, {
      context: { url: shortenUrl(url), status: e.message.match(/HTTP (\d+)/)?.[1] },
    });
    throw e;
  }
}

function shortenUrl(u) {
  try { const x = new URL(u); return `${x.host}${x.pathname}`.slice(0, 80); } catch { return String(u).slice(0, 80); }
}

// 暴露一个全局 browser 包装（替代直接用 browser.tabs 等）
let _safeBrowserCache = null;
export function safeBrowser() {
  if (_safeBrowserCache) return _safeBrowserCache;
  if (typeof browser === "undefined") return null;
  _safeBrowserCache = wrapAsync(browser, "");
  return _safeBrowserCache;
}

// 全局 fetch 包装（如果环境支持，直接覆盖全局）
export function installFetchWrapper() {
  if (typeof globalThis === "undefined") return;
  if (globalThis.__sidebarAI_fetchWrapped) return;
  const orig = globalThis.fetch;
  if (!orig) return;
  globalThis.fetch = async function patchedFetch(url, opts) {
    try {
      const r = await orig.call(this, url, opts);
      if (!r.ok) {
        const text = await r.clone().text().catch(() => "");
        const err = new Error(`HTTP ${r.status} ${r.statusText} ${text.slice(0, 200)}`);
        reportError(`fetch:${opts?.method || "GET"} ${shortenUrl(url)}`, err, {
          context: { url: shortenUrl(url), status: r.status },
        });
        throw err;
      }
      return r;
    } catch (e) {
      // 网络层错误（fetch 自身 throw）
      if (!/^HTTP \d+/.test(e.message)) {
        reportError(`fetch:${opts?.method || "GET"} ${shortenUrl(url)}`, e, {
          context: { url: shortenUrl(url) },
        });
      }
      throw e;
    }
  };
  globalThis.__sidebarAI_fetchWrapped = true;
}

// ============================================================
// 全局未捕获异常处理
// ============================================================

export function installGlobalHandlers() {
  if (typeof window !== "undefined") {
    window.addEventListener("error", (e) => {
      if (e?.target && (e.target.tagName === "IMG" || e.target.tagName === "SCRIPT" || e.target.tagName === "LINK")) {
        return;
      }
      reportError("ui:window.onerror", e.error || e.message, {
        context: { filename: e.filename, lineno: e.lineno, colno: e.colno },
      });
    });
    window.addEventListener("unhandledrejection", (e) => {
      const reason = e.reason;
      reportError("ui:unhandledrejection", reason, {
        context: { type: typeof reason, reasonStr: String(reason?.message || reason) },
      });
    });
  }
  // 顺手装 fetch 包装
  // Note: do NOT auto-install the global fetch wrapper to avoid unexpected
  // global side-effects across different extension contexts. Call
  // `installFetchWrapper()` explicitly where needed (UI layer).
}

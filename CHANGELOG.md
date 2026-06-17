# Changelog

All notable changes to **LLM 侧边栏** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned
- Vision model support (right-click image → identify)
- Cloud sync (optional, end-to-end encrypted, opt-in)
- Firefox for Android support
- i18n (zh-CN, en-US)

## [0.2.0] - 2026-06-17

### Changed
- **Renamed**: "LLM 侧边栏" (was "LLM Sidebar" / "Sidebar AI") — 更适合中文用户
- **New icon**: 青绿渐变聊天气泡 + 大写 "S" 字母
- **Version bump**: 0.1.0 → 0.2.0 (manifest version)

## [0.1.0] - 2026-06-17

## [0.1.0] - 2026-06-17

### Added
- Initial public release
- **Summarize** current page (Alt+Shift+S)
- **Translate** selected text or whole page (Alt+Shift+T), with optional bilingual output
- **Chat** with active LLM, with optional page context
- **Selection tools**: right-click → "Explain selection" / "Translate selection"
- **Multi-model compare**: run 2-4 models side-by-side
- **History**: persisted in IndexedDB, searchable, exportable as Markdown
- **Prompt templates**: 5 built-in + unlimited custom, supports snippet composition
- **Auto-summarize** on matching domains (e.g. every GitHub issue)
- **Themes**: Dark / Light / Sepia, follows system
- **Keyboard shortcuts**: fully rebindable in `about:addons`
- **Comprehensive error reporting**:
  - Unified `reportError()` API in `lib/error-reporter.js`
  - Auto-captures `unhandledrejection` and `window.onerror`
  - Wraps `browser.*` API calls via `safeBrowser()` Proxy — no silent failures
  - Wraps `fetch` globally — network errors auto-classified
  - 9-way error classification (auth / network / ratelimit / server / timeout / extract / code / abort / unknown) with human-friendly hints
  - 60s deduplication window — repeated identical errors collapse
  - 10-item error queue with prev/next/clear-all in the notice dialog
  - Unread-error badge in the sidebar (pulsing red dot)
  - Per-error diagnostic in the Options page (filterable, exportable, testable)
  - Failed-history entries store full error context (stack, last diagnostic, provider/model)
- **Configuration import/export** (cross-device sync, API keys masked)
- **Diagnostic bundle export** — one-click JSON dump for bug reports

### Supported LLM Providers
- OpenAI (and any OpenAI-compatible: DeepSeek, Kimi, 通义千问, 智谱, OpenRouter, etc.)
- Anthropic Claude (via CORS-enabled proxy)
- Google Gemini (via CORS-enabled proxy)
- Ollama (local)
- Custom OpenAI-compatible endpoint

### Security
- All LLM API calls go through background page (privileged context) — CORS-free for users
- All rendered Markdown is sanitized with DOMPurify
- All `innerHTML` with user-supplied content goes through `escapeHtml()` / `escape()`
- No remote scripts, no eval, no `new Function()`
- No analytics, no telemetry, no tracking

[Unreleased]: https://github.com/WhiteBenson/firefox-llm-sidebar/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/WhiteBenson/firefox-llm-sidebar/releases/tag/v0.1.0

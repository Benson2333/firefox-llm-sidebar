# LLM 侧边栏

> Firefox sidebar extension — summarize / translate / chat with any LLM, directly from the page you're reading.

[![License: MPL-2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Firefox](https://img.shields.io/badge/Firefox-142%2B-orange)](https://www.mozilla.org/firefox/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json)
[![Status: pending AMO review](https://img.shields.io/badge/AMO-Pending-yellow)]()

> **Privacy-first**: No analytics, no telemetry, no remote code. All data stays in your browser.

---

## ✨ Features

- **📑 Summarize** the current page (Alt+Shift+S) — one-click TL;DR, supports long articles
- **🌐 Translate** selected text or whole page (Alt+Shift+T) — bilingual output optional
- **💬 Chat** with the active LLM, optionally with page context pre-loaded
- **🔍 Selection tools** — explain / translate the highlighted text without leaving the page
- **⚖️ Multi-model compare** — run 2-4 models side-by-side on the same input
- **🖼 Vision** (placeholder) — right-click an image → "Identify with LLM 侧边栏"
- **📂 History** — every result is saved locally (IndexedDB), searchable, exportable as Markdown
- **🧩 Prompt templates** — pre-defined + custom, supports snippet composition
- **🌙 Auto-summarize** on matching domains (e.g. auto-summarize every GitHub issue you visit)
- **🛡 Error reporting** — comprehensive diagnostics with privacy-preserving local logs
- **🎨 Themes** — Dark / Light / Sepia, follows system preference
- **⌨️ Keyboard shortcuts** — fully rebindable in `about:addons`

## 🧠 Supported LLM Providers

Built-in adapters for:

| Provider | API Style | Models | Notes |
|----------|-----------|--------|-------|
| **OpenAI** | `/v1/chat/completions` | gpt-4o, gpt-4-turbo, gpt-3.5-turbo, o1, o3, … | Official + any OpenAI-compatible proxy |
| **DeepSeek** | OpenAI-compatible | deepseek-chat, deepseek-reasoner, deepseek-coder | 64K context, very cheap |
| **Anthropic** | `/v1/messages` | claude-3.5-sonnet, claude-3-opus, … | Requires CORS-enabled proxy |
| **Google Gemini** | `/v1beta/models` | gemini-1.5-pro, gemini-1.5-flash, … | Requires CORS-enabled proxy |
| **Ollama** | `/api/chat` | Any local model | Runs `ollama serve` locally |
| **OpenAI-compatible** | Generic | Any | Kimi, 通义千问, 智谱 GLM, OpenRouter, etc. |
| **Custom** | User-defined | Any | Point to any base URL |

> **Bring your own API key.** Stored locally, never sent to any third party.

## 📦 Installation

### From AMO (when published)

Visit the [LLM 侧边栏 AMO page](#) (link TBD after approval) and click "Add to Firefox".

### From source (developer mode)

1. Clone this repository
2. Open `about:debugging` in Firefox
3. Click **This Firefox** → **Load Temporary Add-on…**
4. Select `manifest.json`

Temporary add-ons work for the current session; reload after Firefox restart.

## 🛠 Development

```bash
# Install web-ext (Firefox's official dev CLI)
npm install -g web-ext

# Run with auto-reload in a fresh profile
web-ext run --source-dir=. --keep-profile-changes

# Lint (catches AMO-policy violations)
web-ext lint --source-dir=.

# Build unsigned .xpi (for self-install via about:config)
web-ext build --source-dir=. --artifacts-dir=./dist
```

### Project structure

```
firefox-llm-sidebar/
├── manifest.json          # MV3 manifest
├── background/            # background event page
│   └── background.js
├── content/               # content scripts (runs in page)
│   └── content.js
├── sidebar/               # the sidebar UI (HTML + JS)
│   ├── sidebar.html
│   ├── sidebar.css
│   └── sidebar.js
├── options/               # settings page
│   ├── options.html
│   ├── options.css
│   └── options.js
├── lib/                   # shared modules
│   ├── error-reporter.js  # unified error capture + dedup + classification
│   ├── extractor.js       # page text extraction
│   ├── llm-client.js      # LLM API client
│   ├── storage.js         # IndexedDB wrapper (settings / history / diagnostics)
│   ├── stream-renderer.js # streaming Markdown render
│   └── providers/         # LLM provider adapters
├── vendor/                # vendored dependencies (marked, DOMPurify)
│   ├── marked.esm.js
│   └── purify.es.mjs
└── icons/                 # extension icons
```

### Code style

- No build step — the extension is pure ES modules
- All `innerHTML` with user-provided content must go through `escapeHtml()` or DOMPurify
- All async browser API calls should go through `safeBrowser()` (auto-reports failures)
- Every code change must pass `node parse-all.mjs` (acorn static check) before packaging

## 🤝 Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

- File bugs / feature requests in [Issues](../../issues)
- For security issues, see [SECURITY.md](SECURITY.md) (private disclosure)

## 🔒 Privacy

Read the full [PRIVACY.md](PRIVACY.md) (also embedded in AMO submission).

**TL;DR**:
- No analytics, no telemetry, no tracking pixels
- No remote code (extension never downloads or executes external scripts)
- All user data (API keys, history, settings, diagnostics) stored in your local browser
- API keys sent **only** to the LLM provider you configured
- Page content sent **only** to the LLM provider when you explicitly request a summary/translate/chat
- Open source: [PRIVACY.md](PRIVACY.md) code is auditable on GitHub

## 📄 License

[Mozilla Public License 2.0](LICENSE)

Copyright © 2025 WhiteBenson

## 🙏 Acknowledgments

- [marked](https://github.com/markedjs/marked) — Markdown parser
- [DOMPurify](https://github.com/cure53/DOMPurify) — XSS sanitizer for rendered Markdown

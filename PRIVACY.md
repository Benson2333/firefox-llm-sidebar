# Privacy Policy — LLM 侧边栏

**Last updated**: 2025-06-17
**Version**: 0.1.0

LLM 侧边栏 ("the extension") is a Firefox sidebar extension that summarizes, translates, and chats with Large Language Models (LLMs) about the page you're reading. This privacy policy describes what data the extension handles, what it does with that data, and what it does **not** do.

## 1. Data we DO NOT collect

- We do **not** run any analytics, tracking pixels, telemetry, or crash reporting.
- We do **not** communicate with any server we operate. The extension has no central server.
- We do **not** sell, share, or transfer your data to any third party.
- We do **not** execute any remote code. Every line of code shipped in the extension is included in the source repository; nothing is fetched and executed at runtime.
- We do **not** use cookies, `localStorage` for tracking, or any other persistent identifier shared with third parties.

## 2. Data the extension stores locally (in your browser only)

The extension stores the following data **only in your browser's local storage and IndexedDB**. This data never leaves your device except as described in Section 3.

| Data | Where stored | Purpose | Lifetime |
|------|--------------|---------|----------|
| Your LLM provider configuration (name, base URL, model IDs) | `browser.storage.local` | Remember your settings | Until you remove the extension or clear it manually |
| Your LLM API keys | `browser.storage.local` | Authenticate with LLM providers | Same as above; never transmitted to us |
| Your prompt templates | `browser.storage.local` | Reuse across sessions | Same as above |
| Per-session state (active provider, active model, theme) | `browser.storage.local` | Restore UI state on next open | Same as above |
| Page summary / translation / chat history | IndexedDB (`history` store, capped at 200 entries) | Browse past results, export as Markdown | Until you delete it or remove the extension |
| Error diagnostics (level, scope, message, stack trace) | IndexedDB (`diagnostics` store, capped at 200 entries) | Help you debug issues, exportable as JSON | Same as above |
| Per-page summary cache (URL → last summary ID) | IndexedDB (`pageCache` store) | Show "already summarized" indicator on repeated visits | Same as above |

**No sync.** This data does not sync across devices. If you sign into Firefox Sync, only your Firefox profile data syncs (not extension data) — your extension data stays on the device where you created it.

## 3. Data the extension sends to third parties

The extension sends data **only to the LLM provider you explicitly configured** in the settings page. We do not choose the provider; you do.

### What gets sent, and when

| Action you take | What gets sent | To whom |
|-----------------|----------------|---------|
| Click "Summarize" (or press Alt+Shift+S) | The current page's main text content (extracted by a heuristic, not raw HTML) | The LLM provider you configured (e.g. OpenAI / DeepSeek / Anthropic / etc.) |
| Click "Translate" / select text and right-click → Translate | The selected text or page text | Same as above |
| Right-click → "Explain selection" | The selected text | Same as above |
| Type and send a chat message | Your message, plus (if "Include page context" is on) the current page's text | Same as above |
| Open the Options page → "Test connection" / "Fetch models" | Your API key (as Bearer token), the API base URL you entered | The provider endpoint you entered |

### What does NOT get sent

- Your browsing history outside the page you're actively summarizing
- Your bookmarks, cookies, saved passwords
- Your keystrokes (the extension does not use a keylogger)
- Your IP address (to us; the LLM provider may log theirs, governed by **their** privacy policy)
- Any identifier that could link your extension usage to your real identity

## 4. Third-party services you choose to use

When you configure an LLM provider, the data flow between you and that provider is governed by **that provider's** privacy policy, not ours. We do not control what the provider logs.

Common providers and their privacy policies (links provided for convenience; verify these yourself):

- OpenAI: <https://openai.com/policies/privacy-policy>
- Anthropic: <https://www.anthropic.com/privacy>
- Google Gemini: <https://ai.google.dev/terms>
- DeepSeek: <https://www.deepseek.com/privacy>
- Ollama (local, no data leaves your machine): <https://ollama.com/privacy>

For any custom OpenAI-compatible endpoint you configure, the privacy terms are those of the operator of that endpoint.

## 5. Permissions the extension requests, and why

The `manifest.json` requests the following permissions, all of which are required for the documented functionality:

| Permission | Why |
|------------|-----|
| `storage` | Store your settings, history, diagnostics |
| `tabs` | Read the current active tab's URL and title (so the sidebar knows what page you're on) |
| `activeTab` | Inject a content script into the active tab when you click "Summarize" (to extract the page text) |
| `scripting` | Programmatically inject the content script when you trigger a summary |
| `contextMenus` | Add the right-click "Translate / Explain selection" items |
| `alarms` | Wake the background page periodically to maintain the long-lived sidebar connection |
| `<all_urls>` host permission | Required for `scripting.executeScript` to read the page text on any site you visit |

**No permission is requested for tracking, geolocation, camera, microphone, downloads, or notifications.**

## 6. Children's privacy

The extension is not directed at children under 13. We do not knowingly collect data from children. Because we collect no data at all, this is largely moot.

## 7. Changes to this policy

If we make material changes, we will:
1. Bump the extension version
2. Update this file in the source repository
3. Note the change in `CHANGELOG.md`
4. For breaking changes (e.g. adding a permission), request your consent on next extension update

## 8. Open source

The full source code is publicly available at the repository linked in the AMO listing. You can audit every line of code that runs in your browser.

## 9. Contact

If you have questions or want to exercise any data-rights you may have (deletion, access), use the **support** link on the AMO listing page. Because all data is local, deletion is as simple as uninstalling the extension or clearing the storage from `about:debugging`.

---

*This policy is also embedded in the AMO submission form for this extension.*

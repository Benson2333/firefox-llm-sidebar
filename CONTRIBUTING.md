# Contributing to LLM 侧边栏

Thanks for your interest! LLM 侧边栏 is a small, opinionated Firefox extension. Contributions are welcome, but please read this first to avoid wasted effort.

## Code of conduct

Be respectful. Assume good faith. Disagreement is fine; personal attacks are not.

## How to file a bug

1. **Search existing issues** first — your bug may already be reported
2. Use the bug report template
3. **Include the diagnostic bundle** (Options → Diagnostics → "Export full diagnostic bundle") — without it, we can't reproduce
4. Specify your Firefox version, OS, and the LLM provider you used
5. If it's a security issue, see [SECURITY.md](SECURITY.md) for private disclosure

## How to suggest a feature

Open an issue with the "feature request" label. Describe:
- **What** you want to do
- **Why** the current extension can't do it
- **How often** you'd use it

If it's a niche use case that affects only you, please consider whether it's worth maintaining forever.

## Development setup

```bash
git clone https://github.com/WhiteBenson/firefox-llm-sidebar.git
cd firefox-llm-sidebar

# Install web-ext CLI (Firefox's official dev tool)
npm install -g web-ext

# Run with auto-reload in a clean profile
web-ext run --source-dir=. --keep-profile-changes

# Lint (catches AMO-policy violations)
web-ext lint --source-dir=.

# Build .xpi
web-ext build --source-dir=. --artifacts-dir=./dist
```

Open Firefox DevTools (`Ctrl+Shift+J`) to see console output. The extension's logs are prefixed with `[llm-sidebar]`.

## Code style

- **No build step.** The extension is pure ES modules served directly. Don't add TypeScript / React / bundlers.
- **No external CDN dependencies at runtime.** Everything is vendored under `vendor/`.
- **All `innerHTML` with user-supplied content must go through `escapeHtml()` / `escape()`** — AMO will reject otherwise. Static templates (your own hardcoded HTML) are fine.
- **All `browser.*` API calls should go through `safeBrowser()`** — auto-reports failures to the error pipeline.
- **All `fetch` should go through `safeFetch()` or be wrapped by `installFetchWrapper()`** — same reason.
- **Every code change must pass `node parse-all.mjs`** (acorn static check) before packaging. This catches the most common breakage (mismatched braces from edit tools).
- **Use `reportError(scope, error, options)` from `lib/error-reporter.js`** instead of bare `console.error`. The reporter handles dedup, classification, console output, and IndexedDB persistence.

## Pull request process

1. **Open an issue first** for non-trivial changes. Don't dump a 500-line PR with no discussion.
2. **One feature per PR.** Don't bundle refactoring with features.
3. **Run `web-ext lint`** — it catches AMO policy violations that will get your PR rejected at submission time.
4. **Run `node parse-all.mjs`** — catches static errors.
5. **Update `CHANGELOG.md`** under the "Unreleased" section.
6. **No new external dependencies** without discussion. Vendoring is fine; npm dependencies require review.
7. **No new permissions** in `manifest.json` without a strong justification and an updated privacy policy. AMO will scrutinize every permission.

## Architecture decisions

- **Why MV3 + sidebar_action?** Firefox 142+ supports sidebar APIs in MV3. Chrome doesn't, so we don't try to be cross-browser.
- **Why no React / no bundler?** The extension is small enough (1329 lines) that the overhead would dominate. ES modules + plain DOM work fine.
- **Why background page (event page) for LLM calls?** To bypass CORS restrictions on browser-to-provider calls. The background page has elevated privileges; the sidebar UI is just a renderer.
- **Why IndexedDB and not `browser.storage.local` for history?** `browser.storage.local` is sync to a quota. IndexedDB handles large blobs (full LLM responses).
- **Why DOMPurify on Markdown render?** Markdown from an LLM can contain arbitrary HTML (e.g. `<script>` if the model is jailbroken). DOMPurify is the gold standard for XSS sanitization.

## Release process (maintainers only)

1. Bump version in `manifest.json` and `package.json`
2. Update `CHANGELOG.md` — move "Unreleased" entries to a dated version section
3. Run `web-ext lint`
4. Run `web-ext build`
5. `web-ext sign --api-key=$AMO_API_KEY --api-secret=$AMO_API_SECRET` (requires AMO API credentials in env)
6. Upload the signed `.xpi` to AMO
7. Tag the release: `git tag v0.X.Y && git push --tags`
8. Create a GitHub release with the signed `.xpi` attached

## License

By contributing, you agree that your contributions will be licensed under the [Mozilla Public License 2.0](LICENSE).

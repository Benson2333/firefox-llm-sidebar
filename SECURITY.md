# Security Policy

## Reporting a vulnerability

**Please do not file a public issue for security vulnerabilities.**

Email: `security@whitebenson.dev` (or open a [GitHub Security Advisory](../../security/advisories/new) for private disclosure)

Please include:
- A clear description of the vulnerability
- Steps to reproduce
- Firefox version, OS
- The diagnostic bundle (Options → Diagnostics → "Export full diagnostic bundle")

I will acknowledge within 48 hours and aim to ship a fix within 7 days for critical issues.

## What counts as a vulnerability

- Remote code execution via crafted page content
- API key exfiltration
- Bypass of the content script isolation
- DOM XSS via unescaped error messages or template variables
- Anything that allows a malicious page to read your API keys, history, or settings

## What does NOT count

- LLM provider logging your requests (governed by the provider's own privacy policy)
- Network requests visible to your ISP (they can see you're calling an LLM API; we can't prevent that)
- The extension requiring `host_permissions: ["<all_urls>"]` (this is required for the page-extraction feature)

## Out of scope

This extension is a thin client over third-party LLM providers. Vulnerabilities in the LLM provider's API are not our responsibility — please report them to the provider.

## Disclosure timeline

- **Day 0**: Vulnerability reported privately
- **Day 1-2**: Acknowledgment + triage
- **Day 3-7**: Patch developed
- **Day 7-14**: Patch released + AMO update submitted
- **Day 14+**: Public disclosure (after most users have updated)

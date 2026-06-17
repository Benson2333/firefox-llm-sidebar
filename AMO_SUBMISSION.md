# 🚀 LLM 侧边栏 — AMO 上架全流程

> 这是把 LLM 侧边栏 提交到 [addons.mozilla.org](https://addons.mozilla.org) 的分步指南。
> **预计总耗时**：注册 + 准备材料 30 分钟，提交后审核 1-2 周（新开发者首次更慢）。

## 📋 你需要准备的东西

| 项目 | 状态 | 说明 |
|------|------|------|
| Firefox 142+ | ✅ 你已有 | |
| AMO 开发者账号 | ❌ 还没 | [AMO_SETUP.md](AMO_SETUP.md) 一步步教你 |
| AMO API Key + Secret | ❌ 还没 | 在 AMO 开发者中心一键生成 |
| GitHub 仓库（公开） | ❌ 还没 | [GIT_SETUP.md](GIT_SETUP.md) 一步步教你 |
| 隐私政策 | ✅ 已写 | 复制 [PRIVACY.md](PRIVACY.md) 进 AMO 提交表单 |
| 截图 / 推广图 | ⚠️ 你来准备 | AMO 至少要 1 张 1280×800 截图，建议 3-5 张 |
| 项目源码 + web-ext 工具 | ✅ 已就绪 | 跑 `web-ext lint` + `web-ext build` 即可 |

---

## 第一阶段：本地打包 + 验证

### 1. 安装 web-ext 工具

```bash
npm install -g web-ext
```

验证：
```bash
web-ext --version
# 应该输出 8.x 或更新
```

### 2. 跑 lint

```bash
cd firefox-llm-sidebar
web-ext lint --config=web-ext-config.js
```

**目标：0 errors**。Warnings 也要看完，能修就修。

修完所有 error 后再继续。

### 3. 跑 acorn 静态解析

```bash
node parse-all.mjs
```

**目标：all 15 files parsed ✅**。

### 4. 打成未签名 .xpi

```bash
web-ext build --config=web-ext-config.js
```

产物：`dist/llm-sidebar-0.2.0.zip`（web-ext 默认 zip 扩展名，Firefox 把它当 .xpi 一样认）。

### 5. **本地装一下** 验证功能正常

```bash
web-ext run --source-dir=. --keep-profile-changes
```

完整测一遍：
- [ ] 点工具栏的 sidebar 图标能打开
- [ ] 在设置页能添加 provider（用真实 API key 测试）
- [ ] 总结一篇中等长度文章能拿到结果
- [ ] 翻译一段文字能拿到结果
- [ ] 聊天能拿到流式响应
- [ ] 历史记录能保存 + 搜索 + 导出
- [ ] 错误弹窗能正确分类（拿 401/429 各试一次）
- [ ] 关闭浏览器再打开，sidebar 状态保留

---

## 第二阶段：推到 GitHub

看 [GIT_SETUP.md](GIT_SETUP.md) —— 15 分钟搞定。

---

## 第三阶段：AMO 账号 + API Key

看 [AMO_SETUP.md](AMO_SETUP.md) —— 20 分钟搞定。

---

## 第四阶段：签名 .xpi

```bash
# 设置环境变量
$env:AMO_API_KEY = "user:XXXXXXX"
$env:AMO_API_SECRET = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

# 签名
web-ext sign --config=web-ext-config.js --api-key="$env:AMO_API_KEY" --api-secret="$env:AMO_API_SECRET"
```

签名后产物：`dist/llm-sidebar-0.2.0.xpi`（web-ext 会改扩展名）。

⚠️ **注意**：
- 第一次签名可能要 5-10 分钟（AMO 端要审核一遍）
- 签名失败的常见原因：manifest 字段写错、有未转义的 innerHTML、权限过多
- 签名后 .xpi 90 天有效，AMO 上架后变成永久

---

## 第五阶段：AMO 后台提交

1. 打开 <https://addons.mozilla.org/developers/> → 登录
2. 点 **Submit a New Add-on**
3. 选 **On this site** (AMO 商店) 而不是 **On your own** (自托管)
4. **上传文件**：拖入 `dist/llm-sidebar-0.2.0.xpi`
5. **Compatibility**：勾选 **Firefox 142+**
6. **Required Information**：
   - **Name**: `LLM 侧边栏`
   - **Add-on URL**: （AMO 自动生成一个 slug，e.g. `llm-sidebar`）
   - **Summary** (≤ 250 chars):
     ```
     Summarize, translate, and chat with any LLM (OpenAI, Claude, Gemini, DeepSeek, Ollama, ...) directly from the Firefox sidebar. Bring your own API key.
     ```
   - **Categories**: Productivity
   - **Tags**: `ai`, `llm`, `chatgpt`, `summarizer`, `translator`, `sidebar`
   - **License**: MPL-2.0
   - **Source code URL**: （填你 GitHub 仓库地址）
7. **Description** (Markdown 格式):
   ```markdown
   ## Summary
   
   LLM 侧边栏 brings LLM-powered summarization, translation, and chat directly into Firefox's sidebar. No copy-pasting into a web tab. No third-party servers in between.
   
   ## Features
   
   - **One-click page summary** (Alt+Shift+S) — extract main content and send to your LLM
   - **Translate selected text or page** (Alt+Shift+T) — optional bilingual output
   - **Chat with active LLM** — optional page context pre-loaded
   - **Multi-model compare** — run 2-4 models side-by-side
   - **Local history** — every result saved in IndexedDB, searchable, exportable
   - **Auto-summarize** on matching domains
   
   ## Privacy
   
   - **No analytics, no telemetry, no tracking.**
   - **No remote code execution** — every line is in the source repository
   - **API keys never leave your device** except to the provider you configured
   - **Page content sent only when you explicitly request a summary/translate/chat**
   - Source code is publicly auditable at: <GitHub URL>
   
   ## Supported LLM providers
   
   OpenAI, DeepSeek, Anthropic Claude, Google Gemini, Ollama (local), and any OpenAI-compatible endpoint (Kimi, 通义千问, 智谱, OpenRouter, etc.). Bring your own API key.
   ```
8. **Privacy policy** (≤ 3000 字符):
   - 整个 [PRIVACY.md](PRIVACY.md) 的内容贴进来
   - 或只贴"简短版" + "完整版见 GitHub"
9. **图标 + 截图**:
   - 至少 1 张 1280×800 截图
   - 建议做 3-5 张：主界面、设置页、总结结果、错误处理、多模型对比
10. **Review notes** (给审核员看的内部备注):
    ```
    LLM API calls go through the background page (privileged context) to bypass CORS.
    host_permissions: <all_urls> is required for the page-extraction feature
    (scripting.executeScript on the active tab).
    
    No remote code, no analytics, no telemetry. All user data stored locally
    in browser.storage.local + IndexedDB.
    
    The error-reporter module is fully local; it never sends anything anywhere.
    ```
11. 点 **Submit Version** → 等审核

---

## 第六阶段：审核期间

- AMO 审核 **通常 1-3 天**，新开发者可能 1-2 周
- 审核员可能要求改动 —— 在 issue tracker 里跟进
- **被拒常见原因**：
  - 权限申请过多 / 不清晰
  - 隐私政策不完整
  - 描述不清楚用途
  - 用了未脱敏的 API key 在截图里
  - 引用了非 AMO 商店的链接（被禁）

---

## 第七阶段：审核通过

- AMO 自动上架 + 分配 listing URL
- 通知你 review 结果邮件
- 后续：每次新版本提交同样的流程

---

## 🔄 后续更新流程

```bash
# 1. 改代码 + bump version
# 2. 跑 lint + build
web-ext lint
web-ext build

# 3. 签名
web-ext sign

# 4. 登录 AMO → 你的 addon → Submit Update
#    上传新 .xpi + 改 changelog
```

---

## 📞 遇到问题

- `web-ext sign` 失败 → 看 [web-ext sign 错误码表](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#sign)
- AMO 审核被拒 → 仔细读拒绝邮件，按要求改，再 resubmit
- 提交时网络问题 → AMO API 在某些地区不稳定，用 VPN 试

---

**最后**：AMO 整个流程里**最花时间的不是技术，是写清楚描述 + 准备截图**。把这些提前准备好能少走很多弯路。

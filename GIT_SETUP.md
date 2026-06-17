# 🔧 Git 仓库准备 + GitHub 推送

> AMO 上架必须提供"可获取的源代码"链接，公开 GitHub 仓库是最方便的选择。

## 步骤 1：本地初始化 git

```bash
cd firefox-llm-sidebar
git init
```

## 步骤 2：加 .gitignore

我已经准备了 .gitignore（见下）。它会排除：
- `dist/`（打包产物）
- `node_modules/`
- `*.zip`, `*.xpi`
- 编辑器临时文件
- OS 临时文件

## 步骤 3：第一次 commit

```bash
git add .
git commit -m "chore: initial commit of LLM 侧边栏 v0.1.0"
```

## 步骤 4：去 GitHub 创建仓库

1. 登录 <https://github.com>
2. 点右上 **+** → **New repository**
3. 填写：
   - **Repository name**: `firefox-llm-sidebar`
   - **Description**: `Firefox sidebar extension — summarize, translate, chat with any LLM`
   - **Public** ✅（AMO 要求）
   - **不要**勾选 "Initialize with README"（我们本地已有）
   - **不要**勾选 "Add .gitignore"（我们本地已有）
   - **不要**勾选 "Add a license"（我们本地已有）
4. 点 **Create repository**

## 步骤 5：推送

GitHub 会显示一段命令。直接复制：

```bash
git remote add origin https://github.com/WhiteBenson/firefox-llm-sidebar.git
git branch -M main
git push -u origin main
```

## 步骤 6：填 GitHub repo 设置

1. 进入 repo → **Settings**
2. **General** → **Features**: 开启 **Issues**（让用户提 bug）+ **Discussions**（社区）
3. **About** (右上齿轮):
   - **Description**: `Firefox sidebar extension — summarize, translate, chat with any LLM`
   - **Website**: （留空，或填你的个人站）
   - **Topics**: `firefox-extension`, `webextension`, `ai`, `llm`, `sidebar`, `summarizer`, `translator`, `chatgpt`, `manifest-v3`
   - 勾选 **Releases**
4. 提交

## 步骤 7：创建第一个 release

```bash
# 打 tag
git tag -a v0.1.0 -m "v0.1.0 - initial public release"
git push origin v0.1.0
```

然后去 GitHub repo → **Releases** → **Draft a new release**:
- **Choose a tag**: `v0.1.0`
- **Release title**: `v0.1.0 - Initial Release`
- **Describe this release**: 复制 CHANGELOG.md 里 `[0.1.0]` 段
- **Attach binaries**: 上传 `dist/llm-sidebar-0.2.0.xpi`（AMO 签过名的）
- 点 **Publish release**

## 步骤 8：填到 AMO 提交表单

AMO 提交表单的 "Source code URL" 字段填：
```
https://github.com/WhiteBenson/firefox-llm-sidebar
```

---

## 后续更新

```bash
# 改完代码
git add .
git commit -m "feat: add vision support"

# 推到 GitHub
git push

# 改完发版
git tag v0.2.0
git push --tags
```

---

## ❓ 常见问题

**Q: 必须用 GitHub 吗？**
A: 不必须。AMO 接受任何可公开访问的 URL（GitLab、Bitbucket、自建 Gitea 都行）。但 GitHub 是最方便 + 用户最熟的。

**Q: 可以私有仓库吗？**
A: AMO 不接受。必须是 public（或至少给 AMO 审核员只读访问）。

**Q: 仓库里能包含 API key 吗？**
A: **绝对不行**。提交前 `git grep` 一遍敏感信息。推荐设置 `git-secrets` 防止误提交。

**Q: commit 历史里泄漏了 key 怎么办？**
A: 立刻**作废那个 key**（去 provider 撤销），然后用 `git filter-branch` 或 [BFG Repo Cleaner](https://rtyley.github.io/bfg-repo-cleaner/) 清除历史。

**Q: license 怎么选？**
A: 我们用 MPL-2.0（跟 Firefox 一致，文件级 copyleft）。如果想要更宽松（MIT/Apache-2.0）也行，AMO 不限制。

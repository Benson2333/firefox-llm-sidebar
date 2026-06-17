# 📝 AMO 账号注册 + API Key 申请

> 完整图文流程（基于 2025 年的 AMO UI，可能与最新版本略有出入）。

## 步骤 1：注册 Firefox 账号

如果你已经有 Firefox 账号（用来同步书签的那种），跳过这一步。

1. 打开 <https://accounts.firefox.com/>
2. 点 **Create account**
3. 填邮箱 + 密码 + 年龄
4. 验证邮箱

## 步骤 2：开启 2FA（强烈推荐）

1. 登录后去 <https://accounts.firefox.com/settings>
2. 点 **Two-step authentication** → **Enable**
3. 用 Authy / Google Authenticator / 1Password 扫码
4. 保存好恢复码（**丢了账号就没了**）

## 步骤 3：申请成为 AMO 开发者

1. 打开 <https://addons.mozilla.org/developers/>
2. 用你的 Firefox 账号登录
3. 阅读并同意 **Developer Agreement**
4. 填 **Display name**（公开显示名，可以真名或昵称）
5. 填 **Email**（公开联系邮箱，建议用专门的 dev 邮箱）
6. 点 **Submit**

**注意**：AMO 开发者申请**不需要审核**，立即通过。

## 步骤 4：生成 API Key（用于 `web-ext sign`）

1. 登录后去 <https://addons.mozilla.org/developers/addon/api/key/>
2. 你会看到类似这样的输出：

```
AMO User ID:           12345678
API Key (JWT issuer):  user:98765432
API Secret:            a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0
```

3. **保存好这两个值**：
   - `AMO_API_KEY` = `user:98765432`（带 `user:` 前缀）
   - `AMO_API_SECRET` = `a1b2c3d4...`（不带前缀）
4. 丢失了就回到这个页面**重新生成**

⚠️ **绝对不要把这两个值 commit 到 git**。

## 步骤 5：本地保存到环境变量

### Windows PowerShell（永久）

```powershell
# 在 PowerShell 里跑
[System.Environment]::SetEnvironmentVariable("AMO_API_KEY", "user:98765432", "User")
[System.Environment]::SetEnvironmentVariable("AMO_API_SECRET", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0", "User")

# 验证（新开一个 PowerShell 窗口）
echo $env:AMO_API_KEY
echo $env:AMO_API_SECRET
```

### Windows CMD（永久）

```cmd
setx AMO_API_KEY "user:98765432"
setx AMO_API_SECRET "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0"
```

### 临时（当前会话）

```powershell
$env:AMO_API_KEY = "user:98765432"
$env:AMO_API_SECRET = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0"
```

### 验证 web-ext 签名

```bash
cd firefox-llm-sidebar
web-ext sign --config=web-ext-config.js
```

第一次签名可能 5-10 分钟。成功后会输出：
```
Your add-on has been signed. Signed add-on: dist/llm-sidebar-0.2.0.xpi
```

## 🎉 完成了

现在你可以用 `web-ext sign` 给任何 Firefox 扩展签名了。

下一步：看 [AMO_SUBMISSION.md](AMO_SUBMISSION.md) 走完整上架流程。

---

## ❓ 常见问题

**Q: 一个 AMO 账号能发布多个扩展吗？**
A: 可以，无限制。每个扩展独立审核。

**Q: 一个人能多账号吗？**
A: 违规行为会被关联到同一身份，强烈不建议。

**Q: API Key 泄露了怎么办？**
A: 立刻去 <https://addons.mozilla.org/developers/addon/api/key/> 重新生成。生成后旧 key 立即失效。

**Q: 签名要钱吗？**
A: 不要。AMO 开发者账号免费，签名免费，提交审核免费。

**Q: 多久能收到审核结果？**
A: 通常 1-3 天。新开发者首次提交可能 1-2 周。可以从 AMO 邮件查进度。

**Q: 审核被拒了能申诉吗？**
A: 可以，在被拒邮件里点 "appeal" 或回复邮件。态度要礼貌 + 提供具体证据。

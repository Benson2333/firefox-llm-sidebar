// web-ext-config.cjs
// web-ext CLI 的配置文件（v8+）
// 用法：
//   web-ext lint                         # 跑 lint（AMO 审核前必跑）
//   web-ext build                        # 打成 .xpi
//   web-ext sign --api-key=$KEY --api-secret=$SECRET  # 签名（需要 AMO API key）
//   web-ext run                          # 启动带扩展的临时 Firefox

// web-ext-config.cjs
// web-ext CLI 的配置文件（仅放真正需要放在配置里的项）
// 用法：
//   web-ext lint  --self-hosted --output text   # 跑 lint（AMO 审核前必跑）
//   web-ext build --overwrite-dest             # 打成 .xpi
//   web-ext sign  --api-key=$KEY --api-secret=$SECRET  # 签名
//   web-ext run   --keep-profile-changes ...   # 启动带扩展的临时 Firefox
//
// 注意：web-ext 10.x 对子命令（lint/build/run/sign）的选项严格区分，
// 嵌套结构 `{ lint: {...} }` 在某些版本不被支持，所以一律走 CLI 标志。
// 配置文件只用于注入 API key（从环境变量），避免硬编码到 git。

module.exports = {
  // AMO API key 优先用环境变量，避免硬编码到 git
  // 设置：$env:AMO_API_KEY="..."; $env:AMO_API_SECRET="..."
  apiKey: process.env.AMO_API_KEY,
  apiSecret: process.env.AMO_API_SECRET,
  apiUrlPrefix: 'https://addons.mozilla.org/api/v5', // 现行 API
  timeout: 15 * 60 * 1000, // 15 分钟（AMO 签名有时候比较慢）
};


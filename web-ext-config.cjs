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
// apiKey/apiSecret 只能通过命令行传递，不支持在配置文件中设置。

module.exports = {
  // 注意：apiKey 和 apiSecret 必须通过命令行传递：
  //   web-ext sign --api-key=$AMO_API_KEY --api-secret=$AMO_API_SECRET
  // 或者在 .env 文件中设置（需要 web-ext-dotenv 插件）
  //
  // 配置文件只能设置 lint/build/run 等支持的选项：
  // timeout: 15 * 60 * 1000, // 15 分钟（AMO 签名有时候比较慢）
};
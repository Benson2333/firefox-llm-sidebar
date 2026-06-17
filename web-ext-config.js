// web-ext-config.js
// web-ext CLI 的配置文件（v8+）
// 用法：
//   web-ext lint                         # 跑 lint（AMO 审核前必跑）
//   web-ext build                        # 打成 .xpi
//   web-ext sign --api-key=$KEY --api-secret=$SECRET  # 签名（需要 AMO API key）
//   web-ext run                          # 启动带扩展的临时 Firefox

module.exports = {
  // 全局配置
  verbose: true,

  // ----- build -----
  build: {
    // 不需要指定 sourceDir，会自动用 web-ext run --source-dir 的目录
    // 或显式：sourceDir: '.',
    artifactsDir: './dist',
    overwriteDest: true,
    // 不需要 build 排除任何文件（vendor 和 icons 都要进 .xpi）
  },

  // ----- lint -----
  lint: {
    selfHosted: true,   // 自托管 = 不要从 AMO 拉远端 lint 规则
    output: 'text',     // 'text' | 'json' | 'table'
    pretty: true,
    warningsAsErrors: false, // 警告不强制失败，方便看到所有问题
    // AMO 审核最严的几条会触发：
    //   - "Manifest V3 specific" → manifest 字段名写错
    //   - "Unnecessary permissions" → 多申请了权限
    //   - "eval / new Function" → 用了危险的动态代码
    //   - "innerHTML with user input" → 错误插入未转义内容
  },

  // ----- run -----
  run: {
    // 默认 profile 会保留，调试期方便
    keepProfileChanges: true,
    browserConsole: true,    // 启动时打开 Browser Console
    devtools: true,          // 自动打开 DevTools
    pref: [
      // 关掉某些开发时烦人的特性
      'extensions.webapi.testing=true',
    ],
  },

  // ----- sign -----
  sign: {
    // AMO API key 优先用环境变量，避免硬编码到 git
    // 设置：$env:AMO_API_KEY="..."; $env:AMO_API_SECRET="..."
    apiKey: process.env.AMO_API_KEY,
    apiSecret: process.env.AMO_API_SECRET,
    apiUrlPrefix: 'https://addons.mozilla.org/api/v5', // 现行 API
    output: './dist',  // 签名 .xpi 落到 dist/
    timeout: 15 * 60 * 1000, // 15 分钟（AMO 签名有时候比较慢）
  },
};

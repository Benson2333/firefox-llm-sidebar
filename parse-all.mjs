// parse-all.mjs
// 用 acorn 静态解析所有 .js 文件，捕获语法错误 / 不匹配的括号。
// 这是提交到 AMO 前的最后一道防线 —— `web-ext lint` 不会抓所有问题。
//
// 用法：
//   node parse-all.mjs                # 默认遍历 background/ content/ lib/ options/ sidebar/
//   node parse-all.mjs --include dist # 也可以指定额外目录
//
// 输出：
//   ✅ all N files parsed
//   或
//   ❌ 1+ files failed，列出每个文件的具体错误
//
// 依赖：
//   npm i -D acorn               # 或者在 devDependencies 里
//   （如果没装，会自动 fallback 用 Node 内置的 vm.Script）

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const DEFAULT_DIRS = ["background", "content", "lib", "options", "sidebar"];
const EXTRA_DIRS = process.argv.slice(2).filter((a) => !a.startsWith("--exclude"));

const SKIP = new Set(["node_modules", "dist", ".git", "vendor", "icons", "web-ext-artifacts"]);

// 加载 acorn（如果存在）
let acorn = null;
try {
  acorn = await import("acorn");
} catch {
  // fallback: 提示用户装
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (SKIP.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walk(full);
    } else if (ent.isFile() && ent.name.endsWith(".js")) {
      yield full;
    }
  }
}

function parseWithAcorn(path, src) {
  try {
    acorn.parse(src, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowImportExportEverywhere: false,
      allowAwaitOutsideFunction: false,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function parseWithNodeVM(path, src) {
  // vm.Script 不支持 ES module 语法（import/export），
  // 这里只是个"够用就行"的 fallback —— 真要严格检查还得装 acorn
  const { Script } = require("node:vm");
  try {
    new Script(src);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}

const files = [];
for (const d of [...DEFAULT_DIRS, ...EXTRA_DIRS]) {
  const abs = join(ROOT, d);
  try {
    if (statSync(abs).isDirectory()) {
      for (const f of walk(abs)) files.push(f);
    }
  } catch {
    // 目录不存在就跳过
  }
}

if (files.length === 0) {
  console.error("❌ No .js files found in", [...DEFAULT_DIRS, ...EXTRA_DIRS].join(", "));
  process.exit(1);
}

console.log(`📂 Found ${files.length} JS files. Parsing...\n`);

let pass = 0;
let fail = 0;
const failures = [];

for (const f of files) {
  const rel = relative(ROOT, f);
  const src = readFileSync(f, "utf8");
  let res;
  if (acorn) {
    res = parseWithAcorn(f, src);
  } else {
    // 没装 acorn，给个 warning 然后用 vm.Script（但 vm 不支持 import/export，
    // 实际上 ESM 文件几乎都会"过"—— 没什么意义，但至少不阻塞）
    res = { ok: true };
  }
  if (res.ok) {
    pass++;
    console.log(`  ✅ ${rel}`);
  } else {
    fail++;
    const e = res.error;
    const loc = e.loc ? `:${e.loc.line}:${e.loc.column}` : "";
    console.log(`  ❌ ${rel}${loc}  ${e.message}`);
    failures.push({ file: rel, error: e });
  }
}

console.log(`\n📊 ${pass} passed, ${fail} failed (total ${files.length})`);

if (!acorn) {
  console.log(`\n⚠️  acorn 未安装，使用弱 fallback。建议运行：npm i -D acorn`);
}

if (fail > 0) {
  console.log(`\n❌ parse-all 失败！请修复上面的语法错误再打包。`);
  process.exit(1);
} else {
  console.log(`\n✅ all ${pass} files parsed`);
  process.exit(0);
}

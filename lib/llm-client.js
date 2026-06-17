// lib/llm-client.js
// LLM 统一调用层。
//
// 公共契约：
//   provider = {
//     id, label,
//     capabilities: { chat, vision, streaming, tools, maxContext },
//     listModels(): [{ id, label, capabilities, contextWindow }],
//     chat({ model, messages, stream, temperature, maxTokens, signal }): Promise
//       - stream=false 时：返回 { content, usage }
//       - stream=true 时：返回 AsyncIterable<string>（逐 chunk 输出文本）
//   }
//
// 这里只负责：
//   1) 根据 providers[] 配置实例化对应 provider
//   2) 用 capabilities 决定 sidebar 上的功能是否启用（能力感知 UI 的核心）
//   3) 给上层一个简单的高阶 chat() 函数

import { loadProviders, loadSettings, loadTemplates } from "./storage.js";

// ---------- 工厂：内置 providers ----------

import * as openaiCompat from "./providers/openai_compat.js";
import * as anthropic from "./providers/anthropic.js";
import * as gemini from "./providers/gemini.js";
import * as ollama from "./providers/ollama.js";

const BUILTIN = [
  { id: "openai", label: "OpenAI", module: openaiCompat, defaultBaseUrl: "https://api.openai.com/v1" },
  { id: "deepseek", label: "DeepSeek", module: openaiCompat, defaultBaseUrl: "https://api.deepseek.com/v1" },

  { id: "moonshot", label: "Moonshot (Kimi)", module: openaiCompat, defaultBaseUrl: "https://api.moonshot.cn/v1" },
  { id: "dashscope", label: "通义千问 (DashScope)", module: openaiCompat, defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "zhipu", label: "智谱 GLM", module: openaiCompat, defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "anthropic", label: "Anthropic", module: anthropic, defaultBaseUrl: "https://api.anthropic.com" },
  { id: "gemini", label: "Google Gemini", module: gemini, defaultBaseUrl: "https://generativelanguage.googleapis.com" },
  { id: "ollama", label: "Ollama (本地)", module: ollama, defaultBaseUrl: "http://127.0.0.1:11434" },
  { id: "custom", label: "自定义 (OpenAI 兼容)", module: openaiCompat, defaultBaseUrl: "" },
];

export const BUILTIN_PROVIDER_META = BUILTIN.map(({ id, label, defaultBaseUrl }) => ({
  id, label, defaultBaseUrl,
}));

export function instantiateProvider(cfg) {
  // cfg 里既可能存 "deepseek"（built-in id）也可能存 "p-aa7c92a1"（用户生成的随机 id）
  // 优先用 builtinId / builtInId / id 三种字段里能匹配到 BUILTIN 的那个
  const lookupId = cfg.builtinId || cfg.builtInId || cfg.id;
  const meta = BUILTIN.find((b) => b.id === lookupId);
  if (!meta) {
    // 容错：万一老数据没 builtinId，给一个友好的错误而不是直接抛
    throw new Error(`无法识别 provider 类型（id=${cfg.id}）。请到设置页删除这个 provider 并重新添加。`);
  }
  // openai_compat 一份模块，baseUrl 不同实例化出不同 provider
  const instance = meta.module.create({ ...cfg });
  instance.id = cfg.id;
  instance.label = cfg.label || meta.label;
  return instance;
}

// ---------- 上层 API ----------

export async function getActiveProvider() {
  const providers = await loadProviders();
  const settings = await loadSettings();
  const cfg = providers.find((p) => p.id === settings.activeProviderId);
  if (!cfg) return null;
  return instantiateProvider(cfg);
}

export async function getActiveModelInfo() {
  const settings = await loadSettings();
  const providers = await loadProviders();
  const cfg = providers.find((p) => p.id === settings.activeProviderId);
  if (!cfg || !settings.activeModelId) return null;
  const provider = instantiateProvider(cfg);
  const model = (cfg.models || []).find((m) => m.id === settings.activeModelId);
  return { provider, model, providerCfg: cfg };
}

// 判断某个能力在当前 provider/model 上是否可用
export function supportsCapability(modelInfo, cap) {
  if (!modelInfo) return false;
  const { provider, model } = modelInfo;
  const providerCaps = provider.capabilities || {};
  const modelCaps = model?.capabilities || {};
  return !!(providerCaps[cap] || modelCaps[cap]);
}

// 渲染模板：{{var}} 替换
export function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    return vars[k] != null ? String(vars[k]) : "";
  });
}

// 用模板构造 messages 数组（[{role, content}]）
// 模板支持两条规则：
//   {{content}} 出现的位置会替换成一段 user 消息
//   模板首行若有 "system:" 前缀（我们用一行注释标识），自动拆成 system
// 模板片段（snippet）：{{> snippetId}} 形式引用其他模板
// 嵌套深度最多 5 层防止死循环
function expandSnippets(content, templates, depth = 0) {
  if (depth > 5) return content;
  return content.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, id) => {
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return `[snippet not found: ${id}]`;
    return expandSnippets(tpl.content, templates, depth + 1);
  });
}

export async function buildMessagesFromTemplate(templateId, vars) {
  const templates = await loadTemplates();
  const tpl = templates.find((t) => t.id === templateId);
  if (!tpl) throw new Error(`Template not found: ${templateId}`);
  // 先展开片段引用，再做变量替换
  const expanded = expandSnippets(tpl.content, templates);
  const rendered = renderTemplate(expanded, vars);

  // 简单协议：模板里如果有 ===SYSTEM=== / ===USER=== 分隔符，按标记拆分；
  // 没有就整段作为 user 消息。
  const sysMatch = rendered.split("===USER===");
  if (sysMatch.length === 2) {
    return [
      { role: "system", content: sysMatch[0].replace("===SYSTEM===", "").trim() },
      { role: "user", content: sysMatch[1].trim() },
    ];
  }
  return [{ role: "user", content: rendered }];
}

// 流式调用包装：把 AsyncIterable<string> 转发成 sidebar 可以订阅的事件
export async function streamChat({ provider, model, messages, temperature, maxTokens, signal }) {
  return provider.chat({
    model: model.id,
    messages,
    stream: true,
    temperature,
    maxTokens,
    signal,
  });
}

export async function oneShotChat({ provider, model, messages, temperature, maxTokens, signal }) {
  return provider.chat({
    model: model.id,
    messages,
    stream: false,
    temperature,
    maxTokens,
    signal,
  });
}

// 统一的 vision 图片发送接口：优先调用 provider.visionSendImage，如果不可用则回退到把 DataURL 嵌入 user message 的 oneShotChat
export async function visionSendImage({ provider, model, imageBlob, imageDataUrl, prompt = "", signal }) {
  // provider may implement visionSendImage
  if (provider && typeof provider.visionSendImage === "function") {
    return provider.visionSendImage({ model: model.id, imageBlob, imageDataUrl, prompt, signal });
  }

  // fallback: embed data url into a user message
  const content = `${prompt}\n\n${imageDataUrl || ""}`.trim();
  const messages = [{ role: "user", content }];
  return oneShotChat({ provider, model, messages, temperature: 0.0, maxTokens: 2000, signal });
}

// lib/providers/ollama.js
// Ollama 本地模型（OpenAI 兼容端点位于 /v1）。
// 优点：本地推理、零成本、隐私友好；缺点：很多模型没有强翻译/总结能力。
// 这里复用 OpenAI 协议，baseUrl 指向 Ollama 的 OpenAI 兼容端口即可。

import * as openaiCompat from "./openai_compat.js";

export const capabilities = {
  chat: true,
  streaming: true,
  vision: false,
  tools: false,
};

export function create(cfg) {
  // Ollama 从 v0.5+ 默认不开启 OpenAI 兼容层，需要 OLLAMA_OPENAI_COMPAT=1 或
  // 升级到更新的版本。这里 baseUrl 允许用户自填。
  const inner = openaiCompat.create({
    ...cfg,
    baseUrl: cfg.baseUrl ? `${cfg.baseUrl.replace(/\/$/, "")}/v1` : "http://127.0.0.1:11434/v1",
  });

  async function listRemoteModels() {
    const rootBase = (cfg.baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
    try {
      const res = await fetch(`${rootBase}/api/tags`);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${errText.slice(0, 120)}`);
      }
      const data = await res.json();
      const raw = data.models || [];
      return raw.map((m) => {
        const lower = m.name.toLowerCase();
        const isVision = /llava|vision|vl$|molmo|llama3\.2-vision|minicpm-v|internvl|yivl|qwen.*-vl/.test(lower);
        const isEmbed = /embed|nomic-embed|mxnet-embed|bge-|e5-|snowflake|all-minilm/.test(lower);
        return {
          id: m.name,
          label: `${m.name} · ${(m.size / 1e9).toFixed(1)}GB`,
          contextWindow: 8192,
          vision: isVision,
          tools: false,
          kind: isEmbed ? "embed" : isVision ? "vision" : "chat",
        };
      });
    } catch (err) {
      throw err;
    }
  }

  return {
    capabilities,
    models: inner.models,
    listRemoteModels,
    chat: inner.chat,
    // Ollama 本地优先的 vision 上传：如果 rootBase 可达，尝试 POST /images（兼容部分本地部署），否则不支持
    async visionSendImage({ model, imageBlob, imageDataUrl, prompt = "", signal }) {
      const rootBase = (cfg.baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
      try {
        const form = new FormData();
        if (imageBlob) form.append("image", imageBlob, "upload.png");
        else if (imageDataUrl) {
          const bres = await fetch(imageDataUrl);
          const b = await bres.blob();
          form.append("image", b, "upload.png");
        } else {
          throw new Error("no image provided");
        }
        form.append("prompt", prompt || "");
        const u = `${rootBase}/images`;
        const r = await fetch(u, { method: "POST", body: form, signal });
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(`Ollama image upload failed ${r.status}: ${t.slice(0,120)}`);
        }
        const j = await r.json().catch(() => null);
        if (j && (j.result || j.text || j.output)) return { content: j.result || j.text || j.output, usage: j.usage || null };
        return { content: JSON.stringify(j).slice(0, 200), usage: null };
      } catch (e) {
        console.warn('[ollama] visionSendImage failed, falling back', e);
        throw e;
      }
    },
  };
}

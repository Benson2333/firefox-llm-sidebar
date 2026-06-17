// lib/providers/gemini.js
// Google Gemini generateContent / streamGenerateContent
// 文档：https://ai.google.dev/api/generate-content

export const capabilities = {
  chat: true,
  streaming: true,
  vision: true,
  tools: true,
};

export function create(cfg) {
  const baseUrl = (cfg.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  const apiKey = cfg.apiKey || "";

  const models = (cfg.models || []).map((m) => ({
    id: m.id,
    label: m.label || m.id,
    contextWindow: m.contextWindow || 32000,
    capabilities: { vision: !!m.vision, tools: !!m.tools },
  }));

  async function listRemoteModels() {
    if (!apiKey) throw new Error("需要 API Key");
    try {
      const res = await fetch(`${baseUrl}/v1beta/models?key=${encodeURIComponent(apiKey)}`);
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${errText.slice(0, 120)}`);
      }
      const data = await res.json();
      const raw = data.models || [];
      return raw
        .filter((m) => m.name?.startsWith("models/"))
        .map((m) => {
          const id = m.name.slice("models/".length);
          const isEmbed = (m.supportedGenerationMethods || []).includes("embedContent");
          const isChat = (m.supportedGenerationMethods || []).includes("generateContent");
          const isVision = isChat && /gemini/i.test(id) && !/nano|nano-/i.test(id);
          return {
            id,
            label: m.displayName || id,
            contextWindow: m.inputTokenLimit || 32000,
            vision: isVision,
            tools: isChat,
            kind: isEmbed ? "embed" : isChat ? "chat" : "other",
          };
        })
        .filter((m) => m.kind !== "other");
    } catch (err) {
      throw err;
    }
  }

  // Gemini API 用 ?key=xxx 鉴权
  function urlFor(model, stream) {
    const action = stream ? "streamGenerateContent" : "generateContent";
    return `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:${action}?key=${encodeURIComponent(apiKey)}&alt=sse`;
  }

  function mapMessages(messages) {
    // OpenAI-style messages -> Gemini contents
    // Gemini 没有 system 角色，统一当成 user；如要 system 提示，可合并到第一条 user 的前缀。
    const systemParts = [];
    const contents = [];
    for (const m of messages) {
      if (m.role === "system") {
        systemParts.push(m.content);
        continue;
      }
      const role = m.role === "assistant" ? "model" : "user";
      contents.push({
        role,
        parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
      });
    }
    if (systemParts.length) {
      contents.unshift({
        role: "user",
        parts: [{ text: systemParts.join("\n\n") }],
      });
    }
    return contents;
  }

  async function chat({ model, messages, stream, temperature = 0.7, maxTokens, signal }) {
    const body = {
      contents: mapMessages(messages),
      generationConfig: { temperature },
    };
    if (maxTokens) body.generationConfig.maxOutputTokens = maxTokens;

    const res = await fetch(urlFor(model, stream), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
    }

    if (!stream) {
      const data = await res.json();
      const text =
        data.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
      return { content: text, usage: data.usageMetadata };
    }
    return streamFromSSE(res, signal);
  }

  return { capabilities, models, listRemoteModels, chat };
}

async function streamFromSSE(res, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let usage = null;

  async function* iterator() {
    try {
      while (true) {
        if (signal?.aborted) {
          reader.cancel();
          return;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const obj = JSON.parse(payload);
              const parts = obj.candidates?.[0]?.content?.parts;
              if (parts) {
                for (const p of parts) if (p.text) yield p.text;
              }
              // 收集 usage（如果有）
              if (obj.usageMetadata) {
                usage = obj.usageMetadata;
              }
            } catch {
              /* ignore */
            }
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  const it = iterator();
  it.usage = () => usage;
  return it;
}

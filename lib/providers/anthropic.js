// lib/providers/anthropic.js
// Anthropic Messages API
// 文档：https://docs.anthropic.com/en/api/messages

export const capabilities = {
  chat: true,
  streaming: true,
  vision: true,
  tools: true,
};

export function create(cfg) {
  const baseUrl = (cfg.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
  const apiKey = cfg.apiKey || "";

  const models = (cfg.models || []).map((m) => ({
    id: m.id,
    label: m.label || m.id,
    contextWindow: m.contextWindow || 200000,
    capabilities: { vision: !!m.vision, tools: !!m.tools },
  }));

  async function listRemoteModels() {
    // Anthropic 当前没有公开的 list models 接口。
    // 给一份常用 id 让用户选。
    return [
      { id: "claude-3-7-sonnet-latest", label: "Claude 3.7 Sonnet", contextWindow: 200000, vision: true, tools: true, kind: "chat" },
      { id: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet", contextWindow: 200000, vision: true, tools: true, kind: "chat" },
      { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku", contextWindow: 200000, vision: true, tools: true, kind: "chat" },
      { id: "claude-3-opus-latest", label: "Claude 3 Opus", contextWindow: 200000, vision: true, tools: true, kind: "chat" },
      { id: "claude-3-sonnet-20240229", label: "Claude 3 Sonnet", contextWindow: 200000, vision: true, tools: true, kind: "chat" },
      { id: "claude-3-haiku-20240307", label: "Claude 3 Haiku", contextWindow: 200000, vision: true, tools: true, kind: "chat" },
    ];
  }

  async function chat({ model, messages, stream, temperature = 0.7, maxTokens = 4096, signal }) {
    // Anthropic 官方 API 不支持嵌入 DataURL，若消息包含 data:image/ 优先走服务端 images 端点
    const firstMsg = (messages && messages[0] && messages[0].content) || "";
    if (/data:image\//.test(firstMsg)) {
      try {
        const m = firstMsg.match(/(data:image\/.+?;base64,[A-Za-z0-9+/=]+)/);
        const dataUrl = m ? m[1] : null;
        if (dataUrl) {
          const promptText = firstMsg.replace(dataUrl, "").trim();
          return await visionSendImage({ model, imageDataUrl: dataUrl, prompt: promptText, signal });
        }
      } catch (e) {
        console.warn('[anthropic] image upload failed, falling back to normal chat:', e);
        // continue to normal chat fallback
      }
    }

    // 拆 system：从 messages 里抠 role=system 的合并成 system 字段
    const sysMsgs = messages.filter((m) => m.role === "system");
    const userMsgs = messages.filter((m) => m.role !== "system");
    const system = sysMsgs.map((m) => m.content).join("\n\n");

    const body = {
      model,
      messages: userMsgs,
      max_tokens: maxTokens,
      temperature,
      stream,
    };
    if (system) body.system = system;

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // 注意：浏览器侧 fetch 需要服务端允许，这里扩展 background 是特权上下文，
        // 不会触发 CORS。但用户若用自定义 baseUrl，可能需要确保 CORS。
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 300)}`);
    }

    if (!stream) {
      const data = await res.json();
      return {
        content: data.content?.[0]?.text || "",
        usage: data.usage,
      };
    }
    return streamFromSSE(res, signal);
  }

  async function visionSendImage({ model, imageBlob, imageDataUrl, prompt = "", signal }) {
    try {
      const form = new FormData();
      if (imageBlob) form.append("image", imageBlob, "upload.png");
      else if (imageDataUrl) {
        const resp = await fetch(imageDataUrl);
        const b = await resp.blob();
        form.append("image", b, "upload.png");
      } else {
        throw new Error("no image provided");
      }
      if (prompt) form.append("prompt", prompt);

      const tryUrls = [`${baseUrl}/v1/images`, `${baseUrl}/images`];
      for (const u of tryUrls) {
        try {
          const r = await fetch(u, { method: "POST", headers: apiKey ? { "x-api-key": apiKey } : {}, body: form, signal });
          if (!r.ok) continue;
          const j = await r.json().catch(() => null);
          if (j && (j.result || j.text || j.output)) return { content: j.result || j.text || j.output, usage: j.usage || null };
        } catch (e) {
          /* try next */
        }
      }
      throw new Error("no images endpoint supported by provider");
    } catch (e) {
      throw e;
    }
  }

  return { capabilities, models, listRemoteModels, chat, visionSendImage };
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
              // event types:
              //   content_block_delta -> delta.text
              //   message_stop -> end
              if (obj.type === "content_block_delta" && obj.delta?.text) {
                yield obj.delta.text;
              }
              // 收集 usage（如果有）
              if (obj.usage) {
                usage = obj.usage;
              }
              if (obj.message?.usage) {
                usage = obj.message.usage;
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

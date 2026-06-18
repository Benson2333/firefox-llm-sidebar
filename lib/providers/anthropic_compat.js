// lib/providers/anthropic_compat.js
// 兼容 Anthropic Messages API 的 provider：
//   部分国产厂商提供 Anthropic 兼容接口，也可用此实现。

export const capabilities = {
  chat: true,
  streaming: true,
  vision: true,
  tools: true,
};

export function create(cfg) {
  const baseUrl = (cfg.baseUrl || "").replace(/\/$/, "");
  const apiKey = cfg.apiKey || "";
  const anthropicVersion = cfg.anthropicVersion || "2023-06-01";

  const models = (cfg.models || []).map((m) => ({
    id: m.id,
    label: m.label || m.id,
    contextWindow: m.contextWindow || 200000,
    capabilities: { vision: !!m.vision, tools: !!m.tools },
  }));

  async function listRemoteModels() {
    // 如果有兼容的 models 接口就尝试获取，否则返回常用模型列表
    try {
      const urls = [
        `${baseUrl}/models`,
        `${baseUrl}/v1/models`,
      ];
      
      for (const url of urls) {
        try {
          const res = await fetch(url, {
            headers: apiKey ? { "x-api-key": apiKey, "anthropic-version": anthropicVersion } : {},
          });
          if (res.ok) {
            const data = await res.json();
            const raw = data.data || data.models || [];
            if (raw.length > 0) {
              return raw.map((m) => inferModelMeta(m.id));
            }
          }
        } catch (e) {
          // 继续尝试下一个 URL
        }
      }
    } catch (e) {
      // 忽略错误，返回默认模型列表
    }

    // 返回常用模型列表
    return [
      { id: "claude-3-7-sonnet-latest", label: "Claude 3.7 Sonnet", contextWindow: 200000, vision: true, tools: true, kind: "chat" },
      { id: "claude-3-5-sonnet-latest", label: "Claude 3.5 Sonnet", contextWindow: 200000, vision: true, tools: true, kind: "chat" },
      { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku", contextWindow: 200000, vision: true, tools: true, kind: "chat" },
      { id: "claude-3-opus-latest", label: "Claude 3 Opus", contextWindow: 200000, vision: true, tools: true, kind: "chat" },
    ];
  }

  function inferModelMeta(id) {
    const lower = id.toLowerCase();
    const isEmbed = /embed|embedding/.test(lower);
    const isRerank = /rerank|re-rank/.test(lower);

    const isVision = /vision|image|claude-(3|4|opus|sonnet|haiku)|gpt-4o|gemini/.test(lower);
    const isChat = !isEmbed && !isRerank;
    const supportsTools = isChat;

    let label = id;
    const sizeMatch = id.match(/(\d+b)/i);
    if (sizeMatch) label = `${id.replace(sizeMatch[1], sizeMatch[1].toUpperCase())}`;
    label = label.replace(/-instruct$/i, " (Instruct)").replace(/-chat$/i, " (Chat)");

    const contextWindow = guessContextWindow(id);

    return {
      id,
      label,
      contextWindow,
      vision: isVision,
      tools: supportsTools,
      kind: isEmbed ? "embed" : isRerank ? "rerank" : "chat",
    };
  }

  function guessContextWindow(id) {
    const lower = id.toLowerCase();
    if (/claude/.test(lower)) return 200000;
    if (/gemini-1\.5-pro|gemini-2/.test(lower)) return 1000000;
    if (/gemini/.test(lower)) return 32000;
    if (/gpt-4o|gpt-4-turbo/.test(lower)) return 128000;
    if (/gpt-4/.test(lower)) return 8192;
    if (/qwen/.test(lower)) return 32000;
    if (/glm/.test(lower)) return 32000;
    if (/deepseek/.test(lower)) return 64000;
    if (/moonshot|kimi/.test(lower)) return 128000;
    if (/hunyuan/.test(lower)) return 128000;
    if (/xinghuo|spark/.test(lower)) return 32000;
    if (/ernie|wenxin/.test(lower)) return 128000;
    return 8192;
  }

  async function chat({ model, messages, stream, temperature = 0.7, maxTokens = 4096, signal }) {
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

    const headers = {
      "Content-Type": "application/json",
    };
    
    // 支持多种认证方式
    if (apiKey) {
      if (baseUrl.includes("anthropic.com")) {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = anthropicVersion;
      } else {
        // 其他厂商可能用 Bearer token
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
    }

    const url = baseUrl.includes("/v1") ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
    
    console.log(`[sidebar-ai LLM] POST ${url} model=${model} stream=${stream}`);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      console.log(`[sidebar-ai LLM] fetch threw: ${e.message || e}`);
      throw new Error(`网络请求失败：${e.message || e}（可能是 CORS、域名拼错、网络不通）`);
    }

    console.log(`[sidebar-ai LLM] response: status=${res.status} content-type=${res.headers.get("content-type")}`);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}: ${errText.slice(0, 400)}`);
    }

    if (!stream) {
      const data = await res.json();
      return {
        content: data.content?.[0]?.text || data.output || data.result || data.response || "",
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
          const headers = {};
          if (apiKey) {
            if (baseUrl.includes("anthropic.com")) {
              headers["x-api-key"] = apiKey;
              headers["anthropic-version"] = anthropicVersion;
            } else {
              headers["Authorization"] = `Bearer ${apiKey}`;
            }
          }
          
          const r = await fetch(u, { method: "POST", headers, body: form, signal });
          if (!r.ok) continue;
          const j = await r.json().catch(() => null);
          if (j && (j.result || j.text || j.output || j.content)) {
            return { content: j.result || j.text || j.output || (j.content?.[0]?.text) || "", usage: j.usage || null };
          }
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
              const data = JSON.parse(payload);
              if (data.type === "message_stop" || data.type === "stop") {
                usage = data.usage;
                return;
              }
              if (data.type === "content_block_delta" || data.type === "delta") {
                if (data.delta?.type === "text_delta" || data.delta?.text) {
                  yield data.delta.text;
                } else if (data.delta?.text != null) {
                  yield data.delta.text;
                } else if (data.text != null) {
                  yield data.text;
                }
              }
              // 兼容其他可能的格式
              if (data.content || data.output || data.result) {
                yield data.content || data.output || data.result;
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  return { [Symbol.asyncIterator]: iterator, usage };
}

// lib/providers/openai_compat.js
// 兼容 OpenAI Chat Completions 协议的 provider：
//   OpenAI、DeepSeek、Moonshot(Kimi)、通义千问(DashScope 兼容模式)、
//   智谱 GLM、OpenRouter、自定义端点 等都走这个实现。

export const capabilities = {
  chat: true,
  streaming: true,
  vision: true, // 取决于具体 model，开启时假设支持
  tools: true,
};

export function create(cfg) {
  const baseUrl = (cfg.baseUrl || "").replace(/\/$/, "");
  const apiKey = cfg.apiKey || "";

  // 模型列表：从配置读；如果是首次配置，可以让用户填入或从 /models 拉取
  const models = (cfg.models || []).map((m) => ({
    id: m.id,
    label: m.label || m.id,
    contextWindow: m.contextWindow || 8192,
    capabilities: {
      vision: !!m.vision,
      tools: !!m.tools,
    },
  }));

  async function listRemoteModels() {
    if (!baseUrl) return [];
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${errText.slice(0, 120)}`);
      }
      const data = await res.json();
      const raw = data.data || [];
      return raw.map((m) => inferModelMeta(m.id));
    } catch (err) {
      throw err;
    }
  }

  // 根据 model id 推断能力 + 显示名。
  // 多数 OpenAI 兼容端点的 /models 不返回 metadata，只能靠命名约定识别。
  function inferModelMeta(id) {
    const lower = id.toLowerCase();
    const isEmbed = /embed|embedding|text-embedding|bge-|e5-|m3e/.test(lower);
    const isRerank = /rerank|re-rank/.test(lower);
    const isAudio = /whisper|tts|audio|realtime/.test(lower);
    const isImage = /dall-e|midjourney|sdxl|image-/.test(lower);

    // vision 关键词：gpt-4o / 4-vision / vision / gpt-5 / claude-3/4 / gemini / qwen-vl / glm-4v / doubao-vision
    const isVision = /vision|gpt-4o|gpt-4\.1|gpt-5|claude-(3|4|opus|sonnet|haiku)|gemini|qwen.*-vl|glm-4v|qvq|doubao.*vision|step-1v|yi-vision|internvl|llava|minicpm-v|llama-3\.2-vision|llama4|molmo|paligemma|llama-3\.2-11b|llama-3\.2-90b|hunyuan.*vision|xinghuo.*vision|ernie.*vision|deepseek.*vision/.test(lower);

    // tools / function calling：基本上主流 chat 模型都支持
    const isChat = !isEmbed && !isRerank && !isAudio && !isImage;
    const supportsTools = isChat && !/^o1-mini$|^o1-preview$/.test(lower);

    // 显示名美化
    let label = prettifyModelName(id);

    // 上下文窗口（粗略估计，OpenAI 不在 /models 里返回这个）
    const contextWindow = guessContextWindow(id);

    return {
      id,
      label,
      contextWindow,
      vision: isVision,
      tools: supportsTools,
      kind: isEmbed ? "embed" : isRerank ? "rerank" : isAudio ? "audio" : isImage ? "image" : "chat",
    };
  }

  function prettifyModelName(id) {
    let label = id;
    const lower = id.toLowerCase();
    
    // 中国主流大模型厂商名称美化
    if (lower.includes('qwen') || lower.includes('qwen2') || lower.includes('qwen3')) {
      label = label
        .replace(/qwen-/gi, '通义千问 ')
        .replace(/qwen2-/gi, '通义千问 2.')
        .replace(/qwen3-/gi, '通义千问 3.')
        .replace(/qwen_max/gi, '通义千问 Max')
        .replace(/qwen_plus/gi, '通义千问 Plus')
        .replace(/tongyi/gi, '通义');
    } else if (lower.includes('glm') || lower.includes('zhipu')) {
      label = label
        .replace(/glm-/gi, '智谱 GLM-')
        .replace(/zhipu-/gi, '智谱');
    } else if (lower.includes('deepseek')) {
      label = label
        .replace(/deepseek-/gi, 'DeepSeek ');
    } else if (lower.includes('moonshot') || lower.includes('kimi')) {
      label = label
        .replace(/moonshot-/gi, '月之暗面 ')
        .replace(/kimi-/gi, 'Kimi ');
    } else if (lower.includes('hunyuan') || lower.includes('tencent')) {
      label = label
        .replace(/hunyuan-/gi, '腾讯混元 ')
        .replace(/tencent-/gi, '腾讯');
    } else if (lower.includes('xinghuo') || lower.includes('spark') || lower.includes('xfyun')) {
      label = label
        .replace(/xinghuo-/gi, '讯飞星火 ')
        .replace(/spark-/gi, 'Spark ')
        .replace(/xfyun-/gi, '讯飞');
    } else if (lower.includes('ernie') || lower.includes('wenxin') || lower.includes('baidu')) {
      label = label
        .replace(/ernie-/gi, '文心一言 ')
        .replace(/wenxin-/gi, '文心')
        .replace(/baidu-/gi, '百度');
    } else if (lower.includes('step') || lower.includes('minimax')) {
      label = label
        .replace(/step-/gi, '阶跃星辰 Step')
        .replace(/minimax-/gi, 'MiniMax');
    } else if (lower.includes('yi') || lower.includes('lingyiwanwu')) {
      label = label
        .replace(/yi-/gi, '零一万物 Yi-')
        .replace(/lingyiwanwu-/gi, '零一万物');
    } else if (lower.includes('doubao') || lower.includes('volcengine')) {
      label = label
        .replace(/doubao-/gi, '豆包 ')
        .replace(/volcengine-/gi, '火山引擎');
    } else if (lower.includes('internlm') || lower.includes('sensechat')) {
      label = label
        .replace(/internlm-/gi, '书生浦语 ')
        .replace(/sensechat-/gi, '商量');
    }
    
    // 通用美化
    const sizeMatch = label.match(/(\d+b)/i);
    if (sizeMatch) label = `${label.replace(sizeMatch[1], sizeMatch[1].toUpperCase())}`;
    label = label.replace(/-instruct$/i, " (Instruct)").replace(/-chat$/i, " (Chat)");
    
    return label;
  }

  function guessContextWindow(id) {
    const lower = id.toLowerCase();
    
    // Claude 系列
    if (/claude/.test(lower)) return 200000;
    
    // Gemini 系列
    if (/gemini-1\.5-pro|gemini-2/.test(lower)) return 1000000;
    if (/gemini/.test(lower)) return 32000;
    
    // GPT 系列
    if (/gpt-4o|gpt-4-turbo|gpt-4\.1|gpt-5/.test(lower)) return 128000;
    if (/gpt-4/.test(lower)) return 8192;
    if (/o1|gpt-3\.5|gpt-3/.test(lower)) return 16384;
    
    // 通义千问系列
    if (/qwen2\.5-72b|qwen2\.5-32b|qwen-max|qwen-plus|qwen2\.5-/.test(lower)) return 128000;
    if (/qwen-long/.test(lower)) return 1000000;
    if (/qwen/.test(lower)) return 32000;
    
    // 智谱 GLM 系列
    if (/glm-4-plus|glm-4-9b|glm-4-air/.test(lower)) return 128000;
    if (/glm/.test(lower)) return 32000;
    
    // DeepSeek 系列
    if (/deepseek/.test(lower)) return 64000;
    
    // 月之暗面/Kimi 系列
    if (/moonshot|kimi/.test(lower)) return 128000;
    
    // 零一万物 Yi 系列
    if (/yi-1\.5-34b|yi-1\.5-9b/.test(lower)) return 32000;
    
    // 腾讯混元
    if (/hunyuan/.test(lower)) return 128000;
    
    // 讯飞星火
    if (/xinghuo|spark/.test(lower)) return 32000;
    
    // 文心一言
    if (/ernie|wenxin/.test(lower)) return 128000;
    
    // 阶跃星辰
    if (/step/.test(lower)) return 128000;
    
    // 豆包/火山引擎
    if (/doubao/.test(lower)) return 32000;
    
    // 书生浦语
    if (/internlm/.test(lower)) return 32000;
    
    // Llama 系列
    if (/llama-3\.1|llama-3\.2|llama-3\.3|llama-4/.test(lower)) return 128000;
    if (/llama-3/.test(lower)) return 8192;
    
    // Mistral 系列
    if (/mistral-large|mistral-small|mixtral/.test(lower)) return 32000;
    
    if (/command-r-plus|command-r/.test(lower)) return 128000;
    
    return 8192;
  }

  async function chat({ model, messages, stream, temperature = 0.7, maxTokens, signal }) {
    // 如果消息里包含 data URL（图片），尝试走专用 images 接口上传（multipart/form-data）
    const firstMsgContent = (messages && messages[0] && messages[0].content) || "";
    const containsDataUrl = /data:image\//.test(firstMsgContent);

    if (containsDataUrl) {
      try {
        const m = firstMsgContent.match(/(data:image\/.+?;base64,[A-Za-z0-9+/=]+)/);
        const dataUrl = m ? m[1] : null;
        if (dataUrl) {
          const promptText = firstMsgContent.replace(dataUrl, "").trim();
          return await visionSendImage({ model, imageDataUrl: dataUrl, prompt: promptText, signal });
        }
      } catch (e) {
        console.warn('[openai_compat] image upload failed, falling back to embedding DataURL in chat:', e);
        // continue to chat fallback
      }
    }

    const url = `${baseUrl}/chat/completions`;
    const body = {
      model,
      messages,
      stream,
      temperature,
    };
    if (maxTokens) body.max_tokens = maxTokens;
    // 启用 usage 统计（OpenAI 兼容端点的 stream_options）
    if (stream) body.stream_options = { include_usage: true };

    console.log(`[sidebar-ai LLM] POST ${url} model=${model} stream=${stream}`);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
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
        content: data.choices?.[0]?.message?.content || "",
        usage: data.usage,
      };
    }

    // 流式：返回 AsyncIterable + onUsage 回调（最后一个 chunk 包含 usage）
    return streamFromSSE(res, signal, (usage) => {
      // usage 由 streamFromSSE 在收到 usage chunk 时回调
    });
  }

  // 专用图像上传接口：优先使用 provider 的 /images 等端点上传图片并返回解析结果
  async function visionSendImage({ model, imageBlob, imageDataUrl, prompt = "", signal }) {
    // imageBlob 优先，其次 data URL
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

      const imgUrl = `${baseUrl}/images`;
      const imgResp = await fetch(imgUrl, {
        method: "POST",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal,
      });
      if (!imgResp.ok) {
        const t = await imgResp.text().catch(() => "");
        throw new Error(`image upload failed ${imgResp.status}: ${t.slice(0,200)}`);
      }
      const j = await imgResp.json().catch(() => null);
      if (j && (j.result || j.text || j.output)) {
        return { content: j.result || j.text || j.output, usage: j.usage || null };
      }
      return { content: "", usage: j?.usage || null };
    } catch (e) {
      throw e;
    }
  }

  return {
    capabilities,
    models,
    listRemoteModels,
    chat,
    visionSendImage,
  };
}

// SSE 解析：兼容 OpenAI 风格 data: {...}\n\n  以及 \r\n\r\n（部分国产端点用 CRLF）
// 返回 { [Symbol.asyncIterator]() yields string, usage }
// usage 会在收到最后一个 usage chunk 后填充
async function streamFromSSE(res, signal, onUsage) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let totalBytes = 0;
  let totalChunks = 0;
  let lastLogTs = Date.now();
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
        totalBytes += value.length;
        buf += decoder.decode(value, { stream: true });

        if (Date.now() - lastLogTs > 5000) {
          console.log(`[sidebar-ai SSE] received ${totalBytes} bytes, yielded ${totalChunks} chunks, buffer=${buf.length}`);
          lastLogTs = Date.now();
        }

        while (true) {
          const lfIdx = buf.indexOf("\n\n");
          const crlfIdx = buf.indexOf("\r\n\r\n");
          if (lfIdx === -1 && crlfIdx === -1) break;
          let pickIdx, pickLen;
          if (lfIdx === -1) { pickIdx = crlfIdx; pickLen = 4; }
          else if (crlfIdx === -1) { pickIdx = lfIdx; pickLen = 2; }
          else if (lfIdx <= crlfIdx) { pickIdx = lfIdx; pickLen = 2; }
          else { pickIdx = crlfIdx; pickLen = 4; }

          const chunk = buf.slice(0, pickIdx);
          buf = buf.slice(pickIdx + pickLen);

          for (const line of chunk.split(/\r?\n/)) {
            const m = line.match(/^data\s*:\s?(.*)$/);
            if (!m) continue;
            const payload = m[1].trim();
            if (!payload) continue;
            if (payload === "[DONE]") {
              console.log(`[sidebar-ai SSE] received [DONE], total ${totalChunks} chunks`);
              return;
            }
            try {
              const obj = JSON.parse(payload);
              const delta = obj.choices?.[0]?.delta?.content
                         ?? obj.choices?.[0]?.text
                         ?? obj.delta?.text
                         ?? obj.content;
              if (delta) {
                totalChunks++;
                yield delta;
              }
              // usage chunk（最后一个）
              if (obj.usage) {
                usage = obj.usage;
                if (onUsage) onUsage(usage);
              }
            } catch {
              /* 忽略非 JSON 行 */
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

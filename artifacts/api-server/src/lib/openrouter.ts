/**
 * OpenRouter streaming client — OpenAI-compatible API.
 * Free models are marked with `:free` suffix and have no daily cost.
 *
 * Default model: google/gemini-2.0-flash-exp:free (Gemini quality, free tier)
 * Vision model:  google/gemini-2.0-flash-exp:free (supports image inputs)
 *
 * On HTTP 429, retries up to MAX_RETRIES times with exponential back-off.
 */

import { type ChatMessage, type ContentPart } from "./groq";
export type { ChatMessage, ContentPart };

const MODEL        = "deepseek/deepseek-chat-v3-0324:free";
const VISION_MODEL = "meta-llama/llama-3.2-11b-vision-instruct:free";
const MAX_TOKENS   = 8192;
const MAX_RETRIES  = 4;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function hasImageContent(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as ContentPart[]).some((p) => p.type === "image_url"),
  );
}

export async function* streamOpenRouter(
  messages: ChatMessage[],
  maxTokens = MAX_TOKENS,
): AsyncGenerator<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY must be set in Railway variables");

  const model = hasImageContent(messages) ? VISION_MODEL : MODEL;

  let attempt = 0;
  let res: Response | null = null;

  while (attempt <= MAX_RETRIES) {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/ssproduction13-ship-it/sovetnik-ai",
        "X-Title": "Sovetnik AI",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        stream: true,
      }),
    });

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        const body = await res.text();
        throw new Error(`OpenRouter API error 429: ${body}`);
      }
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? parseFloat(retryAfter) * 1000
        : Math.min(30_000, 2 ** attempt * 5_000); // 5s, 10s, 20s, 30s
      attempt++;
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${body}`);
    }

    break;
  }

  const reader = res!.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6).trim();
      if (!json || json === "[DONE]") continue;
      try {
        const parsed = JSON.parse(json);
        const text: string | undefined = parsed?.choices?.[0]?.delta?.content;
        if (text) yield text;
      } catch {
        // ignore malformed chunks
      }
    }
  }
}

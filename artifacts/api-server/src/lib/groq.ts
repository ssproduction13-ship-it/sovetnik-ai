/**
 * Minimal Groq streaming client using fetch — no SDK dependency.
 * Groq is OpenAI-compatible, so we use the same chat completions format.
 *
 * Rate-limit strategy:
 *  - max_tokens reduced to 800 (agents must be concise, ~6× fewer tokens per call)
 *  - On HTTP 429, retry up to MAX_RETRIES times with exponential back-off
 *    (starts at the Retry-After header value, or 30 s if absent)
 */

/** Single part of a multipart message (used for vision / image input) */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** Plain string for text-only messages; array for messages that include images */
  content: string | ContentPart[];
}

const MODEL        = "llama-3.3-70b-versatile";
/** Vision-capable model — used automatically when a message contains an image */
const VISION_MODEL = "llama-4-scout-17b-16e-instruct";
const MAX_TOKENS = 800;   // was 8192 — agents are instructed to be concise anyway
const MAX_RETRIES = 4;    // retry up to 4 times on 429

/** Returns true when any user message contains an image_url content part */
function hasImageContent(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as ContentPart[]).some((p) => p.type === "image_url"),
  );
}

async function fetchGroqStream(
  messages: ChatMessage[],
  apiKey: string,
  maxTokens = MAX_TOKENS,
): Promise<Response> {
  const model = hasImageContent(messages) ? VISION_MODEL : MODEL;
  return fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      stream: true,
    }),
  });
}

/** Sleep for `ms` milliseconds */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function* streamGroq(
  messages: ChatMessage[],
  maxTokens = MAX_TOKENS,
): AsyncGenerator<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY must be set in Railway variables");

  let attempt = 0;
  let res: Response | null = null;

  while (attempt <= MAX_RETRIES) {
    res = await fetchGroqStream(messages, apiKey, maxTokens);

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        const body = await res.text();
        throw new Error(`Groq API error ${res.status}: ${body}`);
      }

      // Respect Retry-After header, fall back to exponential back-off
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterSec = retryAfterHeader ? parseFloat(retryAfterHeader) : null;
      const backoffMs = retryAfterSec
        ? retryAfterSec * 1000
        : Math.min(30_000, 2 ** attempt * 5_000); // 5s, 10s, 20s, 30s

      attempt++;
      await sleep(backoffMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Groq API error ${res.status}: ${body}`);
    }

    break; // success
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

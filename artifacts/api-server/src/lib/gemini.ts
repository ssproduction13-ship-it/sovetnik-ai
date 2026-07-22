/**
 * Minimal Gemini streaming client using fetch — no SDK dependency.
 */

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export interface GeminiMessage {
  role: "user" | "model";
  parts: GeminiPart[];
}

const MAX_RETRIES = 4;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function* streamGemini(
  messages: GeminiMessage[],
  systemInstruction: string,
  maxOutputTokens = 8192,
): AsyncGenerator<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY must be set in Railway variables");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${apiKey}`;

  let res: Response | null = null;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: messages,
        generationConfig: { maxOutputTokens },
      }),
    });

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        const body = await res.text();
        throw new Error(`Gemini API error 429: ${body}`);
      }
      // Respect Retry-After header, fall back to exponential back-off
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
      throw new Error(`Gemini API error ${res.status}: ${body}`);
    }

    break;
  }

  const reader = res.body!.getReader();
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
        const text: string | undefined =
          parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield text;
      } catch {
        // ignore malformed chunks
      }
    }
  }
}

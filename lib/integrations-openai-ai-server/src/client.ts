import OpenAI from "openai";

let _openai: OpenAI | null = null;

export function getOpenai(): OpenAI {
  if (!_openai) {
    const apiKey =
      process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
      process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY must be set.",
      );
    }

    _openai = new OpenAI({
      apiKey,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "https://api.openai.com/v1",
    });
  }
  return _openai;
}

// Backward-compatible lazy proxy
export const openai = new Proxy({} as OpenAI, {
  get(_target, prop) {
    return getOpenai()[prop as keyof OpenAI];
  },
});

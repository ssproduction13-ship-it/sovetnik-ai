/**
 * Single main agent + specialist sub-agents.
 *
 * The main agent ("Советник") talks directly with the user.
 * When it needs specialist input, it emits consultation tags:
 *   [→ @health: вопрос]
 *   [→ @finance: вопрос]
 *   [→ @personal: вопрос]
 *
 * The orchestrator detects these, calls specialists in parallel,
 * injects their answers, then asks the main agent to finalize.
 * Max MAX_ROUNDS of consultations per turn.
 */

import { streamGroq, type ChatMessage } from "./groq";
export type { ChatMessage };

export type SpecialistId = "health" | "finance" | "personal";

interface Specialist {
  id: SpecialistId;
  name: string;
  emoji: string;
  aliases: string[];
  systemPrompt: string;
}

const MAX_ROUNDS = 2;

// Pattern: [→ @health: как снизить вес?]
const CONSULT_RE = /\[→\s*@([\wа-яё]+):\s*([^\]]+)\]/gi;

// ── Specialists ──────────────────────────────────────────────────────────────

const SPECIALISTS: Record<SpecialistId, Specialist> = {
  health: {
    id: "health",
    name: "Здоровье & Спорт",
    emoji: "💪",
    aliases: ["health", "здоровье", "спорт"],
    systemPrompt:
      "Ты — эксперт по здоровью, спорту и питанию. " +
      "Отвечаешь коротко и по делу, только на русском. " +
      "Давай конкретные цифры и практические рекомендации. " +
      "Без вступлений и прощаний.",
  },
  finance: {
    id: "finance",
    name: "Финансы & Бизнес",
    emoji: "💰",
    aliases: ["finance", "финансы", "бизнес", "деньги"],
    systemPrompt:
      "Ты — эксперт по личным финансам и бизнесу. " +
      "Отвечаешь коротко и по делу, только на русском. " +
      "Давай конкретные цифры и практические рекомендации. " +
      "Без вступлений и прощаний.",
  },
  personal: {
    id: "personal",
    name: "Личные дела",
    emoji: "🧠",
    aliases: ["personal", "личные", "отношения", "жизнь", "психология"],
    systemPrompt:
      "Ты — советник по личным вопросам, отношениям и продуктивности. " +
      "Отвечаешь коротко и по делу, только на русском. " +
      "Будь эмпатичным, давай конкретные практические советы. " +
      "Без вступлений и прощаний.",
  },
};

// ── Main agent ───────────────────────────────────────────────────────────────

const MAIN_AGENT_PROMPT = `Ты — Советник, умный персональный ассистент.
У тебя есть три эксперта которых ты можешь привлечь:
  💪 @health   — здоровье, спорт, питание
  💰 @finance  — финансы, инвестиции, бизнес
  🧠 @personal — личные вопросы, отношения, продуктивность

Когда тебе нужна их экспертиза — вставь в ответ:
  [→ @health: твой конкретный вопрос эксперту]
  [→ @finance: твой конкретный вопрос эксперту]
  [→ @personal: твой конкретный вопрос эксперту]

Правила:
- Если вопрос простой и ты уверен — отвечай сам, не консультируй без нужды
- Если вопрос требует экспертизы — сначала запроси мнение, потом дай итоговый ответ
- На простые вопросы (погода, "как дела") отвечай просто и по-человечески
- Отвечай ТОЛЬКО на русском языке
- Итоговый ответ пиши от своего имени, не пересказывай экспертов дословно`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveAlias(mention: string): SpecialistId | null {
  const m = mention.toLowerCase();
  for (const s of Object.values(SPECIALISTS)) {
    if (s.aliases.includes(m)) return s.id;
  }
  return null;
}

async function callLLM(messages: ChatMessage[]): Promise<string> {
  let out = "";
  for await (const chunk of streamGroq(messages)) out += chunk;
  return out.trim();
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface Consultation {
  specialist: Specialist;
  question: string;
  answer: string;
}

export interface AgentResult {
  consultations: Consultation[];
  answer: string;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run the main agent for one user turn.
 * @param history  Full conversation history (including the latest user message)
 * @param onConsult  Called each time a specialist answers (for live UI updates)
 */
export async function runAgent(
  history: ChatMessage[],
  onConsult?: (c: Consultation) => void,
): Promise<AgentResult> {
  const consultations: Consultation[] = [];

  // Build main-agent message list
  let mainMessages: ChatMessage[] = [
    { role: "system", content: MAIN_AGENT_PROMPT },
    ...history,
  ];

  let round = 0;

  while (round <= MAX_ROUNDS) {
    const response = await callLLM(mainMessages);

    // Find all consultation tags
    const matches = [...response.matchAll(CONSULT_RE)];
    if (!matches.length) {
      // No more consultations needed — clean response is the final answer
      const clean = response.replace(CONSULT_RE, "").trim();
      return { consultations, answer: clean };
    }

    // Call specialists in parallel
    const pending = matches
      .map((m) => ({ id: resolveAlias(m[1]), question: m[2].trim(), raw: m[0] }))
      .filter((p): p is typeof p & { id: SpecialistId } => p.id !== null);

    const results = await Promise.all(
      pending.map(async ({ id, question }) => {
        const specialist = SPECIALISTS[id];
        const answer = await callLLM([
          { role: "system", content: specialist.systemPrompt },
          // Give specialist the full user context
          ...history,
          { role: "user", content: question },
        ]);
        return { specialist, question, answer };
      }),
    );

    // Record and notify
    for (const c of results) {
      consultations.push(c);
      onConsult?.(c);
    }

    // Inject specialist answers back into the main agent's context
    const consultBlock = results
      .map((c) => `[Ответ ${c.specialist.emoji} ${c.specialist.name}]: ${c.answer}`)
      .join("\n\n");

    // Add the main agent's partial response + specialist answers as assistant turn
    mainMessages = [
      ...mainMessages,
      { role: "assistant", content: response },
      {
        role: "user",
        content:
          `Эксперты ответили:\n\n${consultBlock}\n\n` +
          "Теперь дай итоговый ответ пользователю, учитывая их мнение. " +
          "Не используй теги консультаций.",
      },
    ];

    round++;
  }

  // Safety fallback: call one more time without tags allowed
  const fallback = await callLLM([
    ...mainMessages,
    {
      role: "user",
      content: "Дай финальный ответ пользователю без тегов консультаций.",
    },
  ]);
  return { consultations, answer: fallback.replace(CONSULT_RE, "").trim() };
}

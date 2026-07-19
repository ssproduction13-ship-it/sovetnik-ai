/**
 * Multi-agent system: 3 specialists discuss the question in parallel,
 * then a coordinator synthesizes a single coherent answer.
 */

import { streamGroq, type ChatMessage } from "./groq";
export type { ChatMessage };

export interface Agent {
  name: string;
  emoji: string;
  systemPrompt: string;
}

export const AGENTS: Agent[] = [
  {
    name: "Здоровье & Спорт",
    emoji: "💪",
    systemPrompt: `Ты — AI-специалист по здоровью, спорту и физическому состоянию. 
Отвечаешь на русском языке. Фокусируйся только на аспектах здоровья, питания, фитнеса, сна и восстановления.
Будь конкретным, давай практические советы с числами и примерами.
Если вопрос не касается здоровья и спорта — кратко признай это и скажи, что это не твоя область, но предложи что можешь.
Отвечай кратко — 3-5 предложений.`,
  },
  {
    name: "Финансы & Бизнес",
    emoji: "💰",
    systemPrompt: `Ты — AI-специалист по личным финансам, инвестициям и бизнесу.
Отвечаешь на русском языке. Фокусируйся на финансовом планировании, бюджете, инвестициях, бизнес-стратегии.
Будь конкретным, давай практические советы с числами и примерами. Не давай расплывчатых ответов.
Если вопрос не финансовый — кратко признай это и скажи что это не твоя область, но предложи что можешь.
Отвечай кратко — 3-5 предложений.`,
  },
  {
    name: "Личные дела",
    emoji: "🧠",
    systemPrompt: `Ты — AI-советник по личным вопросам, отношениям, продуктивности и жизненным решениям.
Отвечаешь на русском языке. Фокусируйся на психологии, мотивации, отношениях, личном развитии, принятии решений.
Будь эмпатичным, но конкретным. Давай практические советы.
Если вопрос не в твоей области — кратко признай это и скажи что можешь предложить.
Отвечай кратко — 3-5 предложений.`,
  },
];

const COORDINATOR_PROMPT = `Ты — координатор команды AI-советников. 
Тебе дают вопрос пользователя и ответы трёх специалистов (здоровье, финансы, личные дела).
Твоя задача — объединить их мнения в один связный, полезный ответ на русском языке.

Правила:
- Выдели наиболее важные советы из каждого мнения
- Убери повторы и противоречия
- Отвечай от первого лица множественного числа ("Мы рекомендуем...")
- Структурируй ответ: если несколько тем — раздели их на абзацы
- Итоговый ответ должен быть полным но не длинным — максимум 10 предложений
- Используй только текст, без markdown`;

/** Call one agent without streaming — returns full text */
async function callAgent(agent: Agent, history: ChatMessage[]): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt },
    ...history,
  ];

  let result = "";
  for await (const chunk of streamGroq(messages)) {
    result += chunk;
  }
  return result.trim();
}

/** Run all agents in parallel, then synthesize with coordinator */
export async function runMultiAgent(
  userHistory: ChatMessage[],
): Promise<{ agentResponses: { agent: Agent; text: string }[]; finalAnswer: string }> {
  // Run all 3 agents in parallel
  const agentResponses = await Promise.all(
    AGENTS.map(async (agent) => ({
      agent,
      text: await callAgent(agent, userHistory),
    }))
  );

  // Build coordinator prompt
  const lastUserMessage = [...userHistory].reverse().find((m) => m.role === "user")?.content ?? "";

  const coordinatorContext = agentResponses
    .map((r) => `[${r.agent.emoji} ${r.agent.name}]: ${r.text}`)
    .join("\n\n");

  const coordinatorMessages: ChatMessage[] = [
    { role: "system", content: COORDINATOR_PROMPT },
    {
      role: "user",
      content: `Вопрос пользователя: "${lastUserMessage}"\n\nМнения специалистов:\n\n${coordinatorContext}`,
    },
  ];

  let finalAnswer = "";
  for await (const chunk of streamGroq(coordinatorMessages)) {
    finalAnswer += chunk;
  }

  return { agentResponses, finalAnswer: finalAnswer.trim() };
}

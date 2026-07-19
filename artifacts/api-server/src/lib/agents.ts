/**
 * Multi-agent system with direct addressing and agent-to-agent communication.
 *
 * Agents can ask each other by including [→ @agent: question] in their response.
 * The orchestrator detects these, routes them, and continues the discussion
 * for up to MAX_ROUNDS rounds before final synthesis.
 */

import { streamGroq, type ChatMessage } from "./groq";
export type { ChatMessage };

export type AgentId = "health" | "finance" | "personal";

export interface Agent {
  id: AgentId;
  name: string;
  emoji: string;
  alias: string[]; // recognized @mentions
  systemPrompt: string;
}

// Pattern: [→ @finance: how much does this cost?]
const AGENT_QUESTION_RE = /\[→\s*@(\w+):\s*([^\]]+)\]/g;

const MAX_ROUNDS = 3;

export const AGENTS: Record<AgentId, Agent> = {
  health: {
    id: "health",
    name: "Здоровье & Спорт",
    emoji: "💪",
    alias: ["health", "здоровье", "спорт"],
    systemPrompt: `Ты — AI-специалист по здоровью, спорту, питанию и физическому состоянию.
Отвечаешь только на русском языке. Давай конкретные советы с цифрами и примерами.

Если тебе нужно мнение другого специалиста — добавь в ответ тег:
[→ @finance: вопрос] — спросить финансового советника
[→ @personal: вопрос] — спросить советника по личным делам

Используй теги только когда это действительно нужно для полного ответа. Отвечай лаконично.`,
  },
  finance: {
    id: "finance",
    name: "Финансы & Бизнес",
    emoji: "💰",
    alias: ["finance", "финансы", "бизнес", "деньги"],
    systemPrompt: `Ты — AI-специалист по личным финансам, инвестициям и бизнесу.
Отвечаешь только на русском языке. Давай конкретные советы с цифрами и примерами.

Если тебе нужно мнение другого специалиста — добавь в ответ тег:
[→ @health: вопрос] — спросить советника по здоровью
[→ @personal: вопрос] — спросить советника по личным делам

Используй теги только когда это действительно нужно для полного ответа. Отвечай лаконично.`,
  },
  personal: {
    id: "personal",
    name: "Личные дела",
    emoji: "🧠",
    alias: ["personal", "личные", "отношения", "жизнь"],
    systemPrompt: `Ты — AI-советник по личным вопросам, отношениям, продуктивности и жизненным решениям.
Отвечаешь только на русском языке. Давай конкретные, эмпатичные советы.

Если тебе нужно мнение другого специалиста — добавь в ответ тег:
[→ @health: вопрос] — спросить советника по здоровью
[→ @finance: вопрос] — спросить финансового советника

Используй теги только когда это действительно нужно для полного ответа. Отвечай лаконично.`,
  },
};

const COORDINATOR_PROMPT = `Ты — координатор команды AI-советников. 
Получаешь вопрос пользователя и всю дискуссию специалистов между собой.
Задача: объединить их выводы в один связный финальный ответ на русском языке.

Правила:
- Выдели самое важное из обсуждения
- Убери повторы, оставь суть
- Пиши от первого лица множественного числа ("Мы рекомендуем...")
- Максимум 8 предложений
- Только текст, без markdown`;

/** Resolve @mention alias to AgentId */
function resolveAlias(mention: string): AgentId | null {
  const m = mention.toLowerCase();
  for (const agent of Object.values(AGENTS)) {
    if (agent.alias.includes(m)) return agent.id;
  }
  return null;
}

/** Call one agent and return its text */
async function callAgent(agent: Agent, messages: ChatMessage[]): Promise<string> {
  const full: ChatMessage[] = [{ role: "system", content: agent.systemPrompt }, ...messages];
  let result = "";
  for await (const chunk of streamGroq(full)) result += chunk;
  return result.trim();
}

export interface AgentTurn {
  agent: Agent;
  question: string;
  answer: string;
}

export interface MultiAgentResult {
  turns: AgentTurn[];
  finalAnswer: string;
  isSingleAgent: boolean;
}

/**
 * Run a single agent directly (no synthesis).
 */
export async function runSingleAgent(
  agentId: AgentId,
  userHistory: ChatMessage[],
  onTurn: (turn: AgentTurn) => void,
): Promise<MultiAgentResult> {
  const agent = AGENTS[agentId];
  const lastUserMsg = [...userHistory].reverse().find((m) => m.role === "user")?.content ?? "";

  const turns: AgentTurn[] = [];

  // Initial answer
  let answer = await callAgent(agent, userHistory);
  const cleaned = answer.replace(AGENT_QUESTION_RE, "").trim();
  const firstTurn: AgentTurn = { agent, question: lastUserMsg, answer: cleaned };
  turns.push(firstTurn);
  onTurn(firstTurn);

  // Handle cross-agent questions from this agent
  let round = 0;
  let pendingAnswer = answer;

  while (round < MAX_ROUNDS) {
    const matches = [...pendingAnswer.matchAll(AGENT_QUESTION_RE)];
    if (!matches.length) break;

    let hasNew = false;
    for (const match of matches) {
      const targetId = resolveAlias(match[1]);
      if (!targetId || targetId === agentId) continue;

      const targetAgent = AGENTS[targetId];
      const question = match[2].trim();
      const targetMessages: ChatMessage[] = [
        ...userHistory,
        { role: "user", content: `Коллега спрашивает: ${question}` },
      ];
      const targetAnswer = await callAgent(targetAgent, targetMessages);
      const turn: AgentTurn = { agent: targetAgent, question, answer: targetAnswer.replace(AGENT_QUESTION_RE, "").trim() };
      turns.push(turn);
      onTurn(turn);
      pendingAnswer = targetAnswer;
      hasNew = true;
    }

    if (!hasNew) break;
    round++;
  }

  return { turns, finalAnswer: cleaned, isSingleAgent: true };
}

/**
 * Run all agents, allow them to discuss, then synthesize.
 */
export async function runMultiAgent(
  userHistory: ChatMessage[],
  onTurn: (turn: AgentTurn) => void,
): Promise<MultiAgentResult> {
  const lastUserMsg = [...userHistory].reverse().find((m) => m.role === "user")?.content ?? "";
  const turns: AgentTurn[] = [];

  // Round 0: all agents answer the user in parallel
  const initialAnswers = await Promise.all(
    Object.values(AGENTS).map(async (agent) => {
      const answer = await callAgent(agent, userHistory);
      return { agent, answer };
    })
  );

  // Collect cross-agent questions from round 0
  const pendingQuestions: { from: Agent; targetId: AgentId; question: string }[] = [];

  for (const { agent, answer } of initialAnswers) {
    const cleaned = answer.replace(AGENT_QUESTION_RE, "").trim();
    const turn: AgentTurn = { agent, question: lastUserMsg, answer: cleaned };
    turns.push(turn);
    onTurn(turn);

    for (const match of answer.matchAll(AGENT_QUESTION_RE)) {
      const targetId = resolveAlias(match[1]);
      if (targetId && targetId !== agent.id) {
        pendingQuestions.push({ from: agent, targetId, question: match[2].trim() });
      }
    }
  }

  // Rounds 1..MAX_ROUNDS: resolve cross-agent questions
  let round = 0;
  let queue = pendingQuestions;

  while (queue.length && round < MAX_ROUNDS) {
    const nextQueue: typeof queue = [];

    const results = await Promise.all(
      queue.map(async ({ from, targetId, question }) => {
        const targetAgent = AGENTS[targetId];
        const messages: ChatMessage[] = [
          ...userHistory,
          { role: "user", content: `${from.emoji} ${from.name} спрашивает тебя: ${question}` },
        ];
        const answer = await callAgent(targetAgent, messages);
        return { from, targetAgent, question, answer };
      })
    );

    for (const { from, targetAgent, question, answer } of results) {
      const cleaned = answer.replace(AGENT_QUESTION_RE, "").trim();
      const turn: AgentTurn = {
        agent: targetAgent,
        question: `${from.emoji} спрашивает: ${question}`,
        answer: cleaned,
      };
      turns.push(turn);
      onTurn(turn);

      for (const match of answer.matchAll(AGENT_QUESTION_RE)) {
        const nextTargetId = resolveAlias(match[1]);
        if (nextTargetId && nextTargetId !== targetAgent.id) {
          nextQueue.push({ from: targetAgent, targetId: nextTargetId, question: match[2].trim() });
        }
      }
    }

    queue = nextQueue;
    round++;
  }

  // Final synthesis
  const discussion = turns
    .map((t) => `[${t.agent.emoji} ${t.agent.name}] ${t.question}\n→ ${t.answer}`)
    .join("\n\n");

  const coordinatorMessages: ChatMessage[] = [
    { role: "system", content: COORDINATOR_PROMPT },
    {
      role: "user",
      content: `Вопрос пользователя: "${lastUserMsg}"\n\nДискуссия:\n${discussion}`,
    },
  ];

  let finalAnswer = "";
  for await (const chunk of streamGroq(coordinatorMessages)) finalAnswer += chunk;

  return { turns, finalAnswer: finalAnswer.trim(), isSingleAgent: false };
}

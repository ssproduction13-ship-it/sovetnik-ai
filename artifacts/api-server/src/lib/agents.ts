/**
 * Multi-agent system — four named specialists.
 *
 * Modes:
 *   "answer"     — each targeted agent answers independently (parallel)
 *   "discussion" — agents speak in sequence, each seeing what others said
 *
 * After "answer" mode with all four agents, a reaction phase follows
 * (comments + inter-agent questions).
 *
 * Single-agent mode supports:
 *   — tool calling ([TOOL:ACTION:args]) for DB operations (ТЗ §3)
 *   — specialist hiring ([HIRE:emoji:role:question])
 *   — clarifying questions ([ASK_USER:question]) → pending_intent (ТЗ §4)
 */

import { streamGroq, type ChatMessage, type ContentPart } from "./groq";
import { executeTool } from "./tools";
export type { ChatMessage, ContentPart };

// ── Specialist hiring ─────────────────────────────────────────────────────

/** Fired each time an agent hires a specialist and gets their answer back */
export interface HireEvent {
  emoji: string;
  role: string;
  question: string;
  answer: string;
}

const HIRE_RE = /\[HIRE:([^:]+):([^:\]]+):([^\]]+)\]/gi;

const HIRE_INSTRUCTION = `
Если для ответа нужна экспертиза за рамками твоей специализации, найми узкого специалиста.
Формат тега (вставь прямо в текст ответа):
  [HIRE:emoji:Роль специалиста:конкретный вопрос]
Примеры:
  [HIRE:🏥:Кардиолог:Какие кардионагрузки безопасны при давлении 160/100?]
  [HIRE:📊:Налоговый консультант:Как оформить вычет за лечение для ИП?]
Допустимо 1–2 найма за ответ. Не показывай пользователю сам тег — только результат.
`.trim();

/** Run a one-off specialist agent (short budget, no streaming exposed) */
async function spawnSpecialist(
  emoji: string,
  role: string,
  question: string,
  userMessage: string,
): Promise<string> {
  const system = `Ты — ${emoji} ${role}, узкий специалист. Отвечай только на русском. Дай конкретный точный ответ в 2–3 предложениях. Без markdown, без вступлений.`;
  const msgs: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: userMessage ? `Контекст: ${userMessage}\n\nВопрос коллеги: ${question}` : question },
  ];
  let out = "";
  for await (const chunk of streamGroq(msgs, 300)) out += chunk;
  return out.trim();
}

// ── Tool calling tags (ТЗ §3) ─────────────────────────────────────────────

/** [TOOL:ACTION_NAME:arg1:arg2:...] */
const TOOL_RE = /\[TOOL:([A-Z_]+)(?::([^\]]*))?\]/gi;

/** [ASK_USER:question text] — triggers pending_intent flow */
const ASK_USER_RE = /\[ASK_USER:([^\]]+)\]/i;

/**
 * Per-agent tool instructions appended to the system prompt.
 * Each agent only knows about tools relevant to its domain.
 */
const TOOL_INSTRUCTIONS: Record<AgentId, string> = {
  health: `
ИНСТРУМЕНТЫ (вставь тег прямо в ответ — он выполнится автоматически, пользователь его не увидит):
  [TOOL:SAVE_WORKOUT:тип:детали:дата]  — когда пользователь сообщает о тренировке
  [TOOL:GET_WORKOUTS:период]           — когда нужна история тренировок
  [ASK_USER:один вопрос]              — ТОЛЬКО если критически не хватает данных для плана
`.trim(),
  finance: `
ИНСТРУМЕНТЫ (вставь тег прямо в ответ — он выполнится автоматически):
  [TOOL:SAVE_EXPENSE:сумма_руб:категория:дата]  — когда пользователь сообщает о расходе
  [TOOL:GET_EXPENSES:период]                    — когда нужна история расходов
  [ASK_USER:один вопрос]                       — только если критически не хватает данных
`.trim(),
  personal: `
ИНСТРУМЕНТЫ (вставь тег прямо в ответ — он выполнится автоматически):
  [TOOL:SAVE_TASK:текст задачи:дата_или_пусто]  — добавить задачу / напоминание
  [TOOL:GET_TASKS]                              — список активных задач
  [TOOL:COMPLETE_TASK:часть текста задачи]      — отметить задачу выполненной
  [ASK_USER:один вопрос]                       — только если критически не хватает данных
`.trim(),
  tech: `
ИНСТРУМЕНТ:
  [ASK_USER:один вопрос]  — если для отладки нет traceback/кода и они критически нужны
`.trim(),
};

// ── Agent definitions ─────────────────────────────────────────────────────

export type AgentId = "health" | "finance" | "personal" | "tech";

export interface Agent {
  id: AgentId;
  firstName: string;
  name: string;
  emoji: string;
  mentions: string[];
  systemPrompt: string;
}

export const AGENTS: Record<AgentId, Agent> = {
  health: {
    id: "health",
    firstName: "Макс",
    name: "Здоровье & Спорт",
    emoji: "💪",
    mentions: ["health", "макс", "max", "здоровье", "спорт"],
    systemPrompt: `Тебя зовут Макс. Ты AI-специалист по здоровью, спорту и питанию.
Отвечаешь только на русском языке от первого лица. Без markdown-заголовков и звёздочек.

Когда пользователь СООБЩАЕТ о тренировке ("потренировался", "пробежал", "сходил в зал"):
— Зафиксируй через [TOOL:SAVE_WORKOUT:тип:детали:дата]
— Дай короткую обратную связь (1-2 предложения). Без плана, если не просили.

Когда просят ПЛАН и данных ДОСТАТОЧНО (цель, уровень подготовки, тип):
— Дай конкретный план с упражнениями, подходами, повторами. Максимум 6 предложений.

Когда просят план, но данных НЕ ХВАТАЕТ:
— Задай ОДИН уточняющий вопрос через [ASK_USER:вопрос]

Если нужна история тренировок — получи через [TOOL:GET_WORKOUTS:период].`,
  },
  finance: {
    id: "finance",
    firstName: "Аня",
    name: "Финансы & Бизнес",
    emoji: "💰",
    mentions: ["finance", "аня", "anya", "финансы", "бизнес", "деньги"],
    systemPrompt: `Тебя зовут Аня. Ты AI-специалист по личным финансам и бизнесу.
Отвечаешь только на русском языке от первого лица. Без markdown. Без инвестиционных рекомендаций (куда вкладывать) — только учёт и аналитика.

Когда пользователь СООБЩАЕТ о расходе ("потратил 1500 на продукты", "заплатил за абонемент"):
— Определи сумму и категорию самостоятельно, не спрашивай уточнений.
— Зафиксируй через [TOOL:SAVE_EXPENSE:сумма_руб:категория:дата]
— Подтверди коротко: "Записал: 1500₽ — продукты."

Когда спрашивают об ИСТОРИИ расходов или бюджете:
— Получи данные через [TOOL:GET_EXPENSES:период]
— Дай фактический ответ по цифрам. Максимум 6 предложений.`,
  },
  personal: {
    id: "personal",
    firstName: "Лёва",
    name: "Личные дела",
    emoji: "🧠",
    mentions: ["personal", "лёва", "лева", "lyova", "личные", "жизнь", "отношения"],
    systemPrompt: `Тебя зовут Лёва. Ты AI-советник по личным вопросам, отношениям, продуктивности и задачам.
Отвечаешь только на русском языке от первого лица. Нейтральный, чуть разговорный тон. Без markdown.

Когда просят добавить задачу или напоминание:
— Добавь через [TOOL:SAVE_TASK:текст:дата_или_пусто]
— Подтверди коротко.

Когда спрашивают про задачи или список дел:
— Получи через [TOOL:GET_TASKS]

Когда задача выполнена:
— Отметь через [TOOL:COMPLETE_TASK:часть_текста]

Для личных вопросов и отношений — давай конкретные, эмпатичные советы. Максимум 6 предложений.`,
  },
  tech: {
    id: "tech",
    firstName: "Дима",
    name: "Программирование & Технологии",
    emoji: "💻",
    mentions: ["tech", "дима", "dima", "код", "программирование", "разработка", "dev"],
    systemPrompt: `Тебя зовут Дима. Ты AI-специалист по программированию, разработке ПО и технологиям.
Отвечаешь только на русском языке от первого лица. Без markdown-заголовков, код в тексте.

Для ОТЛАДКИ: если нет конкретного traceback/кода — запроси через [ASK_USER:Покажи traceback или код с ошибкой].
Для КОД-РЕВЬЮ: указывай проблемы кратко с примером исправления.
Для общих вопросов: конкретные советы с инструментами и примерами. Максимум 6 предложений.`,
  },
};

// ── Alias map ─────────────────────────────────────────────────────────────

export const ALIAS_MAP: Record<string, AgentId> = {};
for (const agent of Object.values(AGENTS)) {
  for (const alias of agent.mentions) {
    ALIAS_MAP[alias.toLowerCase()] = agent.id;
  }
}

// ── Low-level calls ───────────────────────────────────────────────────────

/** Plain call — used for discussion/reaction phases (no tools needed there) */
async function callAgent(agent: Agent, messages: ChatMessage[]): Promise<string> {
  const full: ChatMessage[] = [{ role: "system", content: agent.systemPrompt }, ...messages];
  let result = "";
  for await (const chunk of streamGroq(full)) result += chunk;
  return result.trim();
}

/**
 * Single-agent call with full capability:
 *   1. First pass → agent may embed [TOOL:...], [HIRE:...], [ASK_USER:...] tags
 *   2. [ASK_USER:q]  → return {pendingQuestion: q}  (no agent response shown)
 *   3. [TOOL:...]    → execute DB operations
 *   4. [HIRE:...]    → spawn specialists, fire onHire
 *   5. If any tools/hires → second pass integrating all results → clean response
 */
async function callAgentWithTools(
  agent: Agent,
  messages: ChatMessage[],
  userMessage: string,
  chatId: number,
  onHire?: (event: HireEvent) => Promise<void>,
): Promise<{ answer: string; pendingQuestion?: string }> {
  const toolInstr = TOOL_INSTRUCTIONS[agent.id];
  const systemFull = `${agent.systemPrompt}\n\n${HIRE_INSTRUCTION}\n\n${toolInstr}`;
  const full: ChatMessage[] = [{ role: "system", content: systemFull }, ...messages];

  // ── First pass ────────────────────────────────────────────────────────
  let firstPass = "";
  for await (const chunk of streamGroq(full)) firstPass += chunk;
  firstPass = firstPass.trim();

  // ── ASK_USER → pending_intent, no agent response ──────────────────────
  const askMatch = firstPass.match(ASK_USER_RE);
  if (askMatch) {
    return { answer: "", pendingQuestion: askMatch[1].trim() };
  }

  // ── Collect HIRE and TOOL tags ────────────────────────────────────────
  const hireMatches = [...firstPass.matchAll(HIRE_RE)];
  const toolMatches = [...firstPass.matchAll(TOOL_RE)];

  if (hireMatches.length === 0 && toolMatches.length === 0) {
    return { answer: firstPass };
  }

  const supplementary: string[] = [];

  // Execute HIRE tags
  for (const match of hireMatches) {
    const [, emoji, role, question] = match;
    const answer = await spawnSpecialist(emoji.trim(), role.trim(), question.trim(), userMessage);
    const event: HireEvent = { emoji: emoji.trim(), role: role.trim(), question: question.trim(), answer };
    if (onHire) await onHire(event);
    supplementary.push(`${emoji.trim()} ${role.trim()}: ${answer}`);
  }

  // Execute TOOL tags
  for (const match of toolMatches) {
    const [, toolName, argsStr = ""] = match;
    const result = await executeTool(chatId, toolName.trim(), argsStr);
    supplementary.push(`[${toolName.trim()}]: ${result}`);
  }

  // ── Second pass: integrate all results into clean response ────────────
  const summary = supplementary.join("\n");
  const finalMessages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt }, // no extra instructions
    ...messages,
    {
      role: "user",
      content:
        `Результаты инструментов и консультаций:\n\n${summary}\n\n` +
        `Используй эти данные и дай пользователю финальный ответ. Без markdown. Максимум 7 предложений.`,
    },
  ];

  let finalPass = "";
  for await (const chunk of streamGroq(finalMessages)) finalPass += chunk;
  return { answer: finalPass.trim() };
}

// ── Public types ──────────────────────────────────────────────────────────

export interface AgentAnswer {
  agent: Agent;
  answer: string;
}

export type Reaction =
  | { kind: "comment"; agent: Agent; text: string }
  | { kind: "question"; from: Agent; to: Agent; text: string };

export interface AgentQuestionAnswer {
  from: Agent;
  to: Agent;
  question: string;
  answer: string;
}

// ── Answer mode — parallel ────────────────────────────────────────────────

export async function runAllAgents(
  history: ChatMessage[],
  onDone: (result: AgentAnswer) => Promise<void>,
): Promise<AgentAnswer[]> {
  return Promise.all(
    (Object.values(AGENTS) as Agent[]).map(async (agent) => {
      const answer = await callAgent(agent, history);
      const result: AgentAnswer = { agent, answer };
      await onDone(result);
      return result;
    }),
  );
}

export async function runSelectedAgents(
  agentIds: AgentId[],
  history: ChatMessage[],
  onDone: (result: AgentAnswer) => Promise<void>,
): Promise<AgentAnswer[]> {
  return Promise.all(
    agentIds.map(async (id) => {
      const agent = AGENTS[id];
      const answer = await callAgent(agent, history);
      const result: AgentAnswer = { agent, answer };
      await onDone(result);
      return result;
    }),
  );
}

// ── Discussion mode — sequential, each agent sees previous ───────────────

const DISCUSSION_PROMPT = (agent: Agent, topic: string, prevTurns: AgentAnswer[]) => {
  const prev = prevTurns.length
    ? "\n\nЧто уже сказали коллеги:\n" +
      prevTurns.map((t) => `${t.agent.emoji} ${t.agent.firstName}: ${t.answer}`).join("\n\n")
    : "";
  return `${agent.systemPrompt}

Вы участвуете в совместном обсуждении с коллегами.${prev}

Тема обсуждения: «${topic}»

Выскажи свою точку зрения с учётом того, что сказали коллеги (если они уже говорили).
Можешь не соглашаться, дополнять или задавать риторический вопрос.
Максимум 5 предложений. Без markdown.`;
};

export async function runDiscussion(
  topic: string,
  history: ChatMessage[],
  onTurn: (result: AgentAnswer) => Promise<void>,
): Promise<AgentAnswer[]> {
  const order: AgentId[] = ["health", "finance", "personal", "tech"];
  const turns: AgentAnswer[] = [];

  for (const id of order) {
    const agent = AGENTS[id];
    const systemPrompt = DISCUSSION_PROMPT(agent, topic, turns);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: `Выскажись по теме: ${topic}` },
    ];
    let result = "";
    for await (const chunk of streamGroq(messages)) result += chunk;
    const answer = result.trim();
    const turn: AgentAnswer = { agent, answer };
    turns.push(turn);
    await onTurn(turn);
  }

  return turns;
}

// ── Reaction phase ────────────────────────────────────────────────────────

const REACTION_SYSTEM = (agent: Agent, others: AgentAnswer[]) => `
Ты — ${agent.emoji} ${agent.firstName} (${agent.name}). Отвечаешь только на русском.

Другие специалисты уже ответили:
${others.map((o) => `${o.agent.emoji} ${o.agent.firstName}: ${o.answer}`).join("\n\n")}

Реши — есть ли что добавить?

Варианты (выбери ОДИН):
1. Комментарий коллеге: начни с "@имя:" (используй имя: @Макс, @Аня, @Лёва, @Дима)
   Пример: "@Аня: важно учесть, что при высоких тратах на спорт..."
2. Вопрос коллеге: начни с "ВОПРОС @имя:"
   Пример: "ВОПРОС @Аня: сколько стоит качественный абонемент?"
3. Если добавить нечего — ответь одним словом: ПРОПУСТИТЬ

Максимум 3 предложения. Без markdown.
`.trim();

export async function runReactions(allAnswers: AgentAnswer[]): Promise<Reaction[]> {
  const NAME_TO_ID: Record<string, AgentId> = {
    макс: "health", max: "health",
    аня: "finance", anya: "finance",
    лёва: "personal", лева: "personal", lyova: "personal",
    дима: "tech", dima: "tech",
  };

  function resolveByName(name: string): AgentId | null {
    return NAME_TO_ID[name.toLowerCase()] ?? null;
  }

  const reactions = await Promise.all(
    allAnswers.map(async (myAnswer) => {
      const others = allAnswers.filter((a) => a.agent.id !== myAnswer.agent.id);
      const systemPrompt = REACTION_SYSTEM(myAnswer.agent, others);
      let raw = "";
      for await (const chunk of streamGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: "Твоя реакция:" },
      ])) raw += chunk;
      raw = raw.trim();

      if (!raw || raw.toUpperCase().startsWith("ПРОПУСТИТЬ")) return null;

      const questionMatch = raw.match(/^ВОПРОС\s+@(\w+):\s*(.+)$/is);
      if (questionMatch) {
        const targetId = resolveByName(questionMatch[1]);
        if (targetId && targetId !== myAnswer.agent.id) {
          return { kind: "question" as const, from: myAnswer.agent, to: AGENTS[targetId], text: questionMatch[2].trim() };
        }
      }

      return { kind: "comment" as const, agent: myAnswer.agent, text: raw };
    }),
  );

  return reactions.filter((r): r is Reaction => r !== null);
}

// ── Inter-agent question answer ───────────────────────────────────────────

export async function answerQuestion(
  q: Extract<Reaction, { kind: "question" }>,
): Promise<AgentQuestionAnswer> {
  const system = `Тебя зовут ${q.to.firstName}. ${q.to.systemPrompt}\nКоллега ${q.from.firstName} задаёт тебе вопрос. Отвечай по существу, максимум 4 предложения. Без markdown.`;
  let answer = "";
  for await (const chunk of streamGroq([
    { role: "system", content: system },
    { role: "user", content: q.text },
  ])) answer += chunk;
  return { from: q.from, to: q.to, question: q.text, answer: answer.trim() };
}

// ── Single agent (with tools + hiring + clarifying questions) ─────────────

export async function runSingleAgent(
  agentId: AgentId,
  history: ChatMessage[],
  chatId: number,
  onHire?: (event: HireEvent) => Promise<void>,
): Promise<{ agent: Agent; answer: string; pendingQuestion?: string }> {
  const agent = AGENTS[agentId];
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const userMessage =
    typeof lastUser?.content === "string" ? lastUser.content : "";
  const result = await callAgentWithTools(agent, history, userMessage, chatId, onHire);
  return { agent, ...result };
}

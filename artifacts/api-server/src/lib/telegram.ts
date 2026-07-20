import { Telegraf } from "telegraf";
import { db } from "@workspace/db";
import { conversations, messages, telegramSessions } from "@workspace/db";
import { eq, asc, desc } from "drizzle-orm";
import { logger } from "./logger";
import {
  runSelectedAgents,
  runDiscussion,
  runReactions,
  answerQuestion,
  runSingleAgent,
  runManager,
  AGENTS,
  ALIAS_MAP,
  type AgentId,
  type Agent,
  type ChatMessage,
  type AgentAnswer,
  type HireEvent,
} from "./agents";
import { type ContentPart } from "./groq";

// ── Pending intent (ТЗ §4 — clarifying questions) ──────────────────────────

interface PendingIntent {
  agentId: AgentId;
  originalMessage: string;
}

async function getPendingIntent(chatId: number): Promise<PendingIntent | null> {
  const session = await db.query.telegramSessions.findFirst({
    where: eq(telegramSessions.telegramChatId, chatId),
  });
  if (!session?.pendingIntent) return null;
  try { return JSON.parse(session.pendingIntent) as PendingIntent; } catch { return null; }
}

async function setPendingIntent(chatId: number, intent: PendingIntent | null): Promise<void> {
  const session = await db.query.telegramSessions.findFirst({
    where: eq(telegramSessions.telegramChatId, chatId),
  });
  if (!session) return; // no session yet — nothing to update
  await db.update(telegramSessions)
    .set({ pendingIntent: intent ? JSON.stringify(intent) : null })
    .where(eq(telegramSessions.telegramChatId, chatId));
}

// ── Rate limiting (ТЗ §6) ────────────────────────────────────────────────
// Max RATE_LIMIT messages per RATE_WINDOW_MS per user.

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const _rateCounts = new Map<number, { count: number; windowStart: number }>();

function checkRateLimit(chatId: number): boolean {
  const now = Date.now();
  const entry = _rateCounts.get(chatId);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    _rateCounts.set(chatId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ── Intent parsing ────────────────────────────────────────────────────────

const DISCUSSION_RE =
  /\b(обсуди(те)?|поговори(те)?|обсудим|подискутируй(те)?|что думаете|ваше мнение|поспорьте|поспорим)\b/i;

function parseIntent(text: string): {
  targets: AgentId[];
  question: string;
  isDiscussion: boolean;
} {
  const isDiscussion = DISCUSSION_RE.test(text);

  const aliases = Object.keys(ALIAS_MAP).sort((a, b) => b.length - a.length);
  const aliasPattern = aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  const found = new Set<AgentId>();
  let hasAll = false;

  let cleaned = text.replace(new RegExp(`@(all|все|всем|${aliasPattern})`, "gi"), (_, word) => {
    const key = word.toLowerCase();
    if (key === "all" || key === "все" || key === "всем") hasAll = true;
    else if (ALIAS_MAP[key]) found.add(ALIAS_MAP[key]);
    return " ";
  });

  cleaned = cleaned.replace(
    new RegExp(`^\\s*(${aliasPattern})(\\s+(и|,|&)\\s+(${aliasPattern}))*[,:]?`, "i"),
    (match) => {
      const nameRe = new RegExp(aliasPattern, "gi");
      for (const [m] of [...match.matchAll(nameRe)]) {
        const id = ALIAS_MAP[m.toLowerCase()];
        if (id) found.add(id);
      }
      return " ";
    },
  );

  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  const question = cleaned || text.trim();
  const targets = hasAll || found.size === 0 ? [] : [...found];
  return { targets, question, isDiscussion };
}

// ── DB helpers ────────────────────────────────────────────────────────────

async function getOrCreateConversation(chatId: number, name: string): Promise<number> {
  const existing = await db.query.telegramSessions.findFirst({
    where: eq(telegramSessions.telegramChatId, chatId),
  });
  if (existing) return existing.conversationId;

  const [conv] = await db
    .insert(conversations)
    .values({ title: `Telegram: ${name}` })
    .returning();
  await db.insert(telegramSessions).values({ telegramChatId: chatId, conversationId: conv.id });
  return conv.id;
}

/**
 * Load the most recent HISTORY_LIMIT messages for a conversation.
 * Keeping history short prevents hitting Groq's 12 000-token per-request limit.
 * We fetch descending (newest first) then reverse so the LLM sees chronological order.
 */
const HISTORY_LIMIT = 10; // last 5 user+assistant turns

async function loadHistory(conversationId: number): Promise<ChatMessage[]> {
  const rows = await db.select().from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_LIMIT);
  return rows
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

// ── Telegram helpers ──────────────────────────────────────────────────────

async function sendOrEdit(
  bot: Telegraf,
  chatId: number,
  messageId: number | null,
  text: string,
): Promise<number> {
  if (messageId) {
    try {
      await bot.telegram.editMessageText(chatId, messageId, undefined, text);
      return messageId;
    } catch { /* fall through to send */ }
  }
  const sent = await bot.telegram.sendMessage(chatId, text);
  return sent.message_id;
}

function makeHireHandler(
  bot: Telegraf,
  chatId: number,
  agentFirstName: string,
  agentEmoji: string,
) {
  return async (hire: HireEvent) => {
    await bot.telegram.sendMessage(
      chatId,
      `${agentEmoji} ${agentFirstName} привлекает: ${hire.emoji} ${hire.role}...`,
    );
    await bot.telegram.sendMessage(chatId, `${hire.emoji} ${hire.role}:\n\n${hire.answer}`);
  };
}

// ── Fire-and-forget (avoids Telegraf's 90 s handler timeout) ─────────────
// Groq calls can take longer than 90 s. Since we send a placeholder
// message first, returning early from the Telegraf handler is safe.

function fireAndForget(fn: () => Promise<void>): void {
  fn().catch((err) => logger.error({ err }, "Async handler error"));
}

// ── Active-agent tracking ─────────────────────────────────────────────────
// Per-chat: which single agent the user is currently talking to.

const activeAgent = new Map<number, AgentId | null>();

// ── Bot ───────────────────────────────────────────────────────────────────

export function startTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return;
  }

  logger.info("Telegram bot: initializing...");
  const bot = new Telegraf(token);

  // ── /ping ─────────────────────────────────────────────────────────────
  bot.command("ping", async (ctx) => {
    await ctx.reply("pong 🏓");
  });

  // ── /start ────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    await ctx.reply(
      "Привет! Я Советник.\n\n" +
      "🧭 Мия — твой личный менеджер. Она всегда на связи и сама решает, кто из команды поможет лучше:\n\n" +
      "💪 Макс — здоровье, спорт, питание\n" +
      "💰 Аня — финансы, расходы, бизнес\n" +
      "🧠 Лёва — задачи, личные вопросы, продуктивность\n" +
      "💻 Дима — программирование, технологии\n\n" +
      "Просто пиши — Мия разберётся кому передать или ответит сама.\n" +
      "Хочешь напрямую к специалисту — обратись по имени: «Дима, как написать REST API?»\n" +
      "Хочешь дискуссию — «Обсудите, стоит ли менять стек»\n\n" +
      "/new — новый разговор  |  /help — справка",
    );
  });

  // ── /help ─────────────────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    await ctx.reply(
      "Как работает Советник:\n\n" +
      "🧭 Просто пиши — Мия оценит запрос и либо ответит сама, либо передаст нужному специалисту.\n\n" +
      "Прямое обращение к специалисту:\n" +
      "• «Макс, как похудеть?» или @макс → Макс 💪\n" +
      "• «Аня, мой бюджет» или @аня → Аня 💰\n" +
      "• «Лёва, добавь задачу» или @лёва → Лёва 🧠\n" +
      "• «Дима, помоги с кодом» или @дима → Дима 💻\n" +
      "• «Аня и Дима, вопрос» → оба ответят\n" +
      "• «Обсудите [тему]» → дискуссия\n\n" +
      "Что умеют:\n" +
      "💰 Аня — запишет расход: «потратил 1500 на продукты»\n" +
      "💪 Макс — зафиксирует тренировку, составит план\n" +
      "🧠 Лёва — добавит задачу или напоминание\n" +
      "💻 Дима — разберёт код, поможет с отладкой\n\n" +
      "/new — начать новый разговор",
    );
  });

  // ── /new ──────────────────────────────────────────────────────────────
  bot.command("new", async (ctx) => {
    const chatId = ctx.chat.id;
    const existing = await db.query.telegramSessions.findFirst({
      where: eq(telegramSessions.telegramChatId, chatId),
    });
    if (existing) {
      const name = ctx.from?.first_name ?? "чат";
      const [conv] = await db.insert(conversations).values({ title: `Telegram: ${name}` }).returning();
      await db.update(telegramSessions)
        .set({ conversationId: conv.id, pendingIntent: null })
        .where(eq(telegramSessions.telegramChatId, chatId));
    }
    activeAgent.delete(chatId);
    await ctx.reply("Начат новый разговор. История предыдущего сохранена.");
  });

  // ── /health /finance /personal /tech (legacy shortcuts) ───────────────
  async function handleAgentCommand(
    ctx: Parameters<Parameters<typeof bot.command>[1]>[0],
    agentId: AgentId,
  ): Promise<void> {
    const chatId = ctx.chat.id;
    if (!checkRateLimit(chatId)) {
      await ctx.reply("⏳ Слишком много запросов. Подожди немного.");
      return;
    }
    const name = ctx.from?.first_name ?? String(chatId);
    const raw = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const userText = raw.replace(/^\/\w+\s*/, "").trim();
    const agent = AGENTS[agentId];

    if (!userText) {
      await ctx.reply(`${agent.emoji} ${agent.firstName} слушает. Напиши:\n${agent.firstName}, твой вопрос`);
      return;
    }

    activeAgent.set(chatId, agentId);
    const conversationId = await getOrCreateConversation(chatId, name);
    await db.insert(messages).values({ conversationId, role: "user", content: userText });
    const history = await loadHistory(conversationId);

    const placeholder = await ctx.reply(`${agent.emoji} ${agent.firstName} думает...`);
    try {
      const { answer, pendingQuestion } = await runSingleAgent(
        agentId,
        history,
        chatId,
        makeHireHandler(bot, chatId, agent.firstName, agent.emoji),
      );

      if (pendingQuestion) {
        await setPendingIntent(chatId, { agentId, originalMessage: userText });
        // Save the bot's clarifying question as assistant message for context
        await db.insert(messages).values({ conversationId, role: "assistant", content: pendingQuestion });
        await sendOrEdit(bot, chatId, placeholder.message_id, `${agent.emoji} ${agent.firstName}: ${pendingQuestion}`);
        return;
      }

      const reply = `${agent.emoji} ${agent.firstName}\n\n${answer}`;
      await sendOrEdit(bot, chatId, placeholder.message_id, reply);
      await db.insert(messages).values({ conversationId, role: "assistant", content: reply });
    } catch (err) {
      logger.error({ err }, "Single-agent command error");
      await sendOrEdit(bot, chatId, placeholder.message_id, `Произошла ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  bot.command("health",   (ctx) => fireAndForget(() => handleAgentCommand(ctx, "health")));
  bot.command("finance",  (ctx) => fireAndForget(() => handleAgentCommand(ctx, "finance")));
  bot.command("personal", (ctx) => fireAndForget(() => handleAgentCommand(ctx, "personal")));
  bot.command("tech",     (ctx) => fireAndForget(() => handleAgentCommand(ctx, "tech")));

  // ── Core message router ───────────────────────────────────────────────
  async function handleMessage(
    chatId: number,
    name: string,
    rawText: string,
    userContent: string | ContentPart[],
  ): Promise<void> {

    // ── Rate limiting (ТЗ §6) ───────────────────────────────────────────
    if (!checkRateLimit(chatId)) {
      await bot.telegram.sendMessage(chatId, "⏳ Слишком много запросов. Подожди минуту.");
      return;
    }

    // ── pending_intent check (ТЗ §4) ────────────────────────────────────
    const pending = await getPendingIntent(chatId);
    if (pending) {
      await setPendingIntent(chatId, null); // clear immediately
      const conversationId = await getOrCreateConversation(chatId, name);
      const dbText = typeof userContent === "string" ? userContent : rawText;
      await db.insert(messages).values({ conversationId, role: "user", content: dbText });

      const history = await loadHistory(conversationId);
      if (history.length > 0 && history[history.length - 1].role === "user") {
        history[history.length - 1] = { role: "user", content: userContent };
      }

      const agent = AGENTS[pending.agentId];
      activeAgent.set(chatId, pending.agentId);
      const placeholder = await bot.telegram.sendMessage(chatId, `${agent.emoji} ${agent.firstName} думает...`);
      const { answer, pendingQuestion: nextQuestion } = await runSingleAgent(
        pending.agentId,
        history,
        chatId,
        makeHireHandler(bot, chatId, agent.firstName, agent.emoji),
      );

      if (nextQuestion) {
        // Agent still needs more info — update pending_intent
        await setPendingIntent(chatId, { agentId: pending.agentId, originalMessage: rawText });
        await db.insert(messages).values({ conversationId, role: "assistant", content: nextQuestion });
        await sendOrEdit(bot, chatId, placeholder.message_id, `${agent.emoji} ${agent.firstName}: ${nextQuestion}`);
        return;
      }

      const reply = `${agent.emoji} ${agent.firstName}\n\n${answer}`;
      await sendOrEdit(bot, chatId, placeholder.message_id, reply);
      await db.insert(messages).values({ conversationId, role: "assistant", content: reply });
      return;
    }

    // ── Normal routing ───────────────────────────────────────────────────
    const { targets, question, isDiscussion } = parseIntent(rawText);

    const conversationId = await getOrCreateConversation(chatId, name);
    const dbText = typeof userContent === "string" ? userContent : rawText;
    await db.insert(messages).values({ conversationId, role: "user", content: dbText });

    const history = await loadHistory(conversationId);
    if (history.length > 0 && history[history.length - 1].role === "user") {
      history[history.length - 1] = { role: "user", content: userContent };
    }

    // Resolve effective targets (active-agent continuity)
    let effectiveTargets = targets;
    if (targets.length === 0 && !isDiscussion) {
      const current = activeAgent.get(chatId);
      if (current) effectiveTargets = [current];
    }

    // ── Single agent ─────────────────────────────────────────────────────
    if (effectiveTargets.length === 1) {
      const agentId = effectiveTargets[0];
      const agent = AGENTS[agentId];
      activeAgent.set(chatId, agentId);
      const placeholder = await bot.telegram.sendMessage(chatId, `${agent.emoji} ${agent.firstName} думает...`);
      const { answer, pendingQuestion } = await runSingleAgent(
        agentId,
        history,
        chatId,
        makeHireHandler(bot, chatId, agent.firstName, agent.emoji),
      );

      if (pendingQuestion) {
        await setPendingIntent(chatId, { agentId, originalMessage: rawText });
        await db.insert(messages).values({ conversationId, role: "assistant", content: pendingQuestion });
        await sendOrEdit(bot, chatId, placeholder.message_id, `${agent.emoji} ${agent.firstName}: ${pendingQuestion}`);
        return;
      }

      const reply = `${agent.emoji} ${agent.firstName}\n\n${answer}`;
      await sendOrEdit(bot, chatId, placeholder.message_id, reply);
      await db.insert(messages).values({ conversationId, role: "assistant", content: reply });
      return;
    }

    // ── Discussion mode ──────────────────────────────────────────────────
    if (isDiscussion) {
      activeAgent.delete(chatId);
      const headerMsg = await bot.telegram.sendMessage(chatId, "💬 Начинаю обсуждение...");
      const placeholders: Record<string, number> = {};

      for (const agent of Object.values(AGENTS)) {
        const msg = await bot.telegram.sendMessage(chatId, `${agent.emoji} ${agent.firstName} обдумывает...`);
        placeholders[agent.id] = msg.message_id;
      }

      try { await bot.telegram.deleteMessage(chatId, headerMsg.message_id); } catch { /* ok */ }

      const turns = await runDiscussion(question, history, async ({ agent, answer }) => {
        await sendOrEdit(bot, chatId, placeholders[agent.id], `${agent.emoji} ${agent.firstName}\n\n${answer}`);
      });

      const saved = turns.map((t) => `${t.agent.emoji} ${t.agent.firstName}\n${t.answer}`).join("\n\n─────\n\n");
      await db.insert(messages).values({ conversationId, role: "assistant", content: saved });
      return;
    }

    // ── No explicit target → Manager decides ────────────────────────────
    if (effectiveTargets.length === 0) {
      const managerPlaceholder = await bot.telegram.sendMessage(chatId, "🧭 Мия думает...");

      const decision = await runManager(history, chatId, (agent: Agent, question: string) => {
        // Fire-and-forget status update when a consultation starts
        bot.telegram.editMessageText(
          chatId, managerPlaceholder.message_id, undefined,
          `🧭 Мия консультирует ${agent.emoji} ${agent.firstName}...`,
        ).catch(() => {});
      });

      if (decision.kind === "answer") {
        // Manager answers directly
        const reply = `🧭 Мия\n\n${decision.text}`;
        await sendOrEdit(bot, chatId, managerPlaceholder.message_id, reply);
        await db.insert(messages).values({ conversationId, role: "assistant", content: reply });
        return;
      }

      if (decision.kind === "route") {
        // Manager introduces the specialist, then specialist answers
        const specialist = AGENTS[decision.agentId];
        activeAgent.set(chatId, decision.agentId);

        const introText = decision.intro
          ? `🧭 Мия\n\n${decision.intro}`
          : `🧭 Мия\n\nПередаю тебя к ${specialist.firstName} ${specialist.emoji}`;
        await sendOrEdit(bot, chatId, managerPlaceholder.message_id, introText);
        await db.insert(messages).values({ conversationId, role: "assistant", content: introText });

        const specPlaceholder = await bot.telegram.sendMessage(chatId, `${specialist.emoji} ${specialist.firstName} думает...`);
        const { answer, pendingQuestion } = await runSingleAgent(
          decision.agentId, history, chatId,
          makeHireHandler(bot, chatId, specialist.firstName, specialist.emoji),
        );

        if (pendingQuestion) {
          await setPendingIntent(chatId, { agentId: decision.agentId, originalMessage: rawText });
          await db.insert(messages).values({ conversationId, role: "assistant", content: pendingQuestion });
          await sendOrEdit(bot, chatId, specPlaceholder.message_id, `${specialist.emoji} ${specialist.firstName}: ${pendingQuestion}`);
          return;
        }

        const specReply = `${specialist.emoji} ${specialist.firstName}\n\n${answer}`;
        await sendOrEdit(bot, chatId, specPlaceholder.message_id, specReply);
        await db.insert(messages).values({ conversationId, role: "assistant", content: specReply });
        return;
      }

      if (decision.kind === "consult") {
        // Show each consultation result, then manager's synthesis
        for (const c of decision.results) {
          await bot.telegram.sendMessage(chatId, `${c.agent.emoji} ${c.agent.firstName}\n\n${c.answer}`);
        }
        const synthesis = `🧭 Мия\n\n${decision.synthesis}`;
        await sendOrEdit(bot, chatId, managerPlaceholder.message_id, synthesis);
        const saved =
          decision.results.map((c) => `${c.agent.emoji} ${c.agent.firstName}\n${c.answer}`).join("\n\n─────\n\n") +
          `\n\n─────\n\n${synthesis}`;
        await db.insert(messages).values({ conversationId, role: "assistant", content: saved });
        return;
      }
    }

    // ── Multiple agents (explicit subset) ────────────────────────────────
    activeAgent.delete(chatId);
    const agentIds: AgentId[] = effectiveTargets;

    const placeholders: Record<string, number> = {};
    for (const agent of agentIds.map((id) => AGENTS[id])) {
      const msg = await bot.telegram.sendMessage(chatId, `${agent.emoji} ${agent.firstName} думает...`);
      placeholders[agent.id] = msg.message_id;
    }

    const allAnswers: AgentAnswer[] = [];
    const onDone = async ({ agent, answer }: AgentAnswer) => {
      await sendOrEdit(bot, chatId, placeholders[agent.id], `${agent.emoji} ${agent.firstName}\n\n${answer}`);
      allAnswers.push({ agent, answer });
    };

    await runSelectedAgents(agentIds, history, onDone);

    const saved = allAnswers
      .map((a) => `${a.agent.emoji} ${a.agent.firstName}\n${a.answer}`)
      .join("\n\n─────\n\n");
    await db.insert(messages).values({ conversationId, role: "assistant", content: saved });
  }

  // ── Plain text ────────────────────────────────────────────────────────
  bot.on("text", (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const raw = ctx.message.text.trim();
    if (!raw) return;
    fireAndForget(() =>
      handleMessage(ctx.chat.id, ctx.from?.first_name ?? String(ctx.chat.id), raw, raw)
        .catch(async (err) => {
          logger.error({ err }, "Text handler error");
          await bot.telegram.sendMessage(ctx.chat.id, `Произошла ошибка: ${err instanceof Error ? err.message : String(err)}`);
        })
    );
  });

  // ── Photos ────────────────────────────────────────────────────────────
  bot.on("photo", (ctx) => {
    const chatId = ctx.chat.id;
    const name = ctx.from?.first_name ?? String(chatId);
    const caption = ctx.message.caption?.trim() ?? "Что на этом фото? Опиши подробно.";
    fireAndForget(async () => {
      const statusMsg = await bot.telegram.sendMessage(chatId, "🖼 Загружаю фото...");
      try {
        const largest = ctx.message.photo[ctx.message.photo.length - 1];
        const fileLink = await bot.telegram.getFileLink(largest.file_id);
        const res = await fetch(fileLink.href);
        const buffer = Buffer.from(await res.arrayBuffer());
        const base64 = buffer.toString("base64");
        await bot.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        const userContent: ContentPart[] = [
          { type: "text", text: caption },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ];
        await handleMessage(chatId, name, caption, userContent);
      } catch (err) {
        logger.error({ err }, "Photo handler error");
        await sendOrEdit(bot, chatId, statusMsg.message_id, `Не удалось обработать фото: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  // ── Documents ────────────────────────────────────────────────────────
  bot.on("document", (ctx) => {
    const chatId = ctx.chat.id;
    const name = ctx.from?.first_name ?? String(chatId);
    const doc = ctx.message.document;
    const mime = doc.mime_type ?? "";
    const caption = ctx.message.caption?.trim() ?? "Проанализируй этот документ.";
    const fileName = doc.file_name ?? "";

    const isText = mime.startsWith("text/") ||
      ["application/json", "application/javascript", "application/xml"].includes(mime) ||
      /\.(txt|md|js|ts|jsx|tsx|py|json|csv|xml|html|css|sh|yaml|yml|toml|log|env)$/i.test(fileName);
    const isPdf = mime === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");

    if (!isText && !isPdf) {
      bot.telegram.sendMessage(
        chatId,
        "📎 Поддерживаются: текстовые файлы (.txt, .js, .py, .json, .csv, .md и др.) и PDF.\n" +
        "Word, Excel и другие бинарные форматы не поддерживаются.",
      ).catch(() => {});
      return;
    }

    fireAndForget(async () => {
      const statusMsg = await bot.telegram.sendMessage(chatId, "📎 Читаю файл...");
      try {
        const fileLink = await bot.telegram.getFileLink(doc.file_id);
        const res = await fetch(fileLink.href);
        const buffer = Buffer.from(await res.arrayBuffer());

        let fileText: string;
        if (isPdf) {
          const pdfModule = await import("pdf-parse");
          const pdfParse = (pdfModule.default ?? pdfModule) as (b: Buffer) => Promise<{ text: string }>;
          const parsed = await pdfParse(buffer);
          fileText = parsed.text;
        } else {
          fileText = buffer.toString("utf-8");
        }

        const trimmed = fileText.length > 12_000
          ? fileText.slice(0, 12_000) + "\n\n...[файл обрезан до 12 000 символов]"
          : fileText;
        const userContent = `${caption}\n\nСодержимое файла «${fileName || "документ"}»:\n\n${trimmed}`;
        await bot.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        await handleMessage(chatId, name, caption, userContent);
      } catch (err) {
        logger.error({ err }, "Document handler error");
        await sendOrEdit(bot, chatId, statusMsg.message_id, `Не удалось прочитать файл: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  bot.launch().then(() => {
    logger.info("Telegram bot started (polling)");
  }).catch((err) => {
    logger.error({ err }, "Failed to start Telegram bot");
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

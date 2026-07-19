import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { db } from "@workspace/db";
import { conversations, messages, telegramSessions } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { logger } from "./logger";
import {
  runMultiAgent,
  runSingleAgent,
  AGENTS,
  type AgentId,
  type AgentTurn,
  type ChatMessage,
} from "./agents";

async function getOrCreateConversation(chatId: number, chatTitle: string): Promise<number> {
  const existing = await db.query.telegramSessions.findFirst({
    where: eq(telegramSessions.telegramChatId, chatId),
  });
  if (existing) return existing.conversationId;

  const [conv] = await db
    .insert(conversations)
    .values({ title: `Telegram: ${chatTitle}` })
    .returning();

  await db.insert(telegramSessions).values({
    telegramChatId: chatId,
    conversationId: conv.id,
  });

  return conv.id;
}

/** Build the live message text from accumulated turns */
function buildDiscussionText(turns: AgentTurn[], done = false): string {
  const lines = turns.map((t) => {
    const from = t.question.includes("спрашивает")
      ? `   ↗️ ${t.question}\n   ${t.agent.emoji} ${t.agent.name}: ${t.answer}`
      : `${t.agent.emoji} ${t.agent.name}:\n${t.answer}`;
    return from;
  });

  if (!done) return lines.join("\n\n") + "\n\n⏳ ...";
  return lines.join("\n\n");
}

export function startTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return;
  }

  const bot = new Telegraf(token);

  // ── /start ──────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    await ctx.reply(
      "Привет! Я Советник — команда из трёх AI-специалистов.\n\n" +
      "💪 /health — Здоровье & Спорт\n" +
      "💰 /finance — Финансы & Бизнес\n" +
      "🧠 /personal — Личные дела\n\n" +
      "Просто напиши вопрос — все трое обсудят вместе.\n" +
      "Или начни с команды, чтобы обратиться к конкретному специалисту.\n\n" +
      "/new — новый разговор  |  /help — справка"
    );
  });

  // ── /help ────────────────────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    await ctx.reply(
      "Команды:\n\n" +
      "💪 /health [вопрос] — спросить специалиста по здоровью\n" +
      "💰 /finance [вопрос] — спросить финансового советника\n" +
      "🧠 /personal [вопрос] — спросить по личным делам\n\n" +
      "Без команды — все трое обсуждают вместе.\n" +
      "Агенты могут сами обращаться друг к другу если нужно.\n\n" +
      "/new — начать новый разговор"
    );
  });

  // ── /new ─────────────────────────────────────────────────────────────────
  bot.command("new", async (ctx) => {
    const chatId = ctx.chat.id;
    const existing = await db.query.telegramSessions.findFirst({
      where: eq(telegramSessions.telegramChatId, chatId),
    });
    if (existing) {
      const name = ctx.from?.first_name ?? "чат";
      const [conv] = await db
        .insert(conversations)
        .values({ title: `Telegram: ${name}` })
        .returning();
      await db
        .update(telegramSessions)
        .set({ conversationId: conv.id })
        .where(eq(telegramSessions.telegramChatId, chatId));
    }
    await ctx.reply("Начат новый разговор. История предыдущего сохранена.");
  });

  // ── Handler for single-agent commands (/health, /finance, /personal) ────
  async function handleAgentCommand(
    ctx: Parameters<Parameters<typeof bot.command>[1]>[0],
    agentId: AgentId,
  ) {
    const chatId = ctx.chat.id;
    const chatTitle = ctx.from?.first_name ?? String(chatId);

    // Extract question from command args
    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const userText = text.replace(/^\/\w+\s*/, "").trim();

    if (!userText) {
      const agent = AGENTS[agentId];
      await ctx.reply(`${agent.emoji} ${agent.name} слушает. Напиши свой вопрос после команды.\nПример: /${agentId} Как улучшить сон?`);
      return;
    }

    await ctx.sendChatAction("typing");

    try {
      const conversationId = await getOrCreateConversation(chatId, chatTitle);
      await db.insert(messages).values({ conversationId, role: "user", content: userText });

      const history = await db.select().from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt));

      const chatMessages: ChatMessage[] = history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      const turns: AgentTurn[] = [];
      const statusMsg = await ctx.reply(`${AGENTS[agentId].emoji} думает...`);

      const { finalAnswer } = await runSingleAgent(agentId, chatMessages, async (turn) => {
        turns.push(turn);
        try {
          await ctx.telegram.editMessageText(
            chatId, statusMsg.message_id, undefined,
            buildDiscussionText(turns, false)
          );
        } catch { /* ignore */ }
      });

      const fullMessage = buildDiscussionText(turns, true);

      try {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, fullMessage);
      } catch {
        await ctx.reply(fullMessage);
      }

      await db.insert(messages).values({ conversationId, role: "assistant", content: fullMessage });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Telegram bot error");
      await ctx.reply(`Произошла ошибка: ${errMsg}`);
    }
  }

  bot.command("health",   (ctx) => handleAgentCommand(ctx, "health"));
  bot.command("finance",  (ctx) => handleAgentCommand(ctx, "finance"));
  bot.command("personal", (ctx) => handleAgentCommand(ctx, "personal"));

  // ── Text messages → all agents discuss ───────────────────────────────────
  bot.on(message("text"), async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    const chatTitle = ctx.from?.first_name ?? String(chatId);

    await ctx.sendChatAction("typing");

    try {
      const conversationId = await getOrCreateConversation(chatId, chatTitle);
      await db.insert(messages).values({ conversationId, role: "user", content: userText });

      const history = await db.select().from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt));

      const chatMessages: ChatMessage[] = history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      const turns: AgentTurn[] = [];
      const statusMsg = await ctx.reply("💪 💰 🧠 Специалисты обсуждают...");

      const { finalAnswer } = await runMultiAgent(chatMessages, async (turn) => {
        turns.push(turn);
        try {
          await ctx.telegram.editMessageText(
            chatId, statusMsg.message_id, undefined,
            buildDiscussionText(turns, false)
          );
        } catch { /* ignore */ }
      });

      const discussion = buildDiscussionText(turns, true);
      const fullMessage = `${discussion}\n\n─────────────────\n✅ Общий ответ:\n\n${finalAnswer}`;

      try {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, fullMessage);
      } catch {
        await ctx.reply(fullMessage);
      }

      await db.insert(messages).values({ conversationId, role: "assistant", content: fullMessage });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Telegram bot error");
      await ctx.reply(`Произошла ошибка: ${errMsg}`);
    }
  });

  bot.launch().then(() => {
    logger.info("Telegram bot started (polling)");
  }).catch((err) => {
    logger.error({ err }, "Failed to start Telegram bot");
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

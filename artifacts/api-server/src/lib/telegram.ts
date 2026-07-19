import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { db } from "@workspace/db";
import { conversations, messages, telegramSessions } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { logger } from "./logger";
import { runMultiAgent, type ChatMessage } from "./agents";

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

export function startTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return;
  }

  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    await ctx.reply(
      "Привет! Я Советник — команда из трёх AI-специалистов:\n\n" +
      "💪 Здоровье & Спорт\n" +
      "💰 Финансы & Бизнес\n" +
      "🧠 Личные дела\n\n" +
      "Задай любой вопрос — все трое обсудят и дадут общий ответ."
    );
  });

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
    await ctx.reply("Начат новый разговор. История предыдущего сохранена, но больше не используется.");
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "Команды:\n" +
      "/new — начать новый разговор (очистить контекст)\n" +
      "/help — эта справка\n\n" +
      "Просто пиши любой вопрос — специалисты обсудят и ответят совместно."
    );
  });

  bot.on(message("text"), async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    const chatTitle = ctx.from?.first_name ?? String(chatId);

    await ctx.sendChatAction("typing");

    try {
      const conversationId = await getOrCreateConversation(chatId, chatTitle);

      await db.insert(messages).values({
        conversationId,
        role: "user",
        content: userText,
      });

      // Load history for context
      const history = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt));

      const chatMessages: ChatMessage[] = history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Show "agents are thinking" status
      const statusMsg = await ctx.reply("💪 💰 🧠 Специалисты обсуждают...");

      // Run multi-agent pipeline
      const { agentResponses, finalAnswer } = await runMultiAgent(chatMessages);

      // Build the full message: individual opinions + combined answer
      const agentBlock = agentResponses
        .map((r) => `${r.agent.emoji} ${r.agent.name}:\n${r.text}`)
        .join("\n\n");

      const fullMessage = `${agentBlock}\n\n─────────────────\n✅ Общий ответ:\n\n${finalAnswer}`;

      // Replace status message with the real answer
      try {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, fullMessage);
      } catch {
        await ctx.reply(fullMessage);
      }

      // Save assistant response to history
      await db.insert(messages).values({
        conversationId,
        role: "assistant",
        content: fullMessage,
      });
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

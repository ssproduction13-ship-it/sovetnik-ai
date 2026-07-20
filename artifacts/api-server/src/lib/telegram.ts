import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { db } from "@workspace/db";
import { conversations, messages, telegramSessions } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { logger } from "./logger";
import { runAgent, type ChatMessage, type Consultation } from "./agents";

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getOrCreateConversation(chatId: number, name: string): Promise<number> {
  const existing = await db.query.telegramSessions.findFirst({
    where: eq(telegramSessions.telegramChatId, chatId),
  });
  if (existing) return existing.conversationId;

  const [conv] = await db
    .insert(conversations)
    .values({ title: `Telegram: ${name}` })
    .returning();

  await db.insert(telegramSessions).values({
    telegramChatId: chatId,
    conversationId: conv.id,
  });

  return conv.id;
}

// ── Telegram bot ──────────────────────────────────────────────────────────────

export function startTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return;
  }

  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    await ctx.reply(
      "Привет! Я Советник.\n\n" +
      "Задай любой вопрос — я отвечу сам или привлеку нужного эксперта:\n" +
      "💪 Здоровье & Спорт\n" +
      "💰 Финансы & Бизнес\n" +
      "🧠 Личные дела\n\n" +
      "/new — начать новый разговор"
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "Просто пиши — я сам решу, нужна ли консультация экспертов.\n\n" +
      "/new — очистить историю разговора"
    );
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat.id;
    const name = ctx.from?.first_name ?? String(chatId);
    const [conv] = await db
      .insert(conversations)
      .values({ title: `Telegram: ${name}` })
      .returning();

    const existing = await db.query.telegramSessions.findFirst({
      where: eq(telegramSessions.telegramChatId, chatId),
    });

    if (existing) {
      await db
        .update(telegramSessions)
        .set({ conversationId: conv.id })
        .where(eq(telegramSessions.telegramChatId, chatId));
    } else {
      await db.insert(telegramSessions).values({ telegramChatId: chatId, conversationId: conv.id });
    }

    await ctx.reply("Начат новый разговор.");
  });

  bot.on(message("text"), async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    const name = ctx.from?.first_name ?? String(chatId);

    await ctx.sendChatAction("typing");

    try {
      const conversationId = await getOrCreateConversation(chatId, name);

      await db.insert(messages).values({
        conversationId,
        role: "user",
        content: userText,
      });

      const history = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt));

      const chatMessages: ChatMessage[] = history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Show thinking indicator
      const statusMsg = await ctx.reply("⏳");

      // Collect consultations for live updates
      const consultations: Consultation[] = [];

      const { answer } = await runAgent(chatMessages, async (consultation) => {
        consultations.push(consultation);

        // Update status to show which expert is being consulted
        const consulting = consultations
          .map((c) => `${c.specialist.emoji} ${c.specialist.name}`)
          .join(", ");

        try {
          await ctx.telegram.editMessageText(
            chatId,
            statusMsg.message_id,
            undefined,
            `⏳ Консультирую: ${consulting}...`
          );
        } catch { /* ignore edit errors */ }
      });

      // Build final message: consultations (if any) + main answer
      let fullMessage = "";

      if (consultations.length > 0) {
        const consultBlock = consultations
          .map((c) => `${c.specialist.emoji} ${c.specialist.name}:\n${c.answer}`)
          .join("\n\n");
        fullMessage = `${consultBlock}\n\n─────────────────\n${answer}`;
      } else {
        fullMessage = answer;
      }

      try {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          undefined,
          fullMessage
        );
      } catch {
        await ctx.reply(fullMessage);
      }

      await db.insert(messages).values({
        conversationId,
        role: "assistant",
        content: fullMessage,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Telegram bot error");
      await ctx.reply(`Ошибка: ${errMsg}`);
    }
  });

  bot.launch()
    .then(() => logger.info("Telegram bot started"))
    .catch((err) => logger.error({ err }, "Failed to start Telegram bot"));

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { GoogleGenAI } from "@google/genai";
import { db } from "@workspace/db";
import { conversations, messages, telegramSessions } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { logger } from "./logger";

const SYSTEM_PROMPT = `You are Советник — a personal AI advisor for a Russian-speaking user. You speak Russian by default unless the user writes in another language.

You are simultaneously:
- A real estate expert helping sell their house in Tyumen (100 sq m, 5 million rubles asking price, located 25 km from the city center). Help with: writing listings, negotiating strategies, preparing documents, market analysis.
- A personal finance advisor: budgeting, income/expense planning, financial goals.
- An investment analyst: Russian and international markets, stocks, bonds, real estate investment, risk assessment.
- A business analyst: P&L analysis, revenue forecasts, cost optimization, business strategy.
- An accountant: tax planning, expense reporting, financial statements.

Be specific, practical, and concise. Provide real, actionable advice. Use numbers and examples. Never refuse to help with financial analysis or give vague disclaimers instead of real advice.

You are responding via Telegram. Keep responses clear and well-structured. Use plain text formatting (avoid markdown that doesn't render in Telegram, but use line breaks and lists for clarity).`;

function getGenAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY must be set in environment variables");
  return new GoogleGenAI({ apiKey });
}

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
      "Привет! Я Советник — твой личный AI-помощник по финансам, недвижимости и бизнесу.\n\n" +
      "Я знаю о твоём доме в Тюмени и готов помочь с:\n" +
      "• Продажей дома (объявления, переговоры, документы)\n" +
      "• Личным бюджетом и планированием\n" +
      "• Инвестициями (российский и международный рынок)\n" +
      "• Бизнес-аналитикой (P&L, прогнозы)\n\n" +
      "Просто напиши свой вопрос."
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
      "Просто пиши любой вопрос — я отвечу."
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

      const history = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt));

      const genai = getGenAI();

      const contents = history.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

      const stream = await genai.models.generateContentStream({
        model: "gemini-2.5-flash",
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          maxOutputTokens: 8192,
        },
      });

      let fullResponse = "";
      let sentMessage: Awaited<ReturnType<typeof ctx.reply>> | null = null;
      let lastEditAt = 0;
      const EDIT_INTERVAL_MS = 1000;

      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) {
          fullResponse += text;
          const now = Date.now();
          if (!sentMessage) {
            sentMessage = await ctx.reply(fullResponse + " ▌");
            lastEditAt = now;
          } else if (now - lastEditAt > EDIT_INTERVAL_MS) {
            try {
              await ctx.telegram.editMessageText(
                chatId,
                sentMessage.message_id,
                undefined,
                fullResponse + " ▌"
              );
              lastEditAt = now;
            } catch {
              // ignore edit conflicts
            }
          }
        }
      }

      if (sentMessage && fullResponse) {
        try {
          await ctx.telegram.editMessageText(
            chatId,
            sentMessage.message_id,
            undefined,
            fullResponse
          );
        } catch { /* ignore */ }
      } else if (!sentMessage && fullResponse) {
        await ctx.reply(fullResponse);
      }

      await db.insert(messages).values({
        conversationId,
        role: "assistant",
        content: fullResponse,
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

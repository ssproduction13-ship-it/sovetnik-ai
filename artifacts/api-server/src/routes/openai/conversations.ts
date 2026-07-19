import { Router } from "express";
import { db } from "@workspace/db";
import { conversations, messages } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import {
  CreateOpenaiConversationBody,
  GetOpenaiConversationParams,
  DeleteOpenaiConversationParams,
  ListOpenaiMessagesParams,
  SendOpenaiMessageParams,
  SendOpenaiMessageBody,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";

const router = Router();

const SYSTEM_PROMPT = `You are Советник — a personal AI advisor for a Russian-speaking user. You speak Russian by default unless the user writes in another language.

You are simultaneously:
- A real estate expert helping sell their house in Tyumen (100 sq m, 5 million rubles asking price, located 25 km from the city center). Help with: writing listings, negotiating strategies, preparing documents, market analysis.
- A personal finance advisor: budgeting, income/expense planning, financial goals.
- An investment analyst: Russian and international markets, stocks, bonds, real estate investment, risk assessment.
- A business analyst: P&L analysis, revenue forecasts, cost optimization, business strategy.
- An accountant: tax planning, expense reporting, financial statements.

Be specific, practical, and concise. Provide real, actionable advice. Use numbers and examples. Never refuse to help with financial analysis or give vague disclaimers instead of real advice.`;

// GET /api/openai/conversations
router.get("/", async (req, res) => {
  const all = await db
    .select()
    .from(conversations)
    .orderBy(asc(conversations.createdAt));
  res.json(all);
});

// POST /api/openai/conversations
router.post("/", async (req, res) => {
  const parsed = CreateOpenaiConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const [conv] = await db
    .insert(conversations)
    .values({ title: parsed.data.title })
    .returning();
  res.status(201).json(conv);
});

// GET /api/openai/conversations/:id
router.get("/:id", async (req, res) => {
  const params = GetOpenaiConversationParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, params.data.id),
  });
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, params.data.id))
    .orderBy(asc(messages.createdAt));
  res.json({ ...conv, messages: msgs });
});

// DELETE /api/openai/conversations/:id
router.delete("/:id", async (req, res) => {
  const params = DeleteOpenaiConversationParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const deleted = await db
    .delete(conversations)
    .where(eq(conversations.id, params.data.id))
    .returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.status(204).end();
});

// GET /api/openai/conversations/:id/messages
router.get("/:id/messages", async (req, res) => {
  const params = ListOpenaiMessagesParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, params.data.id))
    .orderBy(asc(messages.createdAt));
  res.json(msgs);
});

// POST /api/openai/conversations/:id/messages — SSE streaming
router.post("/:id/messages", async (req, res) => {
  const idParam = SendOpenaiMessageParams.safeParse({ id: Number(req.params.id) });
  const body = SendOpenaiMessageBody.safeParse(req.body);

  if (!idParam.success || !body.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const conversationId = idParam.data.id;
  const userContent = body.data.content;

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  // Save user message
  await db.insert(messages).values({
    conversationId,
    role: "user",
    content: userContent,
  });

  // Load full message history
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));

  const chatMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullResponse = "";

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: 8192,
      messages: chatMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        fullResponse += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    // Save assistant message
    await db.insert(messages).values({
      conversationId,
      role: "assistant",
      content: fullResponse,
    });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error({ err }, "OpenAI streaming error");
    res.write(`data: ${JSON.stringify({ error: "Failed to get response" })}\n\n`);
    res.end();
  }
});

export default router;

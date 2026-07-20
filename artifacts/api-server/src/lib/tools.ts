/**
 * Agent tool execution (ТЗ §3: function calling equivalents).
 *
 * Agents embed [TOOL:ACTION_NAME:arg1:arg2:...] tags in their first-pass
 * output. This module intercepts those tags, runs the corresponding DB
 * operation, and returns a human-readable result that the agent integrates
 * into its final response.
 */

import { db } from "@workspace/db";
import { expenses, workouts, tasks } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

export async function executeTool(
  chatId: number,
  toolName: string,
  argsStr: string,          // everything after the tool name, colon-separated
): Promise<string> {
  const args = argsStr.split(":").map((s) => s.trim());

  switch (toolName) {
    // ── Finance ──────────────────────────────────────────────────────────
    case "SAVE_EXPENSE": {
      const [amountStr, category = "прочее", date = "сегодня"] = args;
      const amount = parseInt(amountStr, 10);
      if (isNaN(amount) || amount <= 0) {
        return `Ошибка: не смог распознать сумму "${amountStr}".`;
      }
      await db.insert(expenses).values({ telegramChatId: chatId, amount, category, date });
      return `Записал: ${amount}₽ — ${category} (${date}).`;
    }

    case "GET_EXPENSES": {
      const rows = await db.select().from(expenses)
        .where(eq(expenses.telegramChatId, chatId))
        .orderBy(desc(expenses.createdAt))
        .limit(30);
      if (rows.length === 0) return "Расходы пока не зафиксированы.";
      const total = rows.reduce((s, r) => s + r.amount, 0);
      const list = rows
        .map((r) => `${r.date}: ${r.amount}₽ — ${r.category}${r.note ? ` (${r.note})` : ""}`)
        .join("\n");
      return `История расходов:\n${list}\n\nИтого: ${total}₽`;
    }

    // ── Health / Trainer ──────────────────────────────────────────────────
    case "SAVE_WORKOUT": {
      const [type = "тренировка", details = "", date = "сегодня"] = args;
      await db.insert(workouts).values({ telegramChatId: chatId, type, details, date });
      return `Тренировка записана: ${type}${details ? ` — ${details}` : ""} (${date}).`;
    }

    case "GET_WORKOUTS": {
      const rows = await db.select().from(workouts)
        .where(eq(workouts.telegramChatId, chatId))
        .orderBy(desc(workouts.createdAt))
        .limit(15);
      if (rows.length === 0) return "Тренировки пока не зафиксированы.";
      return "История тренировок:\n" +
        rows.map((r) => `${r.date}: ${r.type}${r.details ? ` — ${r.details}` : ""}`).join("\n");
    }

    // ── Personal / Assistant ──────────────────────────────────────────────
    case "SAVE_TASK": {
      const [text, dueDate] = args;
      if (!text) return "Ошибка: текст задачи не указан.";
      await db.insert(tasks).values({
        telegramChatId: chatId,
        text,
        dueDate: dueDate || null,
        status: "active",
      });
      return `Задача добавлена: "${text}"${dueDate ? ` (к ${dueDate})` : ""}.`;
    }

    case "GET_TASKS": {
      const rows = await db.select().from(tasks)
        .where(eq(tasks.telegramChatId, chatId))
        .orderBy(desc(tasks.createdAt))
        .limit(20);
      const active = rows.filter((r) => r.status === "active");
      if (active.length === 0) return "Активных задач нет.";
      return "Активные задачи:\n" +
        active.map((r) => `• ${r.text}${r.dueDate ? ` (к ${r.dueDate})` : ""}`).join("\n");
    }

    case "COMPLETE_TASK": {
      const [searchText] = args;
      if (!searchText) return "Ошибка: не указан текст задачи.";
      const rows = await db.select().from(tasks)
        .where(eq(tasks.telegramChatId, chatId));
      const match = rows.find(
        (r) => r.status === "active" && r.text.toLowerCase().includes(searchText.toLowerCase()),
      );
      if (!match) return `Задача "${searchText}" не найдена.`;
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, match.id));
      return `Задача "${match.text}" отмечена выполненной.`;
    }

    default:
      return `Неизвестный инструмент: ${toolName}`;
  }
}

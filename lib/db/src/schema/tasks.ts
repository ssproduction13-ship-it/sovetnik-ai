import { bigint, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
  text: text("text").notNull(),
  dueDate: text("due_date"),
  status: text("status").notNull().default("active"),  // "active" | "done"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Task = typeof tasks.$inferSelect;

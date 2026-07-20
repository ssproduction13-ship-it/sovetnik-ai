import { bigint, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const expenses = pgTable("expenses", {
  id: serial("id").primaryKey(),
  telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
  amount: integer("amount").notNull(),          // roubles
  category: text("category").notNull(),
  date: text("date").notNull(),                 // natural language / YYYY-MM-DD
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Expense = typeof expenses.$inferSelect;

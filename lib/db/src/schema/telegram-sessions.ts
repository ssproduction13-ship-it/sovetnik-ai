import { bigint, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { conversations } from "./conversations";

export const telegramSessions = pgTable("telegram_sessions", {
  id: serial("id").primaryKey(),
  telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull().unique(),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  /** JSON-encoded PendingIntent: { agentId, originalMessage } */
  pendingIntent: text("pending_intent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertTelegramSessionSchema = createInsertSchema(telegramSessions).omit({
  id: true,
  createdAt: true,
});

export type TelegramSession = typeof telegramSessions.$inferSelect;
export type InsertTelegramSession = z.infer<typeof insertTelegramSessionSchema>;

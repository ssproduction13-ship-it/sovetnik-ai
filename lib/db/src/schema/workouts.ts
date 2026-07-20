import { bigint, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const workouts = pgTable("workouts", {
  id: serial("id").primaryKey(),
  telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
  date: text("date").notNull(),
  type: text("type").notNull(),
  details: text("details").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Workout = typeof workouts.$inferSelect;

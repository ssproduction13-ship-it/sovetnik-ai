import app from "./app";
import { logger } from "./lib/logger";
import { startTelegramBot } from "./lib/telegram";
import { runMigrations } from "@workspace/db/migrate";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Run DB migrations before accepting traffic
runMigrations()
  .then(() => {
    logger.info("Database migrations completed");
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
    });
    startTelegramBot();
  })
  .catch((err) => {
    logger.error({ err }, "Failed to run database migrations");
    process.exit(1);
  });

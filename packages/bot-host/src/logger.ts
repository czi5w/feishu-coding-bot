import { pino, destination, stdTimeFunctions, type Logger } from "pino";
import { config } from "./config.js";

// Synchronous destination so logs flush immediately (prod: journald; dev: console).
// Async/SonicBoom buffering would otherwise drop lines on SIGTERM.
export const logger: Logger = pino(
  {
    level: config.LOG_LEVEL,
    base: { service: "bot-host", pid: process.pid },
    timestamp: stdTimeFunctions.isoTime,
  },
  destination({ sync: true }),
);

export type { Logger };

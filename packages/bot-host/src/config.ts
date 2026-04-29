import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

// Comma-separated list helper: "a,b , c" → ["a","b","c"]
const csv = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  .pipe(z.array(z.string().min(1)));

const schema = z.object({
  // Feishu
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_BOT_OPEN_ID: z.string().min(1),

  // Whitelist
  ALLOWED_CHAT_IDS: csv,
  ALLOWED_USER_IDS: csv,

  // Inner WS Server (listens for AI_Proxy connections)
  INNER_WS_HOST: z.string().default("0.0.0.0"),
  INNER_WS_PORT: z.coerce.number().int().positive().default(8765),
  AI_PROXY_MODEL: z.string().default(""),

  // Storage
  AUDIT_DB_PATH: z.string().min(1).default("./data/audit.db"),

  // Runtime
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
  REPLY_THROTTLE_MS: z.coerce.number().int().nonnegative().default(2000),
});

export type BotHostConfig = Readonly<z.infer<typeof schema>>;

function loadConfig(): BotHostConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // Logger may not be initialized yet; use stderr directly.
    process.stderr.write(
      `[bot-host] invalid configuration:\n${issues}\n`,
    );
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const config: BotHostConfig = loadConfig();

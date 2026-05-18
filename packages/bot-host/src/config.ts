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

  // Whitelist — leave empty to allow all
  ALLOWED_CHAT_IDS: csv.or(z.literal("").transform(() => [] as string[])).default(""),
  ALLOWED_USER_IDS: csv.or(z.literal("").transform(() => [] as string[])).default(""),

  // Inner WS Server (listens for AI_Proxy connections)
  INNER_WS_HOST: z.string().default("0.0.0.0"),
  INNER_WS_PORT: z.coerce.number().int().positive().default(8765),
  AI_PROXY_MODEL: z.string().default(""),

  // User -> device routing (format: user_id:device_id, comma-separated)
  USER_DEVICE_MAP: z
    .string()
    .default("")
    .transform((s) => {
      const map = new Map<string, string>();
      for (const pair of s.split(",").map((p) => p.trim()).filter(Boolean)) {
        const sep = pair.indexOf(":");
        if (sep > 0) {
          map.set(pair.slice(0, sep).trim(), pair.slice(sep + 1).trim());
        }
      }
      return map;
    }),

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

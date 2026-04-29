import { config } from "./config.js";
import { logger } from "./logger.js";
import { initDefaultDatabase } from "./storage/db.js";
import { markEventSeen, pruneOldEvents } from "./storage/dedup.js";
import { logAudit } from "./storage/audit.js";
import { parseIncomingEvent } from "./feishu/handler.js";
import { startFeishuClient } from "./feishu/client.js";
import { makeReplyClient } from "./feishu/reply.js";
import { isAllowed } from "./router/whitelist.js";
import { normalizeInstruction } from "./router/parser.js";
import { createDispatcher } from "./router/dispatcher.js";
import { recoverOrphans } from "./router/orphan-recovery.js";
import { InnerWsServer } from "./transport/inner-ws-server.js";

async function main(): Promise<void> {
  logger.info(
    {
      inner_ws_host: config.INNER_WS_HOST,
      inner_ws_port: config.INNER_WS_PORT,
      allowed_chats: config.ALLOWED_CHAT_IDS.length,
      allowed_users: config.ALLOWED_USER_IDS.length,
    },
    "bot-host starting",
  );

  // 1. Storage
  initDefaultDatabase(config.AUDIT_DB_PATH);

  const pruneTimer = setInterval(
    () => {
      const removed = pruneOldEvents(Math.floor(Date.now() / 1000));
      if (removed > 0) logger.debug({ removed }, "pruned dedup rows");
    },
    60 * 60 * 1000,
  );
  pruneTimer.unref?.();

  // 2. Inner WS Server — waits for AI_Proxy to connect
  const innerServer = new InnerWsServer({
    host: config.INNER_WS_HOST,
    port: config.INNER_WS_PORT,
    logger,
  });
  innerServer.start();

  // 3. Feishu client + reply helpers
  const feishu = await startFeishuClient(async (ev) => {
    const msg = parseIncomingEvent(ev, {
      bot_open_id: config.FEISHU_BOT_OPEN_ID,
      markEventSeen,
      logger,
    });
    if (!msg) return;

    if (!isAllowed(msg.chat_id, msg.user_id)) {
      logAudit({
        ts: msg.ts,
        direction: "reject",
        chat_id: msg.chat_id,
        user_id: msg.user_id,
        raw_text: msg.raw_text,
        extra: { reason: "whitelist" },
      });
      logger.info(
        { chat_id: msg.chat_id, user_id: msg.user_id },
        "rejected non-whitelisted message",
      );
      return;
    }

    const normalized = normalizeInstruction(msg.raw_text);
    if (!normalized) {
      logger.debug({ event_id: msg.event_id }, "empty instruction, ignoring");
      return;
    }

    await dispatcher.dispatch({ ...msg, raw_text: normalized });
  });
  const reply = makeReplyClient(feishu.api, config.REPLY_THROTTLE_MS, logger);

  // 4. Dispatcher wires Feishu ↔ InnerWsServer ↔ storage together.
  const dispatcher = createDispatcher({
    reply,
    transport: innerServer,
    logger,
  });

  // 5. Orphan recovery
  await recoverOrphans({ api: feishu.api, logger });

  logger.info("bot-host ready");

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string): void => {
      logger.info({ signal }, "bot-host shutting down");
      clearInterval(pruneTimer);
      void Promise.allSettled([
        reply.shutdown(),
        innerServer.stop(),
        feishu.stop(),
      ]).then(() => resolve());
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });

  process.exit(0);
}

main().catch((err: unknown) => {
  logger.error({ err }, "bot-host fatal error");
  process.exit(1);
});

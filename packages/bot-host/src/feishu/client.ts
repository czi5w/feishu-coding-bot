import * as lark from "@larksuiteoapi/node-sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { LarkMessageReceiveEvent } from "./handler.js";

export type OnMessageReceive = (
  ev: LarkMessageReceiveEvent,
) => void | Promise<void>;

export interface FeishuClient {
  /** Lark HTTP client — used for sending replies, patching messages, etc. */
  readonly api: lark.Client;
  /** Stops the long-polling WS connection. */
  stop(): Promise<void>;
}

/**
 * Starts the Feishu long-polling (WS) client and registers a single
 * im.message.receive_v1 handler. Returns once the WS client is running.
 *
 * The underlying lark.WSClient handles its own reconnection — we do not need
 * an additional retry layer around it.
 */
export async function startFeishuClient(
  onMessage: OnMessageReceive,
): Promise<FeishuClient> {
  const api = new lark.Client({
    appId: config.FEISHU_APP_ID,
    appSecret: config.FEISHU_APP_SECRET,
    loggerLevel: lark.LoggerLevel.info,
  });

  const dispatcher = new lark.EventDispatcher({
    // In WS mode these two fields are unused by the SDK.
    encryptKey: "",
    verificationToken: "",
  }).register({
    "im.message.receive_v1": async (data) => {
      try {
        // The SDK types allow partial fields; cast to our stricter shape and
        // let handler.ts's validation reject anything malformed.
        await onMessage(data as unknown as LarkMessageReceiveEvent);
      } catch (err: unknown) {
        logger.error({ err }, "onMessage handler threw");
      }
    },
  });

  const ws = new lark.WSClient({
    appId: config.FEISHU_APP_ID,
    appSecret: config.FEISHU_APP_SECRET,
    loggerLevel: lark.LoggerLevel.info,
  });

  ws.start({ eventDispatcher: dispatcher });
  logger.info({ app_id: config.FEISHU_APP_ID }, "feishu WS client started");

  return {
    api,
    async stop() {
      // Current lark SDK versions expose no public `stop` method on WSClient.
      // Best effort: nothing to do here until upstream adds one.
      logger.info("feishu WS client stop requested (noop)");
    },
  };
}

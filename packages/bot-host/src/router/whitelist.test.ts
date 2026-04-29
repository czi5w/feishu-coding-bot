import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("whitelist", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.FEISHU_APP_ID = "cli_test";
    process.env.FEISHU_APP_SECRET = "s".repeat(16);
    process.env.FEISHU_BOT_OPEN_ID = "ou_bot";
    process.env.ALLOWED_CHAT_IDS = "oc_1, oc_2 ,oc_3";
    process.env.ALLOWED_USER_IDS = "ou_a, ou_b";
    process.env.INNER_WS_HOST = "0.0.0.0";
    process.env.INNER_WS_PORT = "8765";
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("accepts a chat_id + user_id pair in both lists", async () => {
    const { isAllowed } = await import("./whitelist.js");
    expect(isAllowed("oc_1", "ou_a")).toBe(true);
    expect(isAllowed("oc_3", "ou_b")).toBe(true);
  });

  it("rejects when chat_id is unknown", async () => {
    const { isAllowed } = await import("./whitelist.js");
    expect(isAllowed("oc_unknown", "ou_a")).toBe(false);
  });

  it("rejects when user_id is unknown", async () => {
    const { isAllowed } = await import("./whitelist.js");
    expect(isAllowed("oc_1", "ou_unknown")).toBe(false);
  });

  it("trims whitespace from comma-separated lists", async () => {
    const { isChatAllowed, isUserAllowed } = await import("./whitelist.js");
    expect(isChatAllowed("oc_2")).toBe(true);
    expect(isUserAllowed("ou_b")).toBe(true);
  });
});

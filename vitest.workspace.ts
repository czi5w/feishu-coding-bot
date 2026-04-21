import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/protocol",
  "packages/bot-host",
  "packages/agent-core",
]);

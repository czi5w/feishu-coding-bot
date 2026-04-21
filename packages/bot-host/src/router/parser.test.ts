import { describe, expect, it } from "vitest";
import { normalizeInstruction } from "./parser.js";

describe("normalizeInstruction", () => {
  it("strips a paired <at>...</at> block and trims surrounding whitespace", () => {
    const out = normalizeInstruction(
      '<at user_id="ou_bot" user_name="编程机器人">@编程机器人</at> 给 login.ts 加个 null check',
    );
    expect(out).toBe("给 login.ts 加个 null check");
  });

  it("strips a self-closing <at ... /> block", () => {
    const out = normalizeInstruction(
      '<at user_id="ou_bot"/> fix the bug',
    );
    expect(out).toBe("fix the bug");
  });

  it("strips multiple at blocks", () => {
    const out = normalizeInstruction(
      '<at user_id="ou_bot"></at> hello <at user_id="ou_other"></at> world',
    );
    expect(out).toBe("hello world");
  });

  it("collapses internal whitespace", () => {
    const out = normalizeInstruction("   a    b\tc\n\nd   ");
    expect(out).toBe("a b c d");
  });

  it("returns null for a bare @bot with nothing else", () => {
    expect(
      normalizeInstruction('<at user_id="ou_bot"></at>'),
    ).toBeNull();
  });

  it("returns null when residual is a single char", () => {
    expect(
      normalizeInstruction('<at user_id="ou_bot"></at> ?'),
    ).toBeNull();
  });

  it("accepts 2-char instruction (boundary)", () => {
    expect(
      normalizeInstruction('<at user_id="ou_bot"></at> ok'),
    ).toBe("ok");
  });

  it("returns null for whitespace-only input", () => {
    expect(normalizeInstruction("   \n\t  ")).toBeNull();
  });
});

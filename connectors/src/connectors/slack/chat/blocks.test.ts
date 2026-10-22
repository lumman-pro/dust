import { getBotI18n } from "@connectors/lib/bot/i18n";
import { describe, expect, it } from "vitest";

import { makeToolValidationBlock } from "@connectors/connectors/slack/chat/blocks";

async function getActionIds(canAlwaysApprove: boolean) {
  const en = await getBotI18n("en-US");
  const [, actions] = makeToolValidationBlock({
    i18n: en,
    toolName: "search",
    id: "block-id",
    canAlwaysApprove,
  });
  return actions?.elements?.map((e) => e.action_id);
}

describe("makeToolValidationBlock", () => {
  it("offers Always allow when allowed", async () => {
    expect(await getActionIds(true)).toEqual([
      "approve_tool_execution",
      "always_approve_tool_execution",
      "reject_tool_execution",
    ]);
  });

  it("hides Always allow otherwise", async () => {
    expect(await getActionIds(false)).toEqual([
      "approve_tool_execution",
      "reject_tool_execution",
    ]);
  });
});

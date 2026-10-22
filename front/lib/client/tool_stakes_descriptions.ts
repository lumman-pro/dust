import type { MCPToolStakeLevelType } from "@app/lib/actions/constants";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export const MCP_TOOL_STAKE_LABELS: Record<
  MCPToolStakeLevelType,
  MessageDescriptor
> = {
  high: msg`High (always ask for confirmation)`,
  medium: msg`Medium (allows input-scoped confirmation save)`,
  low: msg`Low (allows user-global confirmation save)`,
  never_ask: msg`Never ask (automatic execution)`,
};

export const MCP_TOOL_STAKE_SHORT_LABELS: Record<
  MCPToolStakeLevelType,
  MessageDescriptor
> = {
  high: msg({ message: "High", context: "tool stake level" }),
  medium: msg({ message: "Medium", context: "tool stake level" }),
  low: msg({ message: "Low", context: "tool stake level" }),
  never_ask: msg({ message: "Never ask", context: "tool stake level" }),
};

export const MCP_TOOL_STAKE_DESCRIPTIONS: Record<
  MCPToolStakeLevelType,
  MessageDescriptor
> = {
  high: msg`Needs explicit user approval.`,
  medium: msg`Users can save confirmations for specific tool inputs.`,
  low: msg`Users can completely disable confirmations.`,
  never_ask: msg`Runs automatically.`,
};

export const MCP_TOOL_STAKE_COLORS = {
  high: "warning",
  medium: "info",
  low: "highlight",
  never_ask: "success",
} as const satisfies Record<MCPToolStakeLevelType, string>;

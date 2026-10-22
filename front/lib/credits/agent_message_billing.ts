import { DUST_CLIENT_SIDE_MCP_SERVER_NAMES } from "@app/lib/actions/constants";
import type { InternalMCPServerNameType } from "@app/lib/actions/mcp_internal_actions/constants";
import {
  getInternalMCPServerMetadata,
  isInternalMCPServerName,
} from "@app/lib/actions/mcp_internal_actions/constants";
import type { ToolExecutionStatus } from "@app/lib/actions/statuses";
import { isToolExecutionStatusBillable } from "@app/lib/actions/statuses";
import { getMCPServerIdFromServerName } from "@app/lib/api/actions/mcp/client_side_server_id";
import type { ToolBillingInfo, ToolCostCategory } from "@app/lib/api/mcp";
import {
  allocateMicroCreditsByLargestRemainder,
  roundCreditsToMicroCredits,
} from "@app/lib/credits/units";
import { awuFromMicroUsd } from "@app/lib/metronome/constants";
import type { RunUsageType } from "@app/lib/resources/run_resource";
import type { UserMessageOrigin } from "@app/types/assistant/conversation";
import { createHash } from "crypto";

export { TOOL_COST_CATEGORIES, type ToolCostCategory } from "@app/lib/api/mcp";

// Historical and non-agent-loop usages may not have a run key. Keep them in one
// group to preserve the former message-level rounding behavior for those rows.
export const LEGACY_RUN_KEY = "__legacy__";

// Platform-assistive messages are metered for observability but not billed.
export const FREE_ORIGINS: ReadonlySet<UserMessageOrigin> =
  new Set<UserMessageOrigin>([
    "agent_sidekick",
    // Only the Activation Pod nudge ever carries this origin: it is server-only,
    // and the nudge has no author so it can neither be edited nor retried. User
    // replies come back as `web` and bill normally.
    "system_activation",
  ]);

// Canonical tool prices used by runtime billing and Metronome rate-card setup.
// A tool's `freeUsage` metadata can waive this rated price.
export const TOOL_COST_CATEGORY_AWU_WEIGHTS: Record<ToolCostCategory, number> =
  {
    basic: 1,
    advanced: 3,
  };

// Once one MCP server has accrued this many billed tool credits within an
// agent message, its subsequent tool calls are metered but free. The action
// that reaches (or crosses) the cap remains fully billed.
export const MCP_SERVER_AGENT_MESSAGE_TOOL_AWU_CAP = 20;

// Tools of Dust's own client-side MCP servers are billed at the price they declare. Client-side
// servers registered by third-party apps through the API remain external servers.
const DUST_CLIENT_SIDE_MCP_SERVER_IDS: ReadonlySet<string> = new Set(
  Object.values(DUST_CLIENT_SIDE_MCP_SERVER_NAMES).map((serverName) =>
    getMCPServerIdFromServerName({ serverName })
  )
);

// Tool calls of Dust's own client-side servers made before this date were billed as an external
// server's, and keep that price so that already billed messages still add up. MUST be later than
// the deploy of this rule.
export const DUST_CLIENT_SIDE_TOOL_PRICING_DATE = new Date(
  "2026-10-20T22:00:00Z"
);

export type AgentMessageBillingRunUsage = RunUsageType & {
  runKey: string | null;
};

export type AgentMessageBillingAction = {
  // When the tool call was made, in milliseconds since epoch. Actions without one are priced with
  // the current rules.
  createdAt?: number;
  internalMCPServerName: InternalMCPServerNameType | null;
  // Old actions may not carry their server id. Internal servers still have a
  // stable name fallback. Unidentified external actions are left uncapped.
  mcpServerId?: string | null;
  // Price the tool declared, stored on its action when its client-side server listed it.
  declaredBilling?: ToolBillingInfo | null;
  status: ToolExecutionStatus;
  toolName: string;
};

/** Explains how the rated credits were treated by the billing rules. */
export type AgentMessageLlmBillingDisposition = "billed" | "free_origin";

export type AgentMessageToolBillingDisposition =
  | AgentMessageLlmBillingDisposition
  | "free_mcp_server_cap"
  | "free_tool"
  | "unbillable_status";

export type AgentMessageLlmBillingLine<
  TUsage extends AgentMessageBillingRunUsage,
> = {
  runKey: string;
  providerId: TUsage["providerId"];
  modelId: TUsage["modelId"];
  promptTokensCount: number;
  completionTokensCount: number;
  cachedTokensCount: number;
  cacheCreationTokensCount: number;
  providerCostMicroUsd: number;
  // Rated credits are the computed price.
  ratedCredits: number;
  // Billed credits are the actual charge after billing rules.
  billedCredits: number;
  billingDisposition: AgentMessageLlmBillingDisposition;
  usageAllocations: Array<{
    usage: TUsage;
    allocatedBilledCreditMicro: number;
  }> | null;
};

export type AgentMessageToolBillingLine<
  TAction extends AgentMessageBillingAction,
> = {
  action: TAction;
  toolCostCategory: ToolCostCategory;
  // Rated credits are the computed price.
  ratedCredits: number;
  // Billed credits are the actual charge after billing rules.
  billedCredits: number;
  billingDisposition: AgentMessageToolBillingDisposition;
};

export type AgentMessageBillingPlan<
  TUsage extends AgentMessageBillingRunUsage,
  TAction extends AgentMessageBillingAction,
> = {
  llm: AgentMessageLlmBillingLine<TUsage>[];
  tools: AgentMessageToolBillingLine<TAction>[];
  totals: {
    llmBilledCredits: number;
    toolBilledCredits: number;
    billedCredits: number;
  };
};

export function isFreeOrigin(origin: UserMessageOrigin | null): boolean {
  return origin !== null && FREE_ORIGINS.has(origin);
}

// Full-length fingerprint of one agent-loop execution, for callers that need
// collision resistance (e.g. idempotency keys): the truncated run key below
// only has 32 bits of entropy.
export function computeRunFingerprint(dustRunIds: string[]): string {
  return createHash("sha256")
    .update([...dustRunIds].sort().join(","))
    .digest("hex");
}

// A run key identifies one agent-loop execution. Retries with the same run IDs
// deduplicate in Metronome, while interrupt/resume executions receive distinct
// keys and are consequently rounded and billed independently.
export function computeRunKey(dustRunIds: string[]): string {
  return computeRunFingerprint(dustRunIds).slice(0, 8);
}

/**
 * @cc [owner:philipperolet,label:product] client-side-tool-pricing
 * A tool call made from `DUST_CLIENT_SIDE_TOOL_PRICING_DATE` on a client-side MCP server registered
 * under a `DUST_CLIENT_SIDE_MCP_SERVER_NAMES` name MUST be rated with the `toolCostCategory` and
 * `freeUsage` the tool declared, or `basic` with `freeUsage` if it declared none. Any other
 * client-side tool call, including one of these servers' made before that date, MUST be rated like
 * an external server's, whatever it declared: `advanced`, without `freeUsage`.
 */
export function getToolBillingInfo({
  createdAt,
  declaredBilling,
  internalMCPServerName,
  mcpServerId,
  toolName,
}: Pick<
  AgentMessageBillingAction,
  | "createdAt"
  | "declaredBilling"
  | "internalMCPServerName"
  | "mcpServerId"
  | "toolName"
>): ToolBillingInfo {
  const isDustClientSideToolCall =
    !!mcpServerId &&
    DUST_CLIENT_SIDE_MCP_SERVER_IDS.has(mcpServerId) &&
    (!createdAt || createdAt >= DUST_CLIENT_SIDE_TOOL_PRICING_DATE.getTime());
  if (isDustClientSideToolCall) {
    // Clients that predate price declarations only had basic, free tools.
    return declaredBilling ?? { toolCostCategory: "basic", freeUsage: true };
  }

  // External servers default to the paid advanced category.
  if (
    !internalMCPServerName ||
    !isInternalMCPServerName(internalMCPServerName)
  ) {
    return { toolCostCategory: "advanced", freeUsage: false };
  }

  const metadata = getInternalMCPServerMetadata(internalMCPServerName);
  const tool = metadata.tools.find((candidate) => candidate.name === toolName);
  // Missing metadata must never make an unknown internal tool free by accident.
  if (!tool) {
    return { toolCostCategory: "advanced", freeUsage: false };
  }

  return {
    toolCostCategory: tool.toolCostCategory,
    freeUsage: tool.freeUsage,
  };
}

function getMCPServerBillingKey(
  action: AgentMessageBillingAction
): string | null {
  if (action.internalMCPServerName !== null) {
    return `internal:${action.internalMCPServerName}`;
  }

  return action.mcpServerId ? `external:${action.mcpServerId}` : null;
}

// Split a rounded billing line across its raw usage rows with the largest
// remainder method. Stable, unique keys make the result independent of DB
// query order, and the allocated microcredits always reconcile to the line.
function allocateBilledCreditMicro<TUsage extends AgentMessageBillingRunUsage>({
  billedCredits,
  getUsageAllocationKey,
  providerCostMicroUsd,
  usages,
}: {
  billedCredits: number;
  getUsageAllocationKey: (usage: TUsage) => string;
  providerCostMicroUsd: number;
  usages: TUsage[];
}): AgentMessageLlmBillingLine<TUsage>["usageAllocations"] {
  const billedCreditMicro = roundCreditsToMicroCredits(billedCredits);
  if (providerCostMicroUsd === 0) {
    return usages.map((usage) => ({
      usage,
      allocatedBilledCreditMicro: 0,
    }));
  }

  const allocations = usages.map((usage) => ({
    usage,
    allocationKey: getUsageAllocationKey(usage),
    exactCreditMicro:
      (usage.costMicroUsd / providerCostMicroUsd) * billedCreditMicro,
  }));
  if (
    new Set(allocations.map(({ allocationKey }) => allocationKey)).size !==
    allocations.length
  ) {
    throw new Error(
      "Usage allocation keys must be unique within a billing group."
    );
  }
  const allocationsInKeyOrder = [...allocations].sort((left, right) =>
    left.allocationKey < right.allocationKey ? -1 : 1
  );
  const creditMicros = allocateMicroCreditsByLargestRemainder(
    allocationsInKeyOrder.map(({ exactCreditMicro }) => exactCreditMicro)
  );
  const allocatedCreditMicroByKey = new Map(
    allocationsInKeyOrder.map(({ allocationKey }, index) => [
      allocationKey,
      creditMicros[index],
    ])
  );

  return allocations.map(({ usage, allocationKey }) => ({
    usage,
    allocatedBilledCreditMicro:
      allocatedCreditMicroByKey.get(allocationKey) ?? 0,
  }));
}

function resolveToolBillingDisposition({
  freeUsage,
  isMessageFree,
  status,
}: {
  freeUsage: boolean;
  isMessageFree: boolean;
  status: ToolExecutionStatus;
}): AgentMessageToolBillingDisposition {
  if (!isToolExecutionStatusBillable(status)) {
    return "unbillable_status";
  }

  if (isMessageFree) {
    return "free_origin";
  }

  if (freeUsage) {
    return "free_tool";
  }

  return "billed";
}

/**
 * Produces the canonical billing plan for one agent message.
 *
 * LLM provider cost is grouped and rounded once per (execution, provider,
 * model), then those groups are summed for the message. Tool actions are priced
 * independently at their category's fixed rate. Actions must be provided in
 * chronological order so the per-MCP-server message cap is deterministic.
 *
 * `ratedCredits` is the price before free-origin/tool waivers;
 * `billedCredits` is the authoritative charge after those rules. Callers should
 * project this plan instead of rebuilding grouping, rounding, or pricing rules.
 */
export function buildAgentMessageBillingPlan<
  TUsage extends AgentMessageBillingRunUsage,
  TAction extends AgentMessageBillingAction,
>({
  actions,
  contextOrigin,
  getUsageAllocationKey,
  runUsages,
}: {
  actions: TAction[];
  contextOrigin: UserMessageOrigin | null;
  getUsageAllocationKey?: (usage: TUsage) => string;
  runUsages: TUsage[];
}): AgentMessageBillingPlan<TUsage, TAction> {
  const isMessageFree = isFreeOrigin(contextOrigin);
  const usagesByBillingGroup = new Map<
    string,
    {
      runKey: string;
      providerId: TUsage["providerId"];
      modelId: TUsage["modelId"];
      usages: TUsage[];
    }
  >();

  for (const usage of runUsages) {
    const runKey = usage.runKey ?? LEGACY_RUN_KEY;
    const billingGroupKey = `${runKey}|${usage.providerId}|${usage.modelId}`;
    const group = usagesByBillingGroup.get(billingGroupKey);
    if (group) {
      group.usages.push(usage);
    } else {
      usagesByBillingGroup.set(billingGroupKey, {
        runKey,
        providerId: usage.providerId,
        modelId: usage.modelId,
        usages: [usage],
      });
    }
  }

  const llm = [...usagesByBillingGroup.values()].map(
    ({ runKey, providerId, modelId, usages }) => {
      const promptTokensCount = usages.reduce(
        (total, usage) => total + usage.promptTokens,
        0
      );
      const completionTokensCount = usages.reduce(
        (total, usage) => total + usage.completionTokens,
        0
      );
      const cachedTokensCount = usages.reduce(
        (total, usage) => total + (usage.cachedTokens ?? 0),
        0
      );
      const cacheCreationTokensCount = usages.reduce(
        (total, usage) => total + (usage.cacheCreationTokens ?? 0),
        0
      );
      const providerCostMicroUsd = usages.reduce(
        (total, usage) => total + usage.costMicroUsd,
        0
      );
      const ratedCredits = awuFromMicroUsd(providerCostMicroUsd);
      const billedCredits = isMessageFree ? 0 : ratedCredits;
      const billingDisposition: AgentMessageLlmBillingDisposition =
        isMessageFree ? "free_origin" : "billed";

      return {
        runKey,
        providerId,
        modelId,
        promptTokensCount,
        completionTokensCount,
        cachedTokensCount,
        cacheCreationTokensCount,
        providerCostMicroUsd,
        ratedCredits,
        billedCredits,
        billingDisposition,
        usageAllocations: getUsageAllocationKey
          ? allocateBilledCreditMicro({
              billedCredits,
              getUsageAllocationKey,
              providerCostMicroUsd,
              usages,
            })
          : null,
      };
    }
  );

  const billedToolCreditsByMCPServer = new Map<string, number>();
  const tools = actions.map((action) => {
    const { toolCostCategory, freeUsage } = getToolBillingInfo(action);
    let billingDisposition = resolveToolBillingDisposition({
      freeUsage,
      isMessageFree,
      status: action.status,
    });
    const ratedCredits = TOOL_COST_CATEGORY_AWU_WEIGHTS[toolCostCategory];

    const mcpServerBillingKey = getMCPServerBillingKey(action);
    if (billingDisposition === "billed" && mcpServerBillingKey !== null) {
      const billedCreditsForServer =
        billedToolCreditsByMCPServer.get(mcpServerBillingKey) ?? 0;
      if (billedCreditsForServer >= MCP_SERVER_AGENT_MESSAGE_TOOL_AWU_CAP) {
        billingDisposition = "free_mcp_server_cap";
      } else {
        billedToolCreditsByMCPServer.set(
          mcpServerBillingKey,
          billedCreditsForServer + ratedCredits
        );
      }
    }

    const billedCredits = billingDisposition === "billed" ? ratedCredits : 0;

    return {
      action,
      toolCostCategory,
      ratedCredits,
      billedCredits,
      billingDisposition,
    };
  });

  const llmBilledCredits = llm.reduce(
    (total, line) => total + line.billedCredits,
    0
  );
  const toolBilledCredits = tools.reduce(
    (total, line) => total + line.billedCredits,
    0
  );

  return {
    llm,
    tools,
    totals: {
      llmBilledCredits,
      toolBilledCredits,
      billedCredits: llmBilledCredits + toolBilledCredits,
    },
  };
}

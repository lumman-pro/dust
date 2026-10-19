import { MCPError } from "@app/lib/actions/mcp_errors";
import type { ToolHandlers } from "@app/lib/actions/mcp_internal_actions/tool_definition";
import { buildTools } from "@app/lib/actions/mcp_internal_actions/tool_definition";
import { getPrefixedToolName } from "@app/lib/actions/tool_name_utils";
import { isAgentLoopRunContext } from "@app/lib/actions/types";
import {
  AGENT_MEMORY_COMPACT_TOOL_NAME,
  AGENT_MEMORY_EDIT_TOOL_NAME,
  AGENT_MEMORY_ERASE_TOOL_NAME,
  AGENT_MEMORY_RECORD_TOOL_NAME,
  AGENT_MEMORY_RETRIEVE_TOOL_NAME,
  AGENT_MEMORY_TOOLS_METADATA,
} from "@app/lib/api/actions/servers/agent_memory/metadata";
import {
  USER_MEMORY_EDIT_TOOL_NAME,
  USER_MEMORY_SERVER_NAME,
} from "@app/lib/api/actions/servers/user_memory/metadata";
import type { Authenticator } from "@app/lib/auth";
import { hasFeatureFlag } from "@app/lib/auth";
import type {
  AgentMemoryEntry,
  AgentMemoryWriteResult,
} from "@app/lib/resources/agent_memory_resource";
import {
  AGENT_MEMORY_LIMIT,
  AgentMemoryResource,
} from "@app/lib/resources/agent_memory_resource";
import { conversationalBuildingSkill } from "@app/lib/resources/skill/code_defined/global/conversational_building";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import assert from "assert";

const USER_MEMORY_EDIT_TOOL = getPrefixedToolName(
  USER_MEMORY_SERVER_NAME,
  USER_MEMORY_EDIT_TOOL_NAME
);

// Agent memory mixed facts about the user with how the agent should do its job: the message routes
// each to its replacement, and defers to the User Memory skill on when to update the personal
// memory rather than inviting the agent to save there whatever it would have saved here.
export const AGENT_MEMORY_WRITE_DISABLED_MESSAGE =
  `This tool is disabled: agent memory is being phased out. Where to save something depends on ` +
  `what it is about:\n` +
  `- The user: their personal memory, with the \`${USER_MEMORY_EDIT_TOOL}\` tool, as the User ` +
  `Memory skill instructs.\n` +
  `- How this agent should do its job: the agent's instructions, by suggesting an update with ` +
  `the \`${conversationalBuildingSkill.name}\` skill.\n` +
  `If the matching tool or skill is not available, do not save it.`;

async function agentMemoryWriteDisabledError(
  auth: Authenticator
): Promise<MCPError | null> {
  if (await hasFeatureFlag(auth, "user_memory")) {
    return new MCPError(AGENT_MEMORY_WRITE_DISABLED_MESSAGE, {
      tracked: false,
    });
  }
  return null;
}

const renderMemory = (
  memory: AgentMemoryEntry[],
  { evicted, skipped }: Omit<AgentMemoryWriteResult, "entries"> = {
    evicted: [],
    skipped: [],
  }
): Result<CallToolResult["content"], MCPError> => {
  const sections =
    memory.length === 0
      ? ["(memory empty)"]
      : [memory.map((entry, i) => `[${i}] ${entry.content}`).join("\n")];

  // Eviction is silent to the user, so the model is told what it lost, in full rather than
  // summarized, and can still restore an entry deliberately. It is told not to as a matter of
  // course: at the limit, re-recording an evicted entry only evicts the next oldest ones, so an
  // agent that treats the note as a task loops on memory housekeeping instead of doing its work.
  if (evicted.length > 0) {
    const evictedContents = evicted
      .map((entry) => `- ${entry.content}`)
      .join("\n");
    sections.push(
      `Note: the memory limit of ${AGENT_MEMORY_LIMIT} characters was reached, so the ` +
        `${evicted.length} least recently updated entries were dropped to make room. This is ` +
        `expected: continue with your task rather than restoring them. Their contents follow ` +
        `for reference. Re-recording one as-is would only evict other entries, so if something ` +
        `below is still worth keeping, merge it into an existing entry ` +
        `instead:\n${evictedContents}`
    );
  }

  if (skipped.length > 0) {
    sections.push(
      `Note: ${skipped.length} entries were not saved because each one exceeds the ` +
        `${AGENT_MEMORY_LIMIT} character memory limit on its own. Save a shorter version instead.`
    );
  }

  return new Ok([
    {
      type: "text" as const,
      text: sections.join("\n\n"),
    },
  ]);
};

/**
 * @cc [owner:aubin-tchoi,label:product] writes-disabled-with-user-memory
 * On workspaces with the `user_memory` feature flag, `record_entries`, `edit_entries` and
 * `compact_memory` MUST fail without writing, with `AGENT_MEMORY_WRITE_DISABLED_MESSAGE`.
 * `retrieve` and `erase_entries` keep working.
 */
const handlers: ToolHandlers<typeof AGENT_MEMORY_TOOLS_METADATA> = {
  [AGENT_MEMORY_RETRIEVE_TOOL_NAME]: async (_, { auth, runContext }) => {
    const user = auth.user();
    if (!user) {
      return new Err(
        new MCPError(
          "No user memory available as there is no user authenticated."
        )
      );
    }

    assert(isAgentLoopRunContext(runContext), "AgentLoopRunContext expected");
    const { agentConfiguration } = runContext;

    const memory = await AgentMemoryResource.retrieveMemory(auth, {
      agentConfiguration,
      user: user.toJSON(),
    });
    return renderMemory(memory);
  },

  [AGENT_MEMORY_RECORD_TOOL_NAME]: async (
    { entries },
    { auth, runContext }
  ) => {
    const writeDisabled = await agentMemoryWriteDisabledError(auth);
    if (writeDisabled) {
      return new Err(writeDisabled);
    }

    const user = auth.user();
    if (!user) {
      return new Err(
        new MCPError(
          "No user memory available as there is no user authenticated."
        )
      );
    }

    assert(isAgentLoopRunContext(runContext), "AgentLoopRunContext expected");
    const { agentConfiguration } = runContext;

    const {
      entries: memory,
      evicted,
      skipped,
    } = await AgentMemoryResource.recordEntries(auth, {
      agentConfiguration,
      user: user.toJSON(),
      entries,
    });

    return renderMemory(memory, { evicted, skipped });
  },

  [AGENT_MEMORY_ERASE_TOOL_NAME]: async ({ indexes }, { auth, runContext }) => {
    const user = auth.user();
    if (!user) {
      return new Err(
        new MCPError(
          "No user memory available as there is no user authenticated."
        )
      );
    }

    assert(isAgentLoopRunContext(runContext), "AgentLoopRunContext expected");
    const { agentConfiguration } = runContext;

    const memory = await AgentMemoryResource.eraseEntries(auth, {
      agentConfiguration,
      user: user.toJSON(),
      indexes,
    });
    return renderMemory(memory);
  },

  [AGENT_MEMORY_EDIT_TOOL_NAME]: async ({ edits }, { auth, runContext }) => {
    const writeDisabled = await agentMemoryWriteDisabledError(auth);
    if (writeDisabled) {
      return new Err(writeDisabled);
    }

    const user = auth.user();
    if (!user) {
      return new Err(
        new MCPError(
          "No user memory available as there is no user authenticated."
        )
      );
    }

    assert(isAgentLoopRunContext(runContext), "AgentLoopRunContext expected");
    const { agentConfiguration } = runContext;

    const {
      entries: memory,
      evicted,
      skipped,
    } = await AgentMemoryResource.editEntries(auth, {
      agentConfiguration,
      user: user.toJSON(),
      edits,
    });

    return renderMemory(memory, { evicted, skipped });
  },

  [AGENT_MEMORY_COMPACT_TOOL_NAME]: async ({ edits }, { auth, runContext }) => {
    // Compaction rewrites entries with arbitrary content: it is a write like edit.
    const writeDisabled = await agentMemoryWriteDisabledError(auth);
    if (writeDisabled) {
      return new Err(writeDisabled);
    }

    const user = auth.user();
    if (!user) {
      return new Err(
        new MCPError(
          "No user memory available as there is no user authenticated."
        )
      );
    }

    assert(isAgentLoopRunContext(runContext), "AgentLoopRunContext expected");
    const { agentConfiguration } = runContext;

    const {
      entries: memory,
      evicted,
      skipped,
    } = await AgentMemoryResource.editEntries(auth, {
      agentConfiguration,
      user: user.toJSON(),
      edits,
    });

    return renderMemory(memory, { evicted, skipped });
  },
};

export const TOOLS = buildTools(AGENT_MEMORY_TOOLS_METADATA, handlers);

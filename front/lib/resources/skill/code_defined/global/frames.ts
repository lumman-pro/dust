import { doesWorkspaceServePublicFunctions } from "@app/lib/api/sandbox_functions/workspace_user";
import type { Authenticator } from "@app/lib/auth";
import { getFeatureFlags } from "@app/lib/auth";
import { FRAME_SKILL_FILES } from "@app/lib/resources/skill/code_defined/global/frames/files";
import { buildFramesV2Instructions } from "@app/lib/resources/skill/code_defined/global/frames_v2";
import type { GlobalSkillDefinition } from "@app/lib/resources/skill/code_defined/shared";
import type { AgentLoopExecutionData } from "@app/types/assistant/agent_run";
import { isPodConversation } from "@app/types/assistant/conversation";
import {
  isFramesV2DraftsEnabled,
  isFramesV2FunctionsEnabled,
  isFramesV2SchedulesEnabled,
} from "@app/types/shared/feature_flags";

/**
 * @cc [owner:davidebbo,label:product] frame-functions-disclosure
 * Function, database and persistent-file authoring guidance MUST be included only when Frame functions are enabled (see isFramesV2FunctionsEnabled). Guidance for functions
 * served to visitors of a public link MUST be included only when the workspace serves public Frame
 * functions to visitors (see doesWorkspaceServePublicFunctions). Draft and make-live guidance MUST
 * be included only when Frame drafts are enabled (see isFramesV2DraftsEnabled).
 */
export const framesSkill = {
  sId: "frames",
  kind: "global",
  name: "Create Frames",
  userFacingDescription:
    "Turn insights into interactive dashboards and presentations your team can explore, customize," +
    " and share. Living documents that adapt to different stakeholders.",
  agentFacingDescription:
    "Create interactive visualizations, charts, dashboards, and presentations as executable React " +
    "components, and update existing ones (fix a chart, change data, colors, text, or layout). " +
    "These visualizations are typically called 'Frames' or 'Dust Frames' and can be " +
    "used in various contexts: daily digests, data analytics, sales reports, and more. Consider " +
    "using when tsx or React code is shared or available in the conversation. " +
    "Frames used to be a tool, now deprecated. Use this skill when the Frames/interactive " +
    "content tool is mentioned, and whenever asked to modify an existing Frame.",
  // Frames start in the conversation and only go to the Pod when they belong there. That only
  // makes sense with a conversation to check, so a Pod-less agent loop keeps the
  // conversation-scoped guidance.
  fetchInstructions: async (
    auth: Authenticator,
    params: { spaceIds: string[]; agentLoopData?: AgentLoopExecutionData }
  ) => {
    const flags = await getFeatureFlags(auth);
    const conversation = params.agentLoopData?.conversation;

    return buildFramesV2Instructions({
      hasFunctions: isFramesV2FunctionsEnabled(flags),
      hasPublicFunctions: await doesWorkspaceServePublicFunctions({
        workspace: auth.getNonNullableWorkspace(),
        plan: auth.plan(),
      }),
      hasDrafts: isFramesV2DraftsEnabled(flags),
      hasSchedules: isFramesV2SchedulesEnabled(flags),
      isPod: conversation ? isPodConversation(conversation) : false,
    });
  },
  mcpServers: [{ name: "interactive_content" }],
  files: FRAME_SKILL_FILES,
  // Frames authoring runs entirely through the Computer.
  warmsConversationSandbox: async () => true,
  version: 18,
  icon: "ActionFrameIcon",
} as const satisfies GlobalSkillDefinition;

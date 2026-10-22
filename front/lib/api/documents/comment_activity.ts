import { showCollabAgentActivity } from "@app/lib/api/collab/client";
import type { Authenticator } from "@app/lib/auth";
import logger from "@app/logger/logger";
import type { UserMessageType } from "@app/types/assistant/conversation";
import { documentCommentOf } from "@app/types/assistant/document_comment";
import type { AgentActivity, CollabAgent } from "@app/types/collab";

/**
 * @cc [owner:adrien,label:product] collab-agent-of-run
 * The agent MUST carry the thread of `userMessage`'s `document_comment` directive as `commentId`,
 * and none for any other message, so editors show its activity in that thread only.
 */
export function toCollabAgent({
  agentConfiguration,
  userMessage,
}: {
  agentConfiguration: { sId: string; name: string };
  userMessage: UserMessageType;
}): CollabAgent {
  return {
    agentId: agentConfiguration.sId,
    name: agentConfiguration.name,
    userId: userMessage.user?.sId ?? null,
    userName: userMessage.context.fullName || userMessage.context.username,
    commentId: documentCommentOf(userMessage)?.commentId ?? null,
  };
}

/**
 * @cc [owner:adrien,label:product] comment-activity
 * `activity` MUST be shown as `auth`'s user to the editors of the document at `canonicalPath`. A
 * failure MUST be logged and MUST NOT fail the caller.
 */
export async function showCommentActivity(
  auth: Authenticator,
  {
    canonicalPath,
    agent,
    activity,
  }: { canonicalPath: string; agent: CollabAgent; activity: AgentActivity }
): Promise<void> {
  const shown = await showCollabAgentActivity(auth, {
    canonicalPath,
    agent,
    activity,
  });
  if (shown.isErr()) {
    logger.warn(
      {
        workspaceId: auth.getNonNullableWorkspace().sId,
        commentId: agent.commentId,
        activity,
        code: shown.error.code,
        error: shown.error.message,
      },
      "Could not show an agent's activity in a document comment"
    );
  }
}

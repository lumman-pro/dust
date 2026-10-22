import {
  createConversation,
  postUserMessage,
} from "@app/lib/api/assistant/conversation";
import {
  showCommentActivity,
  toCollabAgent,
} from "@app/lib/api/documents/comment_activity";
import type { NewCommentMessage } from "@app/lib/api/documents/comment_signatures";
import {
  DustFileSystem,
  parseScopedPrefix,
} from "@app/lib/api/file_system/dust_file_system";
import type { Authenticator } from "@app/lib/auth";
import { executeWithLockResult } from "@app/lib/lock";
import { getFileNameFromScopedPath } from "@app/lib/markdown/file_preview";
import { extractFromString } from "@app/lib/mentions/format";
import { notifyNewProjectConversation } from "@app/lib/notifications/triggers/project-new-conversation";
import { AgentResource } from "@app/lib/resources/agent_resource";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import logger from "@app/logger/logger";
import { launchDocumentCommentMentionWorkflow } from "@app/temporal/mentions_queue/client";
import { serializeDocumentCommentDirective } from "@app/types/assistant/document_comment";
import type { AgentMention } from "@app/types/assistant/mentions";
import { isAgentMention } from "@app/types/assistant/mentions";
import type { AgentActivity, CollabAgent } from "@app/types/collab";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { normalizeError } from "@app/types/shared/utils/error_utils";

/**
 * Comments that mention an agent reach it the way a conversation message does: each one is
 * posted as a user message in the document's conversation, which runs the agent. Mentioned users
 * are notified apart, never through the conversation.
 */

type DocumentConversationLookup =
  | { kind: "conversation"; conversation: ConversationResource }
  | {
      kind: "pod";
      pod: SpaceResource;
      conversation: ConversationResource | null;
    };

/**
 * @cc [owner:adrien,label:product] document-conversation-lookup
 * A file in a conversation's files MUST find that conversation. A file in a pod MUST find the pod
 * and its conversation linked to its normalized path, if any. Any other file, or one whose
 * conversation or pod cannot be fetched, MUST find none. It MUST NOT create anything.
 */
async function fetchDocumentConversation(
  auth: Authenticator,
  documentPath: string
): Promise<DocumentConversationLookup | null> {
  const scope = parseScopedPrefix(documentPath);
  if (!scope) {
    return null;
  }

  switch (scope.kind) {
    case "conversation": {
      const conversation = await ConversationResource.fetchById(auth, scope.id);
      return conversation ? { kind: "conversation", conversation } : null;
    }
    case "pod": {
      const pod = await SpaceResource.fetchById(auth, scope.id);
      if (!pod) {
        return null;
      }
      const conversation = await ConversationResource.fetchLatestForDocument(
        auth,
        { space: pod, documentPath }
      );
      return { kind: "pod", pod, conversation };
    }
    case "conversation_metadata":
    case "user":
    case "frame":
      return null;
    default:
      return assertNever(scope);
  }
}

/**
 * @cc [owner:tdraier,label:product] document-conversation
 * A file MUST use the conversation `fetchDocumentConversation` finds. A file in a pod without one
 * MUST use a conversation linked to its normalized path, created in the pod without notifying the
 * pod, and `isPodDocument` MUST tell a pod's file; callers MUST hold the document's lock, so
 * concurrent posts share one conversation. Any other file has no conversation.
 */
async function getDocumentConversation(
  auth: Authenticator,
  documentPath: string
): Promise<{
  conversation: ConversationResource;
  isPodDocument: boolean;
} | null> {
  const found = await fetchDocumentConversation(auth, documentPath);
  if (!found) {
    return null;
  }
  if (found.kind === "conversation") {
    return { conversation: found.conversation, isPodDocument: false };
  }
  if (found.conversation) {
    return { conversation: found.conversation, isPodDocument: true };
  }
  const conversation = await createConversation(auth, {
    title: `Comments · ${getFileNameFromScopedPath(documentPath)}`,
    visibility: "unlisted",
    spaceId: found.pod.id,
    metadata: { dfmDocumentPath: documentPath },
    notifyPodMembers: false,
  });
  return { conversation, isPodDocument: true };
}

/**
 * @cc [owner:adrien,label:product] comment-mentioned-agent
 * The agent MUST be the one `getAgentMentionFromComment` keeps from `newMessage`'s body, named as
 * its configuration, working for `auth`'s user in `newMessage`'s thread, as `toCollabAgent` gives
 * it once its message is posted. A message mentioning no agent, an agent `auth` cannot fetch, or an
 * `auth` without a user, MUST give none.
 */
async function commentMentionedAgent(
  auth: Authenticator,
  { commentId, message }: NewCommentMessage
): Promise<CollabAgent | null> {
  const { agent: mention } = getAgentMentionFromComment(message.body);
  const user = auth.user();
  if (!mention || !user) {
    return null;
  }
  const agent = await AgentResource.fetchById(auth, mention.configurationId);
  if (!agent) {
    return null;
  }
  return {
    agentId: agent.sId,
    name: agent.name,
    userId: user.sId,
    userName: user.fullName() || user.username,
    commentId,
  };
}

/**
 * @cc [owner:adrien,label:product] comment-mention-start
 * For a message `postCommentMention` would post, its agent (`comment-mentioned-agent`) MUST be
 * given as waiting while an agent or a compaction runs in the document's conversation, and as
 * thinking otherwise, a pod's file without a conversation yet included. A message mentioning no
 * agent, or a file without a conversation to post to, MUST give none. It MUST NOT create anything.
 */
export async function getCommentMentionStart(
  auth: Authenticator,
  {
    documentPath,
    newMessage,
  }: { documentPath: string; newMessage: NewCommentMessage }
): Promise<{
  agent: CollabAgent;
  activity: Extract<AgentActivity, "thinking" | "waiting">;
} | null> {
  const agent = await commentMentionedAgent(auth, newMessage);
  if (!agent) {
    return null;
  }
  const found = await fetchDocumentConversation(auth, documentPath);
  if (!found) {
    return null;
  }
  if (!found.conversation) {
    return { agent, activity: "thinking" };
  }
  const { runningAgentMessage, runningCompactionMessage } =
    await found.conversation.getInFlightMessages(auth);
  return {
    agent,
    activity:
      runningAgentMessage || runningCompactionMessage ? "waiting" : "thinking",
  };
}

/**
 * The agent a comment runs. A conversation message runs at most one agent, so only the first agent
 * mentioned is kept; users are notified apart from the conversation.
 */
function getAgentMentionFromComment(body: string): {
  agent: AgentMention | undefined;
  skippedAgents: number;
} {
  const agentIds = new Set(
    extractFromString(body)
      .filter(isAgentMention)
      .map((mention) => mention.configurationId)
  );
  const [first] = agentIds;
  return {
    agent: first ? { configurationId: first } : undefined,
    skippedAgents: Math.max(agentIds.size - 1, 0),
  };
}

/**
 * @cc [owner:tdraier,label:product] document-comment-message
 * The user message for a comment MUST open with the `serializeDocumentCommentDirective` of the
 * thread's id, the document's path and the quoted passage, if any, followed by the new message as
 * written. It MUST NOT repeat the thread's earlier messages, which agents read in the document.
 */
function commentMessageContent(
  documentPath: string,
  { commentId, quote, message }: NewCommentMessage
): string {
  return `${serializeDocumentCommentDirective({ commentId, documentPath, quote })}\n\n${message.body}`;
}

/**
 * @cc [owner:tdraier,label:product;performance] document-comment-mentions
 * Each new message that mentions agents or users MUST be handed to a durable job keyed by the
 * normalized document path and the message, so however often it is handed over, its mentioned
 * users are notified once and, when it mentions an agent, it is posted once. The caller MUST NOT
 * wait for that job. Messages without mentions MUST NOT be handed over. A failure MUST be logged
 * and MUST NOT fail the caller.
 */
export async function dispatchCommentMentions(
  auth: Authenticator,
  {
    scopedPath,
    newMessages,
  }: { scopedPath: string; newMessages: NewCommentMessage[] }
): Promise<void> {
  const mentioning = newMessages.filter(
    ({ message }) => extractFromString(message.body).length > 0
  );
  const resolvedPath = DustFileSystem.resolveScopedPath(scopedPath);
  if (!auth.user() || mentioning.length === 0 || resolvedPath.isErr()) {
    return;
  }

  const authType = auth.toJSON();
  await concurrentExecutor(
    mentioning,
    async (newMessage) => {
      const launched = await launchDocumentCommentMentionWorkflow({
        authType,
        documentPath: resolvedPath.value,
        newMessage,
      });
      if (launched.isErr()) {
        logger.error(
          {
            workspaceId: authType.workspaceId,
            scopedPath: resolvedPath.value,
            commentId: newMessage.commentId,
            err: launched.error,
          },
          "Failed to dispatch a document comment with mentions."
        );
      }
    },
    { concurrency: 4 }
  );
}

export class DocumentConversationBusyError extends Error {
  constructor() {
    super("The document's conversation is busy.");
    this.name = "DocumentConversationBusyError";
  }
}

/**
 * @cc [owner:tdraier,label:product] document-comment-mention-post
 * A dispatched message that mentions an agent MUST be posted as the saving user, as a user
 * message with the `document_comment` origin in the document's conversation, so the mentioned
 * agent runs as in a conversation. As in a conversation, a message runs at most one agent: only
 * the first agent mentioned is kept, and the others are logged. The message MUST NOT carry any
 * user mention, and a message mentioning no agent MUST NOT be posted, nor its conversation
 * created. It MUST be posted with `onlyWhenIdle`, and while an agent or a compaction runs in that conversation, or the document's
 * lock cannot be taken, it MUST return a `DocumentConversationBusyError` having posted nothing, so
 * each comment gets its own turn instead of steering a running agent. A pod document's
 * conversation MUST notify the pod when its first message is posted, never before. Any other
 * failure MUST be logged and the message dropped. In the comment's thread, its first mentioned
 * agent (`comment-mentioned-agent`) MUST be shown waiting when busy and, once posted, the posted
 * agent thinking (`collab-agent-of-run`), all after the lock is released; a failure to find the
 * waiting agent MUST be logged and MUST NOT change the busy result.
 */
export async function postCommentMention(
  auth: Authenticator,
  {
    documentPath,
    newMessage,
  }: { documentPath: string; newMessage: NewCommentMessage }
): Promise<Result<undefined, DocumentConversationBusyError>> {
  const workspaceId = auth.getNonNullableWorkspace().sId;
  const user = auth.user();
  if (!user) {
    return new Ok(undefined);
  }

  const { agent, skippedAgents } = getAgentMentionFromComment(
    newMessage.message.body
  );
  if (skippedAgents > 0) {
    logger.warn(
      {
        workspaceId,
        scopedPath: documentPath,
        commentId: newMessage.commentId,
        skippedAgents,
      },
      "Document comment mentions more than one agent; only the first runs."
    );
  }
  if (!agent) {
    return new Ok(undefined);
  }

  const locked = await executeWithLockResult(
    `dfm_document_conversation_${workspaceId}_${documentPath}`,
    async (): Promise<
      Result<CollabAgent | null, DocumentConversationBusyError>
    > => {
      const found = await getDocumentConversation(auth, documentPath);
      if (!found) {
        logger.warn(
          { workspaceId, scopedPath: documentPath },
          "No conversation for a document comment with mentions."
        );
        return new Ok(null);
      }
      const { conversation, isPodDocument } = found;

      const posted = await postUserMessage(auth, {
        conversationResource: conversation,
        content: commentMessageContent(documentPath, newMessage),
        mentions: [agent],
        context: {
          timezone: "UTC",
          username: user.username,
          fullName: user.fullName(),
          email: user.email,
          profilePictureUrl: user.imageUrl,
          origin: "document_comment",
        },
        skipToolsValidation: false,
        onlyWhenIdle: true,
      });
      if (posted.isErr()) {
        if (posted.error.status_code === 409) {
          return new Err(new DocumentConversationBusyError());
        }
        logger.error(
          {
            workspaceId,
            scopedPath: documentPath,
            conversationId: conversation.sId,
            commentId: newMessage.commentId,
            error: posted.error.api_error.message,
          },
          "Failed to post a document comment with mentions."
        );
        return new Ok(null);
      }

      if (isPodDocument && posted.value.userMessage.rank === 0) {
        notifyNewProjectConversation(auth, {
          conversation: conversation.toJSON(),
        });
      }
      const [agentMessage] = posted.value.agentMessages;
      return new Ok(
        agentMessage
          ? toCollabAgent({
              agentConfiguration: agentMessage.configuration,
              userMessage: posted.value.userMessage,
            })
          : null
      );
    }
  );
  if (locked.isErr()) {
    const waiting = await commentMentionedAgent(auth, newMessage).catch(
      (err) => {
        logger.warn(
          {
            err: normalizeError(err),
            workspaceId,
            commentId: newMessage.commentId,
          },
          "Could not find the agent a document comment runs"
        );
        return null;
      }
    );
    if (waiting) {
      await showCommentActivity(auth, {
        canonicalPath: documentPath,
        agent: waiting,
        activity: "waiting",
      });
    }
    return new Err(new DocumentConversationBusyError());
  }
  if (locked.value) {
    await showCommentActivity(auth, {
      canonicalPath: documentPath,
      agent: locked.value,
      activity: "thinking",
    });
  }
  return new Ok(undefined);
}

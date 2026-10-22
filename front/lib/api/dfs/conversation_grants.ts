import { getDfsTenantClient } from "@app/lib/api/dfs/clients";
import { createUserSubject } from "@app/lib/api/dfs/sessions";
import type { Authenticator } from "@app/lib/auth";
import { hasFeatureFlag } from "@app/lib/auth";
import type { ConversationResource } from "@app/lib/resources/conversation_resource";
import type { UserResource } from "@app/lib/resources/user_resource";
import logger from "@app/logger/logger";
import type { DfsGrant } from "@app/types/dfs";

/** The grant of a participant of a conversation outside pods, see `conversation-folder-grants`. */
export function getConversationParticipantGrant(user: UserResource): DfsGrant {
  return { type: "allow", subject: createUserSubject(user), mode: 0o6 };
}

/**
 * @cc [owner:fabiencelier,label:security] conversation-folder-grants-sync
 * With the `dust_file_system` feature flag, on the folder of a conversation outside pods, `user`
 * MUST end up with an ALLOW with `rw` if they participate in the conversation when the call reads
 * it, and without it otherwise. It MUST be called with `conversation` read once the participation
 * change is committed, including for a soft-deleted conversation. A conversation without a folder
 * or in a pod is left alone. A dfs failure is logged and does not fail the caller.
 */
/**
 * Matches the grant of `user` on the folder of `conversation` with their current participation,
 * after they were added to or left the conversation.
 */
export async function reflectConversationParticipationOnDfs(
  auth: Authenticator,
  {
    conversation,
    user,
  }: {
    conversation: ConversationResource;
    user: UserResource;
  }
): Promise<void> {
  const folderId = conversation.dfsObjectId;
  if (
    !folderId ||
    // In a pod, its access is the pod folder's.
    conversation.spaceId !== null ||
    !(await hasFeatureFlag(auth, "dust_file_system"))
  ) {
    return;
  }
  const tenantClient = await getDfsTenantClient(auth);
  const updated = tenantClient.isErr()
    ? tenantClient
    : await tenantClient.value.updateGrants({
        objectId: folderId,
        changes: [
          {
            grant: getConversationParticipantGrant(user),
            // Read right before the update, so that an addition and a departure racing each other
            // end on the latest participation.
            remove: !(await conversation.isParticipant(auth, user)),
          },
        ],
      });
  if (updated.isErr()) {
    logger.error(
      {
        workspaceId: auth.getNonNullableWorkspace().sId,
        conversationId: conversation.sId,
        err: updated.error,
      },
      "Failed to update a conversation participant grant on dfs."
    );
  }
}

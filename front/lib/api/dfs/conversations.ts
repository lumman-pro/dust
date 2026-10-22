import { withDfsFolderContext } from "@app/lib/api/dfs/folder_context";
import { getOrCreateConversationFolder } from "@app/lib/api/dfs/folders";
import type { Authenticator } from "@app/lib/auth";
import { hasFeatureFlag } from "@app/lib/auth";
import type { ConversationResource } from "@app/lib/resources/conversation_resource";
import logger from "@app/logger/logger";
import { Err } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";

/**
 * Creates the dfs folder of `conversation` just created by the authenticated user, with that user's
 * session (see `getOrCreateConversationFolder`), when the workspace has the `dust_file_system`
 * feature flag. Without a user (e.g. a conversation created with an API key), nothing is created.
 */
/**
 * @cc [owner:fabiencelier,label:error-handling] conversation-creation-never-fails
 * MUST NOT throw nor fail the conversation creation: a failure to create the folder, returned or
 * thrown (e.g. concurrent creations of the same user folder, see `stored-folder-first`), MUST be
 * logged and swallowed.
 */
export async function reflectConversationCreationOnDfs(
  auth: Authenticator,
  conversation: ConversationResource
): Promise<void> {
  const user = auth.user();
  if (!user || !(await hasFeatureFlag(auth, "dust_file_system"))) {
    return;
  }
  // The superuser session only creates the creator's user folder if it is missing.
  const created = await withDfsFolderContext(
    auth,
    { allowSuperuser: true },
    async (context) =>
      getOrCreateConversationFolder(auth, context, conversation, { user })
  ).catch((err) => new Err(normalizeError(err)));
  if (created.isErr()) {
    logger.error(
      {
        workspaceId: auth.getNonNullableWorkspace().sId,
        conversationId: conversation.sId,
        err: created.error,
      },
      "Failed to create a conversation folder on dfs."
    );
  }
}

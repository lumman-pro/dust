import type { DfsFolderContext } from "@app/lib/api/dfs/folders";
import {
  getOrCreateConversationFolder,
  getOrCreatePodFolder,
  getOrCreateUserFolder,
} from "@app/lib/api/dfs/folders";
import { Authenticator } from "@app/lib/auth";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { FileResource } from "@app/lib/resources/file_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import { ContentFragmentModel } from "@app/lib/resources/storage/models/content_fragment";
import type { UserResource } from "@app/lib/resources/user_resource";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import {
  getDfsBackfillTenant,
  getFirstEditor,
  getFirstParticipant,
  getSuperuserFolderContext,
  makeUserFolderContextGetter,
  writeMountFileToDfs,
} from "@app/scripts/backfill_dfs_helpers";
import { makeScript } from "@app/scripts/helpers";
import { runOnAllWorkspaces } from "@app/scripts/workspace_helpers";
import { DfsError } from "@app/types/dfs";
import { getConversationFilesBasePath } from "@app/types/mount_path";
import type { ModelId } from "@app/types/shared/model_id";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { removeNulls } from "@app/types/shared/utils/general";
import { Op } from "sequelize";

const BATCH_SIZE_DEFAULT = 200;
const CONCURRENCY_DEFAULT = 4;

/**
 * The owner of the folder holding the conversation's folder (the pod's first editor for a pod
 * conversation, else the first participant), with that parent folder created as superuser: a
 * session of the owner can then create the conversation's folder in it.
 */
async function getOrCreateParentFolderOwner(
  auth: Authenticator,
  superuserContext: DfsFolderContext,
  conversation: ConversationResource
): Promise<Result<UserResource, DfsError>> {
  const [pod] = conversation.spaceId
    ? await SpaceResource.fetchByModelIds(auth, [conversation.spaceId])
    : [];
  if (pod?.isProject()) {
    const owner = await getFirstEditor(auth, pod);
    if (!owner) {
      return new Err(
        new DfsError("invalid_input", `Pod ${pod.sId} has no editor.`)
      );
    }
    const folder = await getOrCreatePodFolder(auth, superuserContext, pod, {
      user: owner,
    });
    return folder.isErr() ? folder : new Ok(owner);
  }
  const owner = await getFirstParticipant(auth, conversation);
  if (!owner) {
    return new Err(
      new DfsError(
        "invalid_input",
        `Conversation ${conversation.sId} has no participant.`
      )
    );
  }
  const folder = await getOrCreateUserFolder(auth, superuserContext, owner);
  return folder.isErr() ? folder : new Ok(owner);
}

makeScript(
  {
    wId: {
      type: "string",
      describe: "Workspace sId to backfill (omit to run on all workspaces).",
    },
    fromWorkspaceModelId: {
      type: "number",
      describe:
        "Skip workspaces with model id below this value (for resuming).",
    },
    batchSize: {
      type: "number",
      default: BATCH_SIZE_DEFAULT,
      describe: "Number of content fragments to fetch per DB query.",
    },
    concurrency: {
      type: "number",
      default: CONCURRENCY_DEFAULT,
      describe: "Conversations processed concurrently per batch.",
    },
  },
  async (
    { execute, wId, fromWorkspaceModelId, batchSize, concurrency },
    logger
  ) => {
    await runOnAllWorkspaces(
      async (workspace) => {
        const workspaceId = workspace.sId;
        const auth = await Authenticator.internalAdminForWorkspace(workspaceId);

        const tenant = await getDfsBackfillTenant(auth);
        if (!tenant) {
          logger.info(
            { workspaceId },
            "[backfill_dfs_content_fragment_files] No dfs tenant, skipping workspace"
          );
          return;
        }

        let lastId = 0;
        let written = 0;
        let failed = 0;
        let skippedWithoutMountPath = 0;

        while (true) {
          // Fragments of a pod's context have no conversation: they are backfilled with pod files.
          const fragments = await ContentFragmentModel.findAll({
            attributes: ["id", "fileId", "conversationId"],
            where: {
              workspaceId: workspace.id,
              fileId: { [Op.ne]: null },
              conversationId: { [Op.ne]: null },
              id: { [Op.gt]: lastId },
            },
            order: [["id", "ASC"]],
            limit: batchSize,
          });
          if (fragments.length === 0) {
            break;
          }
          lastId = fragments[fragments.length - 1].id;

          const files = await FileResource.fetchByModelIdsWithAuth(auth, [
            ...new Set(removeNulls(fragments.map((f) => f.fileId))),
          ]);
          const filesById = new Map<ModelId, FileResource>();
          for (const file of files) {
            if (file.dfsObjectId) {
              continue;
            }
            if (!file.mountFilePath) {
              skippedWithoutMountPath++;
              continue;
            }
            filesById.set(file.id, file);
          }

          const filesByConversationId = new Map<ModelId, Set<FileResource>>();
          for (const { fileId, conversationId } of fragments) {
            const file = fileId ? filesById.get(fileId) : undefined;
            if (!file || !conversationId) {
              continue;
            }
            filesByConversationId.set(
              conversationId,
              (filesByConversationId.get(conversationId) ?? new Set()).add(file)
            );
          }

          const conversations = await ConversationResource.fetchByModelIds(
            auth,
            [...filesByConversationId.keys()]
          );
          const superuserContext = execute
            ? await getSuperuserFolderContext(auth, tenant)
            : null;
          const getUserFolderContext = makeUserFolderContextGetter(
            auth,
            tenant
          );

          await concurrentExecutor(
            conversations,
            async (conversation) => {
              const basePath = getConversationFilesBasePath({
                workspaceId,
                conversationId: conversation.sId,
              });
              const conversationFiles = [
                ...(filesByConversationId.get(conversation.id) ?? []),
              ].filter((f) => f.mountFilePath?.startsWith(basePath));
              if (conversationFiles.length === 0) {
                return;
              }

              if (!superuserContext) {
                for (const file of conversationFiles) {
                  logger.info(
                    {
                      workspaceId,
                      conversationId: conversation.sId,
                      fileId: file.sId,
                      mountFilePath: file.mountFilePath,
                    },
                    "[backfill_dfs_content_fragment_files] Would write file (dry-run)"
                  );
                }
                written += conversationFiles.length;
                return;
              }

              const owner = await getOrCreateParentFolderOwner(
                auth,
                superuserContext,
                conversation
              );
              if (owner.isErr()) {
                logger.error(
                  {
                    workspaceId,
                    conversationId: conversation.sId,
                    err: owner.error,
                  },
                  "[backfill_dfs_content_fragment_files] Failed to get the parent folder"
                );
                failed += conversationFiles.length;
                return;
              }
              const ownerContext = await getUserFolderContext(owner.value);
              const folderId = await getOrCreateConversationFolder(
                auth,
                ownerContext,
                conversation,
                { user: owner.value }
              );
              if (folderId.isErr()) {
                logger.error(
                  {
                    workspaceId,
                    conversationId: conversation.sId,
                    err: folderId.error,
                  },
                  "[backfill_dfs_content_fragment_files] Failed to get the conversation folder"
                );
                failed += conversationFiles.length;
                return;
              }

              for (const file of conversationFiles) {
                const res = await writeMountFileToDfs(auth, {
                  fs: ownerContext.fs,
                  folderId: folderId.value,
                  basePath,
                  file,
                });
                if (res.isErr()) {
                  logger.error(
                    { workspaceId, fileId: file.sId, err: res.error },
                    "[backfill_dfs_content_fragment_files] Failed to write file"
                  );
                  failed++;
                  continue;
                }
                written++;
              }
            },
            { concurrency }
          );
        }

        logger.info(
          { workspaceId, written, failed, skippedWithoutMountPath, execute },
          "[backfill_dfs_content_fragment_files] Workspace done"
        );
      },
      { wId, fromWorkspaceId: fromWorkspaceModelId }
    );
  }
);

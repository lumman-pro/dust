import { createHash, timingSafeEqual } from "node:crypto";
import type { CollabAccess } from "@app/lib/api/collab/access";
import {
  checkCollabAccess,
  checkCollabReadAccess,
} from "@app/lib/api/collab/access";
import config from "@app/lib/api/config";
import { EDIT_TOO_LARGE_MESSAGE } from "@app/lib/api/documents/agent_edit_source";
import { WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES } from "@app/lib/api/files/file_system_ops";
import { Authenticator } from "@app/lib/auth";
import { toSessionName } from "@app/types/collab";
import type {
  CollabSourceEditResponse,
  CollabSourceReadResponse,
  CollabSourceWriteResponse,
} from "@app/types/collab_internal";
import {
  COLLAB_AGENT_ACTIVITY_PATH,
  COLLAB_SOURCE_EDIT_PATH,
  COLLAB_SOURCE_READ_PATH,
  COLLAB_SOURCE_WRITE_PATH,
  collabAgentActivityRequestSchema,
  collabSourceEditRequestSchema,
  collabSourceReadRequestSchema,
  collabSourceWriteRequestSchema,
} from "@app/types/collab_internal";
import { assertNever } from "@app/types/shared/utils/assert_never";
import {
  editSessionSource,
  readSessionSource,
  showAgentActivity,
  writeSessionSource,
} from "@front-api/collab/lib/session";
import { collabAccessErrorToApiError } from "@front-api/lib/collab_access_errors";
import { createHono } from "@front-api/lib/hono";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import type { Hocuspocus } from "@hocuspocus/server";

const BEARER_PREFIX = "Bearer ";

// Hashed first so the comparison takes the same time whatever the length of what was sent.
const digest = (value: string) => createHash("sha256").update(value).digest();

function isAuthorized(authorization: string | undefined): boolean {
  const secret = config.getCollabServerInternalSecret();
  if (!secret || !authorization?.startsWith(BEARER_PREFIX)) {
    return false;
  }
  return timingSafeEqual(
    digest(authorization.slice(BEARER_PREFIX.length)),
    digest(secret)
  );
}

/**
 * @cc [owner:PopDaph;tdraier,label:security] collab-internal-routes
 * Every internal route MUST answer 401 unless the request carries the configured internal secret,
 * and MUST answer 401 to every request when none is configured. A read MUST return a document's
 * source only for the file `checkCollabReadAccess` opens for the request's user, workspace and path,
 * so a reader can read it, and a write MUST be applied only for the file `checkCollabAccess` opens
 * for them, both answering as the collab ticket route does when they refuse. A read of an open
 * document, readable or not, MUST answer 403 when the request has no user, and a write MUST carry
 * one. A write whose source is larger than `WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES` MUST be refused
 * before it reaches the session, since no save could write it. An edit MUST be checked as a write
 * is, its replacement text in place of the source, answering `edit_refused` with `too_large` as
 * the session does for an edited source over that size (`collab-session-source-edit`). An edit
 * the session cannot apply because it cannot read its own document MUST answer 500, so the caller
 * reports a failure of the server rather than a refusal of the edit. An agent's activity MUST be
 * shown only once `checkCollabReadAccess` opens the file for the request's user, workspace and
 * path, answering as the collab ticket route does otherwise.
 */
export function createInternalRoutes(hocuspocus: Hocuspocus<CollabAccess>) {
  const app = createHono();

  app.use("*", async (ctx, next) => {
    if (!isAuthorized(ctx.req.header("authorization"))) {
      return apiError(ctx, {
        status_code: 401,
        api_error: {
          type: "not_authenticated",
          message: "The internal secret is missing or invalid.",
        },
      });
    }
    await next();
  });

  /** @ignoreswagger */
  app.post(
    COLLAB_SOURCE_READ_PATH,
    validate("json", collabSourceReadRequestSchema),
    async (ctx) => {
      const { workspaceId, userId, canonicalPath, agent } =
        ctx.req.valid("json");
      const documentName = toSessionName(workspaceId, canonicalPath);

      const read = await readSessionSource(hocuspocus, documentName);
      if (read.isOk() && !read.value.open) {
        return ctx.json<CollabSourceReadResponse>(read.value);
      }

      // Open, readable or not: only a user who can open the file learns more of it.
      if (!userId) {
        return apiError(ctx, {
          status_code: 403,
          api_error: {
            type: "workspace_auth_error",
            message:
              "This document is being edited live and can only be read on behalf of a user.",
          },
        });
      }
      const file = await checkCollabReadAccess(
        await Authenticator.fromUserIdAndWorkspaceId(userId, workspaceId),
        canonicalPath
      );
      if (file.isErr()) {
        return apiError(ctx, collabAccessErrorToApiError(file.error));
      }
      if (read.isErr()) {
        // TODO(co-edition): answer a distinct outcome telling the agent a person's edit cannot be
        // saved yet, rather than an error.
        return apiError(
          ctx,
          {
            status_code: 500,
            api_error: {
              type: "internal_server_error",
              message: "The live document could not be read.",
            },
          },
          new Error(read.error)
        );
      }
      // Only once the reader may open the file: its editors then see the agent at work.
      if (agent) {
        showAgentActivity(hocuspocus, documentName, agent, "reading");
      }
      return ctx.json<CollabSourceReadResponse>(read.value);
    }
  );

  /** @ignoreswagger */
  app.post(
    COLLAB_SOURCE_WRITE_PATH,
    validate("json", collabSourceWriteRequestSchema),
    async (ctx) => {
      const { workspaceId, userId, canonicalPath, base, source, agent } =
        ctx.req.valid("json");

      const file = await checkCollabAccess(
        await Authenticator.fromUserIdAndWorkspaceId(userId, workspaceId),
        canonicalPath
      );
      if (file.isErr()) {
        return apiError(ctx, collabAccessErrorToApiError(file.error));
      }
      if (
        Buffer.byteLength(source, "utf8") >
        WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES
      ) {
        return ctx.json<CollabSourceWriteResponse>({
          result: "refused",
          message: "This document would be too large to edit live.",
        });
      }

      const written = await writeSessionSource(hocuspocus, {
        file: file.value,
        base,
        source,
        agent,
      });
      return ctx.json<CollabSourceWriteResponse>(
        written.isOk()
          ? { result: written.value }
          : { result: "refused", message: written.error }
      );
    }
  );

  /** @ignoreswagger */
  app.post(
    COLLAB_SOURCE_EDIT_PATH,
    validate("json", collabSourceEditRequestSchema),
    async (ctx) => {
      const { workspaceId, userId, canonicalPath, edit, agent } =
        ctx.req.valid("json");

      const file = await checkCollabAccess(
        await Authenticator.fromUserIdAndWorkspaceId(userId, workspaceId),
        canonicalPath
      );
      if (file.isErr()) {
        return apiError(ctx, collabAccessErrorToApiError(file.error));
      }
      if (
        Buffer.byteLength(edit.newString, "utf8") >
        WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES
      ) {
        return ctx.json<CollabSourceEditResponse>({
          result: "edit_refused",
          code: "too_large",
          message: EDIT_TOO_LARGE_MESSAGE,
        });
      }

      const edited = await editSessionSource(hocuspocus, {
        file: file.value,
        edit,
        agent,
      });
      if (edited.isOk()) {
        return ctx.json<CollabSourceEditResponse>(edited.value);
      }
      switch (edited.error.kind) {
        case "refused":
          return ctx.json<CollabSourceEditResponse>({
            result: "refused",
            message: edited.error.message,
          });
        case "unavailable":
          return apiError(
            ctx,
            {
              status_code: 500,
              api_error: {
                type: "internal_server_error",
                message: "The live document could not be read.",
              },
            },
            new Error(edited.error.message)
          );
        default:
          return assertNever(edited.error.kind);
      }
    }
  );

  /** @ignoreswagger */
  app.post(
    COLLAB_AGENT_ACTIVITY_PATH,
    validate("json", collabAgentActivityRequestSchema),
    async (ctx) => {
      const { workspaceId, userId, canonicalPath, agent, activity } =
        ctx.req.valid("json");
      const documentName = toSessionName(workspaceId, canonicalPath);
      if (!hocuspocus.documents.has(documentName)) {
        return ctx.json({});
      }

      const file = await checkCollabReadAccess(
        await Authenticator.fromUserIdAndWorkspaceId(userId, workspaceId),
        canonicalPath
      );
      if (file.isErr()) {
        return apiError(ctx, collabAccessErrorToApiError(file.error));
      }
      showAgentActivity(hocuspocus, documentName, agent, activity);
      return ctx.json({});
    }
  );

  return app;
}

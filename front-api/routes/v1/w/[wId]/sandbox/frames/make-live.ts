import { attachPublishedFrameToParentAction } from "@app/lib/api/frames/attach_published_frame";
import { makeFrameDraftLive } from "@app/lib/api/frames/make_live";
import { resolveWritableSandboxFrame } from "@app/lib/api/frames/sandbox_frame_lookup";
import logger from "@app/logger/logger";
import { frameMakeLiveApiError } from "@front-api/lib/api/frame_make_live_errors";
import { sandboxFrameLookupApiError } from "@front-api/lib/api/sandbox_frame_lookup_errors";
import { sandboxApp } from "@front-api/middlewares/ctx";
import type { HandlerResult } from "@front-api/middlewares/utils";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

const FrameMakeLiveRequestSchema = z.object({
  // Scoped path of the Frame's manifest.json, as `publish` takes it.
  manifestPath: z.string().min(1),
});

type FrameMakeLiveResponse = {
  frameId: string;
  publicationId: string;
};

// Mounted at /api/v1/w/:wId/sandbox/frames/make-live.
const app = sandboxApp();

/**
 * @ignoreswagger
 * internal endpoint
 */
/**
 * @cc [owner:davidebbo,label:product] sandbox-make-live-validates-the-latest
 * The route MUST make live the Frame's latest publication as read under its locks (its pending
 * draft, or nothing new when there is none, which only ends draft mode): the agent validates what
 * the user sees in the panel, whoever published it, without naming a publication.
 */
app.post(
  "/",
  validate("json", FrameMakeLiveRequestSchema),
  async (ctx): HandlerResult<FrameMakeLiveResponse> => {
    const auth = ctx.get("auth");
    const resolved = await resolveWritableSandboxFrame(auth, {
      claims: ctx.get("sandboxClaims"),
      manifestPath: ctx.req.valid("json").manifestPath,
    });
    if (resolved.isErr()) {
      return apiError(
        ctx,
        sandboxFrameLookupApiError(resolved.error),
        resolved.error
      );
    }
    const { claims, frame } = resolved.value;

    const result = await makeFrameDraftLive(auth, {
      frame,
      publishedByAgentConfigurationId: claims.aId,
    });
    if (result.isErr()) {
      return apiError(ctx, frameMakeLiveApiError(result.error), result.error);
    }

    // Refresh the Frame card on the parent action so the panel shows the live version.
    // Best-effort: the Frame is already live.
    const attached = await attachPublishedFrameToParentAction(auth, {
      actionId: claims.actionId,
      frameId: frame.sId,
    });
    if (attached.isErr()) {
      logger.warn(
        {
          err: attached.error,
          actionId: claims.actionId,
          conversationId: claims.cId,
          messageId: claims.mId,
          frameId: frame.sId,
        },
        "Failed to attach made-live Frame to parent action generated files."
      );
    }

    return ctx.json(
      {
        frameId: frame.sId,
        publicationId: result.value.publicationId,
      },
      200
    );
  }
);

export default app;

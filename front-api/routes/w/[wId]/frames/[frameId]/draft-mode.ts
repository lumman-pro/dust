import { enterFrameDraftMode } from "@app/lib/api/frames/draft_mode";
import { hasFeatureFlag } from "@app/lib/auth";
import { FileResource } from "@app/lib/resources/file_resource";
import type { PostFrameDraftModeResponseBody } from "@app/types/api/frame_draft_mode";
import { frameDraftModeApiError } from "@front-api/lib/api/frame_draft_mode_errors";
import { workspaceApp } from "@front-api/middlewares/ctx";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

const ParamsSchema = z.object({
  frameId: z.string(),
});

// Mounted at /api/w/:wId/frames/:frameId/draft-mode.
const app = workspaceApp();

/** @ignoreswagger */
app.post("/", validate("param", ParamsSchema), async (ctx) => {
  const auth = ctx.get("auth");
  const { frameId } = ctx.req.valid("param");

  if (!(await hasFeatureFlag(auth, "frames_v2_drafts"))) {
    return apiError(ctx, {
      status_code: 403,
      api_error: {
        type: "feature_not_enabled",
        message: "Frame drafts are not enabled for this workspace.",
      },
    });
  }

  const frame = await FileResource.fetchById(auth, frameId);
  if (!frame?.isFrameV2) {
    return apiError(ctx, {
      status_code: 404,
      api_error: { type: "file_not_found", message: "Frame not found." },
    });
  }

  const result = await enterFrameDraftMode(auth, { frame });
  if (result.isErr()) {
    return apiError(ctx, frameDraftModeApiError(result.error), result.error);
  }

  return ctx.json<PostFrameDraftModeResponseBody>({ draftMode: true });
});

export default app;

import { enterFrameDraftMode } from "@app/lib/api/frames/draft_mode";
import { resolveWritableSandboxFrame } from "@app/lib/api/frames/sandbox_frame_lookup";
import { hasFeatureFlag } from "@app/lib/auth";
import { frameDraftModeApiError } from "@front-api/lib/api/frame_draft_mode_errors";
import { sandboxFrameLookupApiError } from "@front-api/lib/api/sandbox_frame_lookup_errors";
import { sandboxApp } from "@front-api/middlewares/ctx";
import type { HandlerResult } from "@front-api/middlewares/utils";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

const FrameDraftModeRequestSchema = z.object({
  // Scoped path of the published Frame's manifest.json, as `publish` takes it.
  manifestPath: z.string().min(1),
});

type FrameDraftModeResponse = { frameId: string };

// Mounted at /api/v1/w/:wId/sandbox/frames/draft-mode.
const app = sandboxApp();

/**
 * @ignoreswagger
 * internal endpoint
 */
app.post(
  "/",
  validate("json", FrameDraftModeRequestSchema),
  async (ctx): HandlerResult<FrameDraftModeResponse> => {
    const auth = ctx.get("auth");
    if (!(await hasFeatureFlag(auth, "frames_v2_drafts"))) {
      return apiError(ctx, {
        status_code: 403,
        api_error: {
          type: "feature_not_enabled",
          message: "Frame drafts are not enabled for this workspace.",
        },
      });
    }
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

    const { frame } = resolved.value;
    const result = await enterFrameDraftMode(auth, { frame });
    if (result.isErr()) {
      return apiError(ctx, frameDraftModeApiError(result.error), result.error);
    }

    return ctx.json({ frameId: frame.sId }, 200);
  }
);

export default app;

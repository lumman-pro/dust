import { exportInteractiveContentFileAsPdf } from "@app/lib/api/files/pdf_export";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { pdfAttachmentResponse } from "@front-api/lib/file_serving";
import { workspaceApp } from "@front-api/middlewares/ctx";
import { apiError } from "@front-api/middlewares/utils";
import { validate } from "@front-api/middlewares/validator";
import { z } from "zod";

const PostPdfExportBodySchema = z.object({
  orientation: z.enum(["portrait", "landscape"]).optional(),
});

const ParamsSchema = z.object({
  fileId: z.string(),
});

// Mounted at /api/w/:wId/files/:fileId/export/pdf.
const app = workspaceApp();

/** @ignoreswagger */
app.post(
  "/",
  validate("param", ParamsSchema),
  validate("json", PostPdfExportBodySchema),
  async (ctx) => {
    const auth = ctx.get("auth");
    const { fileId } = ctx.req.valid("param");
    const { orientation } = ctx.req.valid("json");

    const result = await exportInteractiveContentFileAsPdf(auth, {
      fileId,
      orientation,
    });

    if (result.isErr()) {
      const { error } = result;
      switch (error.type) {
        case "file_not_found":
          return apiError(ctx, {
            status_code: 404,
            api_error: { type: "file_not_found", message: error.message },
          });
        case "not_frame":
          return apiError(ctx, {
            status_code: 400,
            api_error: {
              type: "file_not_frame",
              message: error.message,
            },
          });
        case "not_shareable":
          return apiError(ctx, {
            status_code: 400,
            api_error: {
              type: "frame_not_shareable",
              message: error.message,
            },
          });
        case "render_failed":
          return apiError(ctx, {
            status_code: 500,
            api_error: {
              type: "internal_server_error",
              message: error.message,
            },
          });
        default:
          assertNever(error.type);
      }
    }

    const { buffer, fileName } = result.value;
    return pdfAttachmentResponse(buffer, fileName);
  }
);

export default app;

import type { FrameDraftModeError } from "@app/lib/api/frames/draft_mode";
import type { APIErrorWithContentfulStatusCode } from "@app/types/error";
import { assertNever } from "@app/types/shared/utils/assert_never";

/** Maps a draft-mode failure to the API error both draft-mode routes answer with. */
export function frameDraftModeApiError(
  error: FrameDraftModeError
): APIErrorWithContentfulStatusCode {
  const { code, message } = error;
  switch (code) {
    case "unauthorized":
      return {
        status_code: 403,
        api_error: { type: "file_read_only", message },
      };
    case "frame_not_found":
      return {
        status_code: 404,
        api_error: { type: "file_not_found", message },
      };
    case "frame_not_published":
      return {
        status_code: 409,
        api_error: { type: "frame_not_published", message },
      };
    case "conflict":
      return {
        status_code: 409,
        api_error: { type: "frame_draft_conflict", message },
      };
    default:
      return assertNever(code);
  }
}

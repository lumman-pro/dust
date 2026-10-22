import type { SandboxFrameLookupError } from "@app/lib/api/frames/sandbox_frame_lookup";
import type { APIErrorWithContentfulStatusCode } from "@app/types/error";
import { assertNever } from "@app/types/shared/utils/assert_never";

/** Maps a failure to resolve a sandbox Frame by its manifest path to the API error it is served as. */
export function sandboxFrameLookupApiError(
  error: SandboxFrameLookupError
): APIErrorWithContentfulStatusCode {
  const { code, message } = error;
  switch (code) {
    case "token_not_allowed":
      return {
        status_code: 403,
        api_error: { type: "sandbox_token_not_allowed", message },
      };
    case "conversation_not_found":
      return {
        status_code: 404,
        api_error: { type: "conversation_not_found", message },
      };
    case "invalid_source":
      return {
        status_code: 400,
        api_error: { type: "invalid_request_error", message },
      };
    case "frame_not_in_conversation":
      return {
        status_code: 403,
        api_error: { type: "frame_not_in_conversation", message },
      };
    case "frame_not_found":
      return {
        status_code: 404,
        api_error: { type: "file_not_found", message },
      };
    default:
      return assertNever(code);
  }
}

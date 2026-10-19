import type { APIError } from "@anthropic-ai/sdk";

import { isRecord } from "@app/types/shared/utils/general";

const FILE_DOWNLOAD_ERROR = "Unable to download the file";
const PROMPT_TOO_LONG_ERROR = "prompt is too long";

// Returns the inner message of a 400 `invalid_request_error`, or null for any other error.
function getInvalidRequestErrorMessage(error: APIError): string | null {
  const body = error.error;
  if (
    error.status !== 400 ||
    error.type !== "invalid_request_error" ||
    typeof body !== "object" ||
    body === null ||
    !isRecord(body) ||
    body.type !== "error"
  ) {
    return null;
  }

  const details = body.error;
  if (
    typeof details === "object" &&
    details !== null &&
    isRecord(details) &&
    details.type === "invalid_request_error" &&
    typeof details.message === "string"
  ) {
    return details.message;
  }

  return null;
}

export function isAnthropicFileDownloadError(error: APIError): boolean {
  return (
    getInvalidRequestErrorMessage(error)?.startsWith(FILE_DOWNLOAD_ERROR) ??
    false
  );
}

export function isAnthropicPromptTooLongMessage(message: string): boolean {
  return message.startsWith(PROMPT_TOO_LONG_ERROR);
}

export function isAnthropicPromptTooLongError(error: APIError): boolean {
  const message = getInvalidRequestErrorMessage(error);
  return message !== null && isAnthropicPromptTooLongMessage(message);
}

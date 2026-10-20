import type { EndpointMetadata } from "@app/lib/model_constructors/types/endpoint_metadata";
import type {
  ErrorEvent,
  ErrorSource,
  ErrorType,
  RefusalDetails,
} from "@app/lib/model_constructors/types/output/events";

export function buildErrorEvent({
  metadata,
  type,
  message,
  originalError,
  errorSource,
  refusal,
}: {
  metadata: EndpointMetadata;
  type: ErrorType;
  message: string;
  originalError?: unknown;
  errorSource: ErrorSource;
  refusal?: RefusalDetails;
}): ErrorEvent {
  return {
    type: "error",
    content: {
      type,
      message,
      originalError,
      errorSource,
      ...(refusal ? { refusal } : {}),
    },
    metadata,
  };
}

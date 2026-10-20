import {
  buildAuditLogTarget,
  emitAuditLogEvent,
  getAuditLogContext,
} from "@app/lib/api/audit/workos_audit";
import { withFrameSourceLock } from "@app/lib/api/frames/operation_lock";
import { canWriteFrameV2Source } from "@app/lib/api/frames/permissions";
import type { Authenticator } from "@app/lib/auth";
import { isLockAcquisitionTimeoutError } from "@app/lib/lock";
import type { FileResource } from "@app/lib/resources/file_resource";
import { getFrameV2NameFromManifestPath } from "@app/types/api/frame_manifest";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

export class FrameDraftModeError extends Error {
  constructor(
    readonly code:
      | "unauthorized"
      | "frame_not_found"
      | "frame_not_published"
      | "conflict",
    message: string
  ) {
    super(message);
    this.name = "FrameDraftModeError";
  }
}

export function isFrameDraftModeError(
  error: unknown
): error is FrameDraftModeError {
  return error instanceof FrameDraftModeError;
}

type EnterDraftModeResult = Result<void, FrameDraftModeError>;

/**
 * @cc [owner:davidebbo,label:audit-logging;security] draft-mode-changes-are-audited
 * Every change of a Frame's draft mode, on or off, MUST emit `frame.draft_mode_updated` through
 * this helper, after the change is stored: draft mode decides whether publishes reach share-link
 * viewers.
 */
export function emitFrameDraftModeAuditLog(
  auth: Authenticator,
  frame: FileResource,
  draftMode: "on" | "off"
) {
  void emitAuditLogEvent({
    auth,
    action: "frame.draft_mode_updated",
    targets: [
      buildAuditLogTarget("workspace", auth.getNonNullableWorkspace()),
      buildAuditLogTarget("frame", {
        sId: frame.sId,
        name:
          (frame.mountFilePath
            ? getFrameV2NameFromManifestPath(frame.mountFilePath)
            : null) ?? frame.sId,
      }),
    ],
    context: getAuditLogContext(auth),
    metadata: { frame_id: frame.sId, draft_mode: draftMode },
  });
}

/**
 * @cc [owner:davidebbo,label:product;security] entering-draft-mode
 * Entering draft mode MUST require `canWriteFrameV2Source` on the Frame as read under its source
 * lock, MUST require a live publication (`frame_not_published` otherwise: a first publish always
 * goes live), and MUST NOT change either publication pointer. Entering it again while it is on MUST
 * succeed without changing who turned it on.
 */
export async function enterFrameDraftMode(
  auth: Authenticator,
  { frame }: { frame: FileResource }
): Promise<EnterDraftModeResult> {
  const user = auth.getNonNullableUser();
  // The source lock serializes with every publish, which reads draft mode under it.
  const result = await withFrameSourceLock(
    frame.sId,
    async (): Promise<EnterDraftModeResult> => {
      const fresh = await frame.fetchFreshFrameV2(auth);
      if (!fresh) {
        return new Err(
          new FrameDraftModeError("frame_not_found", "Frame not found.")
        );
      }
      if (!(await canWriteFrameV2Source(auth, fresh))) {
        return new Err(
          new FrameDraftModeError("unauthorized", "You cannot edit this Frame.")
        );
      }
      if (!fresh.useCaseMetadata?.activePublicationId) {
        return new Err(
          new FrameDraftModeError(
            "frame_not_published",
            "This Frame has no live version yet."
          )
        );
      }
      if (!fresh.isInFrameDraftMode) {
        await fresh.enterFrameDraftMode({ userSId: user.sId });
        emitFrameDraftModeAuditLog(auth, fresh, "on");
      }
      return new Ok(undefined);
    }
  );
  if (result.isErr()) {
    return new Err(
      isLockAcquisitionTimeoutError(result.error)
        ? new FrameDraftModeError(
            "conflict",
            "This Frame is being published; retry shortly."
          )
        : result.error
    );
  }
  return new Ok(undefined);
}

import { useMakeFrameDraftLive } from "@app/hooks/useMakeFrameDraftLive";
import {
  TRACKING_ACTIONS,
  TRACKING_AREAS,
  trackEvent,
} from "@app/lib/tracking";
import type { LightWorkspaceType } from "@app/types/user";
import { Button, Check } from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

interface FrameDraftControlsProps {
  /** The pending draft, or null when nothing changed since draft mode was turned on. */
  draftPublicationId: string | null;
  frameId: string;
  hideLabels: boolean;
  livePublicationId: string;
  onValidated: () => Promise<unknown>;
  owner: LightWorkspaceType;
}

/** The action that ends draft mode, making its changes live if there are any. */
export function FrameDraftControls({
  draftPublicationId,
  frameId,
  hideLabels,
  livePublicationId,
  onValidated,
  owner,
}: FrameDraftControlsProps) {
  const { t } = useLingui();
  const makeDraftLive = useMakeFrameDraftLive({ owner, frameId });
  const [isValidating, setIsValidating] = useState(false);
  const hasChanges = draftPublicationId !== null;

  const handleValidate = async () => {
    trackEvent({
      area: TRACKING_AREAS.FRAMES,
      object: "draft_make_live",
      action: TRACKING_ACTIONS.CLICK,
      extra: {
        frame_id: frameId,
        draft_publication_id: draftPublicationId ?? "",
        has_changes: hasChanges,
      },
    });
    setIsValidating(true);
    try {
      // With nothing changed, naming the live publication only ends draft mode.
      await makeDraftLive(draftPublicationId ?? livePublicationId, {
        hasChanges,
      });
      // Refreshes either way: success ends draft mode; a conflict brings the newer draft in.
      await onValidated();
    } finally {
      setIsValidating(false);
    }
  };

  return (
    <Button
      label={hideLabels ? undefined : t`Validate draft`}
      icon={Check}
      size="xs"
      variant="highlight"
      isLoading={isValidating}
      disabled={isValidating}
      onClick={() => {
        void handleValidate();
      }}
      aria-label={t`Validate draft`}
      tooltip={
        hasChanges
          ? t`Show these changes on the share link`
          : t`No changes yet. This leaves draft mode.`
      }
    />
  );
}

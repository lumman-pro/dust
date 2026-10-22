import { useEnterFrameDraftMode } from "@app/hooks/useEnterFrameDraftMode";
import { useMakeFrameDraftLive } from "@app/hooks/useMakeFrameDraftLive";
import {
  TRACKING_ACTIONS,
  TRACKING_AREAS,
  trackEvent,
} from "@app/lib/tracking";
import type { LightWorkspaceType } from "@app/types/user";
import {
  Button,
  Check,
  DotsHorizontal,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

interface FrameDraftControlsProps {
  /** Whether the "Activate draft mode" menu is offered while draft mode is off. */
  canEnterDraftMode: boolean;
  draftMode: boolean;
  /** The pending draft, or null when nothing changed since draft mode was turned on. */
  draftPublicationId: string | null;
  frameId: string;
  hideLabels: boolean;
  livePublicationId: string | null;
  /** Refreshes the Frame's permissions after draft mode changed (or failed to). */
  onDraftModeChanged: () => Promise<unknown>;
  owner: LightWorkspaceType;
}

/**
 * Draft mode for a Frame's editors in the conversation panel: a "more" menu that turns it on,
 * then, while it is on, the action that ends it, making its changes live if there are any.
 */
export function FrameDraftControls({
  canEnterDraftMode,
  draftMode,
  draftPublicationId,
  frameId,
  hideLabels,
  livePublicationId,
  onDraftModeChanged,
  owner,
}: FrameDraftControlsProps) {
  const { t } = useLingui();
  const enterDraftMode = useEnterFrameDraftMode({ owner, frameId });
  const makeDraftLive = useMakeFrameDraftLive({ owner, frameId });
  const [isPending, setIsPending] = useState(false);
  const hasChanges = draftPublicationId !== null;

  if (draftMode && livePublicationId) {
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
      setIsPending(true);
      try {
        // With nothing changed, naming the live publication only ends draft mode.
        await makeDraftLive(draftPublicationId ?? livePublicationId, {
          hasChanges,
        });
        // Refreshes either way: success ends draft mode; a conflict brings the newer draft in.
        await onDraftModeChanged();
      } finally {
        setIsPending(false);
      }
    };

    return (
      <Button
        label={hideLabels ? undefined : t`Validate draft`}
        icon={Check}
        size="xs"
        variant="highlight"
        isLoading={isPending}
        disabled={isPending}
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

  if (!canEnterDraftMode) {
    return null;
  }

  const handleEnterDraftMode = async () => {
    trackEvent({
      area: TRACKING_AREAS.FRAMES,
      object: "draft_mode_enter",
      action: TRACKING_ACTIONS.CLICK,
      extra: { frame_id: frameId },
    });
    setIsPending(true);
    try {
      if (await enterDraftMode()) {
        await onDraftModeChanged();
      }
    } finally {
      setIsPending(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          icon={DotsHorizontal}
          variant="ghost"
          isLoading={isPending}
          aria-label={t`More actions`}
          tooltip={t`More actions`}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          label={t`Activate draft mode`}
          disabled={isPending}
          onClick={() => {
            void handleEnterDraftMode();
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

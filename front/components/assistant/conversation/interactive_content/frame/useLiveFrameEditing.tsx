import { useFramePermissions } from "@app/lib/swr/frames";
import type { LightWorkspaceType } from "@app/types/user";
import { Chip, Tooltip } from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";

function FrameDraftModeChip() {
  const { t } = useLingui();

  return (
    <Tooltip
      label={t`This Frame is in draft mode. Edit it from the conversation.`}
      tooltipTriggerAsChild
      trigger={
        <span className="inline-flex shrink-0 items-center">
          <Chip size="mini" label={t`Draft mode`} />
        </span>
      }
    />
  );
}

/**
 * @cc [owner:davidebbo,label:product;react] live-frame-surfaces-edit-no-draft
 * While the permissions this hook last fetched report draft mode, it MUST NOT offer editing
 * (`canEditV2` false) and MUST give source writers the `status` chip pointing them to the
 * conversation. Every Pod surface that edits a Frames v2 source MUST get its edit rights from this
 * hook and MUST refresh its permissions after a Save (`mutateFramePermissions` as `onSaved`). Draft
 * mode turned on while the surface is open is only seen on that refresh: a Save made before it
 * publishes as a draft server-side, so it never replaces the live version with draft changes.
 */
export function useLiveFrameEditing({
  owner,
  frameId,
  isV2,
  disabled,
}: {
  owner: LightWorkspaceType;
  frameId: string;
  isV2: boolean;
  disabled: boolean;
}) {
  const permissions = useFramePermissions({ owner, frameId, disabled });
  const canWriteV2 = isV2 && permissions.canWriteFrameSource;

  return {
    ...permissions,
    canEditV2: canWriteV2 && !permissions.draftMode,
    status:
      canWriteV2 && permissions.draftMode ? <FrameDraftModeChip /> : undefined,
  };
}

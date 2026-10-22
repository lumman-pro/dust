import { FrameSharingFiles } from "@app/components/assistant/conversation/interactive_content/frame/FrameSharingFiles";
import { FrameSharingGrants } from "@app/components/assistant/conversation/interactive_content/frame/FrameSharingGrants";
import { FrameSharingViewers } from "@app/components/assistant/conversation/interactive_content/frame/FrameSharingViewers";
import {
  getAvailableScopeOptions,
  SHARE_SCOPE_ICONS,
} from "@app/components/assistant/conversation/interactive_content/frame/shareFrameScopeOptions";
import { Section } from "@app/components/assistant/conversation/interactive_content/frame/ShareFrameSection";
import {
  useShareInteractiveContentFile,
  useSharingGrants,
} from "@app/lib/swr/files";
import { useWorkspacePermissions } from "@app/lib/swr/permissions";
import { useIsMobile } from "@app/lib/swr/useIsMobile";
import type { FileShareScope } from "@app/types/files";
import type { LightWorkspaceType } from "@app/types/user";
import {
  Button,
  Check,
  ContentMessage,
  Icon,
  Label,
  Link01,
  ListGroup,
  ListItem,
  LoadingBlock,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Spinner,
  Upload01,
  useCopyToClipboard,
} from "@dust-tt/sparkle";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

interface ShareFramePopoverProps {
  fileId: string;
  owner: LightWorkspaceType;
  /** Bursts share/grants cache when frame content changes (e.g. `fileId@updatedAt`). */
  contentHash?: string | null;
}

/**
 * @cc [owner:flvndvd,label:product] share-button-scope-icon
 * When sharing settings load or change, the trigger MUST use the same icon as
 * the corresponding access option.
 */
export function ShareFramePopover({
  fileId,
  owner,
  contentHash,
}: ShareFramePopoverProps) {
  const { t } = useLingui();
  const titleId = useId();
  const isMobile = useIsMobile();
  const [isOpen, setIsOpen] = useState(false);
  // The visible trigger needs the sharing scope even when the popover is closed.
  const fileSharing = useShareInteractiveContentFile({
    fileId,
    owner,
    cacheKey: contentHash,
  });
  const { fileShare, isFileShareLoading } = fileSharing;

  return (
    <PopoverRoot open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          {...(isMobile ? { tooltip: t`Share` } : { label: t`Share` })}
          icon={fileShare ? SHARE_SCOPE_ICONS[fileShare.scope] : Upload01}
          isLoading={isFileShareLoading}
        />
      </PopoverTrigger>
      <PopoverContent
        aria-labelledby={titleId}
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={8}
        preventAutoFocusOnClose={false}
        className="flex w-80 max-h-(--radix-popover-content-available-height) flex-col overflow-hidden p-3"
      >
        <span id={titleId} className="sr-only">
          <Trans>Share this frame</Trans>
        </span>
        <ShareFramePopoverContent
          fileId={fileId}
          owner={owner}
          contentHash={contentHash}
          titleId={titleId}
          fileSharing={fileSharing}
        />
      </PopoverContent>
    </PopoverRoot>
  );
}

interface ShareFramePopoverContentProps extends ShareFramePopoverProps {
  titleId: string;
  fileSharing: ReturnType<typeof useShareInteractiveContentFile>;
}

// Radix keeps this content mounted through the exit animation, including its queries.
function ShareFramePopoverContent({
  fileId,
  owner,
  contentHash,
  titleId,
  fileSharing,
}: ShareFramePopoverContentProps) {
  const { t } = useLingui();
  const [shareBlockError, setShareBlockError] = useState<string[] | null>(null);
  const [isUpdatingScope, setIsUpdatingScope] = useState(false);

  const {
    doShare,
    fileShare,
    isFileShareLoading,
    isFileShareError,
    mutateFileShare,
  } = fileSharing;

  const {
    sharing,
    isGrantsLoading,
    isGrantsError,
    doAddGrants,
    doRevokeGrant,
    mutateGrants,
  } = useSharingGrants({
    fileId,
    owner,
    cacheKey: contentHash,
  });

  const currentScope: FileShareScope =
    fileShare?.scope ?? "workspace_and_emails";
  const shareURL = fileShare?.shareUrl ?? "";
  const viewerFiles = fileShare?.viewerFiles ?? [];

  const externalSharingDisabledByPolicy =
    owner.sharingPolicy === "workspace_only";

  const { hasPermission } = useWorkspacePermissions();

  const canInviteExternal =
    !externalSharingDisabledByPolicy && hasPermission("invite", "frame");
  const canPublish =
    owner.sharingPolicy === "all_scopes" && hasPermission("publish", "frame");

  const lostPublishPermission = currentScope === "public" && !canPublish;

  const availableScopeOptions = getAvailableScopeOptions({
    sharingPolicy: owner.sharingPolicy,
    canInviteExternal,
    canPublish,
    currentScope,
  });

  const blockedRefs = shareBlockError?.join(", ");

  const showGrants =
    currentScope === "emails_only" || currentScope === "workspace_and_emails";

  const handleScopeChange = async (scope: FileShareScope) => {
    setShareBlockError(null);
    setIsUpdatingScope(true);
    try {
      const result = await doShare(scope);
      if (!result.success && result.unverifiableRefs?.length) {
        setShareBlockError(result.unverifiableRefs);
      }
    } finally {
      setIsUpdatingScope(false);
    }
  };

  return (
    <>
      <div className="min-h-0 overflow-y-auto">
        {isFileShareError || (!isFileShareLoading && !fileShare) ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 py-4"
          >
            <p className="text-sm text-muted-foreground">
              <Trans>Could not load sharing settings.</Trans>
            </p>
            <Button
              label={t`Retry`}
              variant="outline"
              onClick={() => {
                void mutateFileShare();
              }}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {!canInviteExternal && (
              <ContentMessage
                variant="info"
                title={t`Only workspace members can be added`}
                size="sm"
              >
                {externalSharingDisabledByPolicy
                  ? t`Your admin has disabled external sharing. You can only invite people already in your workspace.`
                  : t`You don’t have permission to invite people outside your workspace. You can only invite people already in your workspace.`}
              </ContentMessage>
            )}
            {lostPublishPermission && (
              <ContentMessage
                title={t`You no longer have permission to share frames publicly`}
                size="sm"
              >
                <Trans>
                  This frame is currently shared publicly. You can restrict
                  access, but you won’t be able to make it public again.
                </Trans>
              </ContentMessage>
            )}
            {shareBlockError && shareBlockError.length > 0 && (
              <ContentMessage
                variant="warning"
                title={t`Some referenced files cannot be shared`}
                size="sm"
              >
                <Trans>
                  Viewers will only be able to access files you can verify. Fix
                  or remove these references before sharing: {blockedRefs}
                </Trans>
              </ContentMessage>
            )}
            <FrameSharingFiles viewerFiles={viewerFiles} />
            <AccessScopeSection
              titleId={titleId}
              currentScope={currentScope}
              availableScopeOptions={availableScopeOptions}
              isLoading={isFileShareLoading}
              isUpdatingScope={isUpdatingScope}
              onScopeChange={handleScopeChange}
            />

            {showGrants && (
              <FrameSharingGrants
                sharing={sharing}
                canInviteExternal={canInviteExternal}
                canRevoke={hasPermission("invite", "frame")}
                isLoading={isGrantsLoading}
                hasError={!!isGrantsError}
                onAdd={doAddGrants}
                onRevoke={doRevokeGrant}
                onRetry={() => {
                  void mutateGrants();
                }}
              />
            )}
            {isFileShareLoading ? (
              <LoadingBlock className="h-8 w-full rounded-xl" />
            ) : (
              <CopyLinkButton shareURL={shareURL} />
            )}
            <FrameSharingViewers
              viewers={sharing?.viewers}
              isLoading={isGrantsLoading}
              hasError={!!isGrantsError}
              onRetry={() => {
                void mutateGrants();
              }}
            />
          </div>
        )}
      </div>
    </>
  );
}

interface CopyLinkButtonProps {
  shareURL: string;
}

function CopyLinkButton({ shareURL }: CopyLinkButtonProps) {
  const { t } = useLingui();
  const [isCopied, copyToClipboard] = useCopyToClipboard();

  return (
    <Button
      variant="primary"
      icon={isCopied ? Check : Link01}
      label={isCopied ? t`Copied!` : t`Copy link`}
      disabled={!shareURL}
      className="w-full"
      onClick={async () => {
        await copyToClipboard(shareURL);
      }}
    />
  );
}

// Approximate widths of the scope labels, in display order.
const SCOPE_LABEL_SKELETON_CLASSNAMES = ["h-3 w-16", "h-3 w-44", "h-3 w-28"];

interface AccessScopeSkeletonProps {
  availableScopeOptions: ReturnType<typeof getAvailableScopeOptions>;
}

function AccessScopeSkeleton({
  availableScopeOptions,
}: AccessScopeSkeletonProps) {
  const { t } = useLingui();

  return (
    <div role="status" aria-label={t`Loading sharing settings`}>
      <div aria-hidden="true">
        {availableScopeOptions.map((option, index) => (
          <ListItem
            key={option.value}
            className="gap-2 p-3 dark:border-border-form"
            itemsAlignment="center"
            hasSeparator={index < availableScopeOptions.length - 1}
            hasSeparatorIfLast
          >
            <LoadingBlock className="h-4 w-4 shrink-0" />
            <LoadingBlock
              className={
                SCOPE_LABEL_SKELETON_CLASSNAMES[
                  index % SCOPE_LABEL_SKELETON_CLASSNAMES.length
                ]
              }
            />
          </ListItem>
        ))}
      </div>
    </div>
  );
}

interface AccessScopeSectionProps {
  titleId: string;
  currentScope: FileShareScope;
  availableScopeOptions: ReturnType<typeof getAvailableScopeOptions>;
  isLoading: boolean;
  isUpdatingScope: boolean;
  onScopeChange: (scope: FileShareScope) => void;
}

function AccessScopeSection({
  titleId,
  currentScope,
  availableScopeOptions,
  isLoading,
  isUpdatingScope,
  onScopeChange,
}: AccessScopeSectionProps) {
  const { t } = useLingui();

  return (
    <Section
      label={
        <span className="flex items-center">
          <Trans>Who has access</Trans>
          {isUpdatingScope && (
            <span role="status" className="ml-2 inline-flex items-center">
              <span aria-hidden="true">
                <Spinner size="xs" />
              </span>
              <span className="sr-only">
                <Trans>Updating sharing settings</Trans>
              </span>
            </span>
          )}
        </span>
      }
    >
      <ListGroup className="overflow-hidden rounded-xl border-x dark:border-border-form">
        {isLoading ? (
          <AccessScopeSkeleton availableScopeOptions={availableScopeOptions} />
        ) : (
          availableScopeOptions.map((option, index) => {
            const isSelected = option.value === currentScope;
            const isDisabled = option.disabled || isUpdatingScope;
            const inputId = `${titleId}-scope-${option.value}`;
            return (
              <Label
                key={option.value}
                htmlFor={inputId}
                className={`block has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-highlight-300 ${
                  isDisabled
                    ? "cursor-not-allowed opacity-60"
                    : "cursor-pointer hover:bg-muted-background"
                }`}
              >
                <input
                  type="radio"
                  id={inputId}
                  name={`${titleId}-scope`}
                  aria-labelledby={`${inputId}-label`}
                  value={option.value}
                  checked={isSelected}
                  disabled={isDisabled}
                  onChange={() => onScopeChange(option.value)}
                  className="sr-only"
                />
                <ListItem
                  className="gap-2 p-3 dark:border-border-form"
                  itemsAlignment="center"
                  hasSeparator={index < availableScopeOptions.length - 1}
                  hasSeparatorIfLast
                >
                  <Icon
                    visual={option.icon}
                    size="xs"
                    className="shrink-0 text-faint"
                  />
                  <span
                    id={`${inputId}-label`}
                    className="min-w-0 flex-1 label-xs text-muted-foreground"
                  >
                    {t(option.label)}
                  </span>
                  {isSelected && (
                    <Icon
                      visual={Check}
                      size="xs"
                      className="shrink-0 text-muted-foreground"
                    />
                  )}
                </ListItem>
              </Label>
            );
          })
        )}
      </ListGroup>
    </Section>
  );
}

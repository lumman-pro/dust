import { DEFAULT_RIGHT_PANEL_SIZE } from "@app/components/assistant/conversation/constant";
import type { FilePreviewTarget } from "@app/components/assistant/conversation/ConversationSidePanelContext";
import {
  parseFilePreviewData,
  useConversationSidePanelContext,
} from "@app/components/assistant/conversation/ConversationSidePanelContext";
import { ConversationSidePanelHeader } from "@app/components/assistant/conversation/ConversationSidePanelHeader";
import { CenteredState } from "@app/components/assistant/conversation/interactive_content/CenteredState";
import { useSidePanelFullScreen } from "@app/components/assistant/conversation/useSidePanelFullScreen";
import { CollabViewModeFileIcon } from "@app/components/file_explorer/CollabViewModeFileIcon";
import {
  FilePreviewBody,
  filePreviewLayoutClassName,
} from "@app/components/file_explorer/FilePreviewBody";
import {
  formatRecordCounts,
  useFilePreviewContent,
} from "@app/components/file_explorer/FilePreviewContent";
import { MarkdownFilePreviewViewModeSwitch } from "@app/components/file_explorer/MarkdownFilePreview";
import type { FileEntry } from "@app/components/file_explorer/types";
import { useMarkdownFileEditor } from "@app/components/file_explorer/useMarkdownFileEditor";
import { useConversationSandboxFiles } from "@app/hooks/conversations/useConversationSandboxFiles";
import { useDownloadPdf } from "@app/hooks/useDownloadPdf";
import { useFeatureFlags } from "@app/lib/auth/AuthContext";
import { useClientType } from "@app/lib/context/clientType";
import { getFileTypeIcon } from "@app/lib/file_icon_utils";
import {
  getFileDownloadUrl,
  getFilePathDownloadUrl,
  getFilePathViewUrl,
  getFileViewUrl,
  useFileMetadata,
} from "@app/lib/swr/files";
import { useIsMobile } from "@app/lib/swr/useIsMobile";
import type {
  FileSystemEntry,
  FileSystemFileEntry,
} from "@app/types/api/file_system/types";
import type { ConversationWithoutContentType } from "@app/types/assistant/conversation";
import { contentTypeFromFileName, stripFileExtension } from "@app/types/files";
import { resolveCanonicalScopedPath } from "@app/types/mount_path";
import type { LightWorkspaceType } from "@app/types/user";
import {
  Button,
  cn,
  Download01,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Maximize01,
  Minimize01,
  Spinner,
} from "@dust-tt/sparkle";
import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useState } from "react";

export function findListedFile(
  files: FileSystemEntry[],
  path: string | null
): FileSystemFileEntry | undefined {
  return path
    ? files.find(
        (f): f is FileSystemFileEntry => !f.isDirectory && f.path === path
      )
    : undefined;
}

interface FilePreviewPanelProps {
  conversation: ConversationWithoutContentType;
  owner: LightWorkspaceType;
}

export function FilePreviewPanel({
  conversation,
  owner,
}: FilePreviewPanelProps) {
  const { data } = useConversationSidePanelContext();
  const target = parseFilePreviewData(data);

  // Agents write legacy scoped paths; the files API only resolves canonical ones.
  const path =
    target?.kind === "path"
      ? resolveCanonicalScopedPath(target.filePath, {
          conversationId: conversation.sId,
          spaceId: conversation.spaceId,
        })
      : null;

  // The conversion preview is cached (Cache-Control: max-age) per URL, so we
  // bust it with the file's lastModifiedMs. SWR revalidates this list on mount
  // and window focus, so the preview refreshes after the file is touched (and
  // the reload button forces an immediate revalidation).
  // TODO: use E2B events of "files are updated", when they are merged
  const { sandboxFiles, isSandboxFilesLoading } = useConversationSandboxFiles({
    conversationId: conversation.sId,
    owner,
    options: { disabled: !path },
  });

  return (
    <FilePreviewPanelView
      owner={owner}
      target={target}
      path={path}
      listedFile={findListedFile(sandboxFiles, path)}
      isListingLoading={isSandboxFilesLoading}
    />
  );
}

interface FilePreviewPanelViewProps {
  owner: LightWorkspaceType;
  target: FilePreviewTarget | null;
  path: string | null;
  listedFile: FileSystemFileEntry | undefined;
  isListingLoading: boolean;
}

/**
 * @cc [owner:tdraier,label:product] file-preview-panel-full-screen
 * The full screen toggle MUST show only for a file open in the rich document editor, or in its
 * source mode, behind the co_edition flag; other previews MUST keep the panel without it.
 */
export function FilePreviewPanelView({
  owner,
  target,
  path,
  listedFile,
  isListingLoading,
}: FilePreviewPanelViewProps) {
  const { t } = useLingui();
  const { openPanel } = useConversationSidePanelContext();
  const { isFullScreen, enterFullScreen, exitFullScreen, closePanel } =
    useSidePanelFullScreen(DEFAULT_RIGHT_PANEL_SIZE);
  const isMobile = useIsMobile();
  const clientType = useClientType();
  const { hasFeature } = useFeatureFlags();
  const [documentControls, setDocumentControls] =
    useState<HTMLDivElement | null>(null);
  const [documentStatus, setDocumentStatus] = useState<HTMLSpanElement | null>(
    null
  );
  const downloadPdf = useDownloadPdf();
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const fileId = target?.kind === "id" ? target.fileId : null;
  const filePath = target?.kind === "path" ? target.filePath : null;
  const openCommentId = target?.kind === "path" ? target.commentId : undefined;
  const onActiveCommentChange = useCallback(
    (commentId: string | null) => {
      if (!filePath) {
        return;
      }
      openPanel({
        type: "file_preview",
        kind: "path",
        filePath,
        commentId: commentId ?? undefined,
      });
    },
    [openPanel, filePath]
  );
  const activeComment = filePath
    ? { id: openCommentId ?? null, onChange: onActiveCommentChange }
    : undefined;

  const { fileMetadata, isFileMetadataLoading } = useFileMetadata({
    fileId,
    owner,
    disabled: !fileId,
  });

  const fileName = path
    ? (path.split("/").pop() ?? path)
    : (fileMetadata?.fileName ?? "");
  // Reuse the file-explorer entry when the listing has loaded so we get the
  // real content type, fileId, and version. Before it loads (or for files
  // missing from the listing) fall back to a minimal entry derived from the
  // file name — Office documents have no in-browser renderer, so the content
  // type is needed to pick the right preview strategy and icon.
  const urls = path
    ? {
        baseUrl: getFilePathViewUrl(owner, path),
        downloadUrl: getFilePathDownloadUrl(owner, path, {
          lastModifiedMs: listedFile?.lastModifiedMs,
        }),
      }
    : fileId
      ? {
          baseUrl: getFileViewUrl(owner, fileId),
          downloadUrl: getFileDownloadUrl(owner, fileId),
        }
      : null;
  const contentType =
    listedFile?.contentType ??
    fileMetadata?.contentType ??
    contentTypeFromFileName(fileName) ??
    "";

  const entry: FileEntry | null = listedFile
    ? { ...listedFile, kind: "file" }
    : path || fileMetadata
      ? {
          kind: "file",
          isDirectory: false,
          fileName,
          path: path ?? "",
          contentType,
          fileId,
          thumbnailUrl: null,
          sizeBytes: fileMetadata?.fileSize ?? 0,
          lastModifiedMs: 0,
        }
      : null;

  const preview = useFilePreviewContent({
    entry,
    fileUrl: urls?.baseUrl ?? null,
    enabled: !!entry,
  });

  const markdown = useMarkdownFileEditor({
    category: preview.category,
    entryPath: path ?? undefined,
    fileUrl: urls?.baseUrl ?? null,
    isActive: !!entry,
    isContentLoading: preview.isContentLoading,
    isTooLarge: preview.isTooLarge,
    isTruncated: preview.isTruncated,
    canWrite: preview.canWrite,
    owner,
    rawContent: preview.truncatedContent,
    processedContent: preview.processedContent,
  });

  if (isListingLoading || !entry || !urls) {
    return (
      <div className="flex h-panel flex-col">
        <ConversationSidePanelHeader onClose={closePanel} />
        <CenteredState>
          {isFileMetadataLoading || isListingLoading ? (
            <Spinner />
          ) : (
            <p className="text-sm text-muted-foreground">
              {target?.kind === "path" ? (
                <Trans>This file path could not be resolved.</Trans>
              ) : (
                <Trans>This file is no longer available.</Trans>
              )}
            </p>
          )}
        </CenteredState>
      </div>
    );
  }

  const { recordCounts } = preview;

  const handleExportAsPdf = async (documentPath: string) => {
    if (isExportingPdf) {
      return;
    }
    setIsExportingPdf(true);
    try {
      await downloadPdf({
        url: getFilePathDownloadUrl(owner, documentPath, { format: "pdf" }),
        fileName: `${stripFileExtension(fileName)}.pdf`,
      });
    } finally {
      setIsExportingPdf(false);
    }
  };

  const FileIcon = getFileTypeIcon(contentType, fileName);

  return (
    <div className="flex h-panel min-h-0 flex-col">
      <ConversationSidePanelHeader
        onClose={closePanel}
        actions={
          <>
            {markdown.canEdit && !markdown.richEditor && (
              <>
                {markdown.collabViewMode !== "source" && (
                  <MarkdownFilePreviewViewModeSwitch
                    viewMode={markdown.viewMode}
                    onViewModeChange={markdown.setViewMode}
                  />
                )}
                {markdown.isDirty && (
                  <>
                    <Button
                      label={t`Save`}
                      variant="highlight"
                      size="xs"
                      isLoading={markdown.isSaving}
                      disabled={markdown.isSaving}
                      onClick={() => void markdown.save()}
                    />
                    <Button
                      label={t`Revert`}
                      variant="outline"
                      size="xs"
                      disabled={markdown.isSaving}
                      onClick={markdown.revert}
                    />
                  </>
                )}
              </>
            )}
            <div ref={setDocumentControls} className="flex empty:hidden" />
            {path &&
            preview.category === "markdown" &&
            hasFeature("co_edition") ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Download01}
                    tooltip={t({ message: "Download", context: "action" })}
                    isLoading={isExportingPdf}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    label={t`Markdown`}
                    href={getFilePathDownloadUrl(owner, path, {
                      format: "markdown",
                    })}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                  <DropdownMenuItem
                    label={t`Markdown with comments`}
                    href={urls.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                  <DropdownMenuItem
                    label={t`PDF`}
                    disabled={isExportingPdf}
                    onClick={() => void handleExportAsPdf(path)}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                icon={Download01}
                tooltip={t({ message: "Download", context: "action" })}
                href={urls.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
              />
            )}
            {!isMobile &&
              clientType !== "extension" &&
              (markdown.richEditor || markdown.collabViewMode === "source") && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={isFullScreen ? Minimize01 : Maximize01}
                  tooltip={
                    isFullScreen
                      ? t`Exit full screen mode`
                      : t`Go to full screen mode`
                  }
                  onClick={isFullScreen ? exitFullScreen : enterFullScreen}
                />
              )}
          </>
        }
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <CollabViewModeFileIcon
            visual={FileIcon}
            onCycleViewMode={markdown.cycleCollabViewMode}
          />
          <span className="min-w-16 truncate text-sm font-medium">
            {fileName}
          </span>
          {markdown.collabViewMode !== "live" && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {markdown.collabViewMode === "source"
                ? t({
                    message: "[source]",
                    context: "file view mode label beside the file name",
                  })
                : t({
                    message: "[read-only]",
                    context: "file view mode label beside the file name",
                  })}
            </span>
          )}
          <span ref={setDocumentStatus} className="flex empty:hidden" />
        </div>
      </ConversationSidePanelHeader>
      <div
        className={cn(
          "min-h-0 flex-1 bg-muted-background p-4",
          filePreviewLayoutClassName(preview.category)
        )}
      >
        {recordCounts && (
          <div className="pb-2 text-xs text-muted-foreground">
            {formatRecordCounts(recordCounts, t)}
          </div>
        )}
        <FilePreviewBody
          download={{ href: urls.downloadUrl }}
          entry={entry}
          fileUrl={urls.baseUrl}
          isFullWidth
          markdown={markdown}
          markdownHeaderControlsContainer={documentControls}
          markdownStatusContainer={documentStatus}
          markdownActiveComment={activeComment}
          owner={owner}
          preview={preview}
        />
      </div>
    </div>
  );
}

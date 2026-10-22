import { FilePreviewBody } from "@app/components/file_explorer/FilePreviewBody";
import { useFilePreviewContent } from "@app/components/file_explorer/FilePreviewContent";
import { MarkdownFilePreviewViewModeSwitch } from "@app/components/file_explorer/MarkdownFilePreview";
import type { FileEntry } from "@app/components/file_explorer/types";
import { useMarkdownFileEditor } from "@app/components/file_explorer/useMarkdownFileEditor";
import { MissingPodFileTabCallout } from "@app/components/pod/MissingPodFileTabCallout";
import {
  getFilePathDownloadUrl,
  getFilePathViewUrl,
  useFileMetadataFromPath,
} from "@app/lib/swr/files";
import { contentTypeFromFileName } from "@app/types/files";
import type { LightWorkspaceType } from "@app/types/user";
import { Button, cn, Spinner } from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";

interface PodFileTabPreviewProps {
  owner: LightWorkspaceType;
  filePath: string;
}

/**
 * Full-height preview for a non-frame Pod tab. Reuses the file preview stack so
 * markdown and other previewable files behave the same as in the side panel,
 * including the live editor when the path is writable.
 */
export function PodFileTabPreview({ owner, filePath }: PodFileTabPreviewProps) {
  const { t } = useLingui();
  const [documentControls, setDocumentControls] =
    useState<HTMLDivElement | null>(null);
  const [documentStatus, setDocumentStatus] = useState<HTMLSpanElement | null>(
    null
  );

  const { metadata, isFileMetadataLoading, isFileMetadataNotFound } =
    useFileMetadataFromPath({
      owner,
      filePath,
    });

  const fileName = filePath.split("/").pop() ?? filePath;
  const contentType =
    metadata?.contentType ??
    contentTypeFromFileName(fileName) ??
    "application/octet-stream";

  const entry: FileEntry | null = useMemo(() => {
    if (isFileMetadataNotFound) {
      return null;
    }
    return {
      kind: "file",
      isDirectory: false,
      fileName,
      path: filePath,
      contentType,
      fileId: metadata?.fileId ?? null,
      thumbnailUrl: null,
      sizeBytes: metadata?.sizeBytes ?? 0,
      lastModifiedMs: 0,
    };
  }, [
    contentType,
    fileName,
    filePath,
    isFileMetadataNotFound,
    metadata?.fileId,
    metadata?.sizeBytes,
  ]);

  const fileUrl = getFilePathViewUrl(owner, filePath);

  const preview = useFilePreviewContent({
    entry,
    fileUrl,
    enabled: !!entry,
  });

  const markdown = useMarkdownFileEditor({
    category: preview.category,
    entryPath: filePath,
    fileUrl,
    isActive: !!entry,
    isContentLoading: preview.isContentLoading,
    isTooLarge: preview.isTooLarge,
    isTruncated: preview.isTruncated,
    canWrite: preview.canWrite,
    owner,
    rawContent: preview.truncatedContent,
    processedContent: preview.processedContent,
  });

  if (isFileMetadataLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (isFileMetadataNotFound || !entry) {
    return <MissingPodFileTabCallout path={filePath} />;
  }

  const hasHeader = markdown.canEdit || !!markdown.richEditor;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden p-2">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl ring-1 ring-border/60">
        {hasHeader && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
            <div className="flex items-center gap-2">
              {markdown.canEdit &&
                !markdown.richEditor &&
                markdown.collabViewMode !== "source" && (
                  <MarkdownFilePreviewViewModeSwitch
                    key={entry.path}
                    viewMode={markdown.viewMode}
                    onViewModeChange={markdown.setViewMode}
                  />
                )}
              <span ref={setDocumentStatus} className="flex empty:hidden" />
            </div>
            <div className="flex items-center gap-2">
              {markdown.canEdit && !markdown.richEditor && (
                <>
                  <Button
                    label={t`Save`}
                    variant="highlight"
                    size="sm"
                    isLoading={markdown.isSaving}
                    disabled={!markdown.isDirty || markdown.isSaving}
                    onClick={() => void markdown.save()}
                  />
                  <Button
                    label={t`Revert`}
                    variant="outline"
                    size="sm"
                    disabled={!markdown.isDirty || markdown.isSaving}
                    onClick={markdown.revert}
                  />
                </>
              )}
              <div ref={setDocumentControls} className="flex empty:hidden" />
            </div>
          </div>
        )}
        <div
          className={cn(
            "min-h-0 flex-1 p-4",
            preview.category === "markdown"
              ? "flex flex-col overflow-hidden"
              : "overflow-y-auto"
          )}
        >
          <FilePreviewBody
            download={{ href: getFilePathDownloadUrl(owner, filePath) }}
            entry={entry}
            fileUrl={fileUrl}
            isFullWidth
            markdown={markdown}
            markdownHeaderControlsContainer={documentControls}
            markdownStatusContainer={documentStatus}
            onMarkdownViewModeChange={markdown.setViewMode}
            owner={owner}
            preview={preview}
          />
        </div>
      </div>
    </div>
  );
}

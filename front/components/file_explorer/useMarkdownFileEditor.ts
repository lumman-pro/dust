import { CUT_TEXT_SAVE_REFUSED } from "@app/components/file_explorer/FilePreviewContent";
import type { MarkdownFilePreviewViewMode } from "@app/components/file_explorer/MarkdownFilePreview";
import type { MarkdownRichEditor } from "@app/components/file_explorer/useRichMarkdownEditor";
import { useRichMarkdownEditor } from "@app/components/file_explorer/useRichMarkdownEditor";
import { useSendNotification } from "@app/hooks/useNotification";
import { formatError } from "@app/lib/api_error_messages";
import { useCollabUrl, useFeatureFlags } from "@app/lib/auth/AuthContext";
import { showDebugTools } from "@app/lib/development";
import type { ProcessedContent } from "@app/lib/file_content_utils";
import { writeFileContentByPath } from "@app/lib/swr/files";
import type { FilePreviewCategory } from "@app/types/file_preview";
import { parseCanonicalScopedPath } from "@app/types/mount_path";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import type { LightWorkspaceType } from "@app/types/user";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";

export type { MarkdownRichEditor } from "@app/components/file_explorer/useRichMarkdownEditor";

interface UseMarkdownFileEditorParams {
  category: FilePreviewCategory;
  entryPath: string | undefined;
  fileUrl: string | null;
  isActive: boolean;
  isContentLoading: boolean;
  isTooLarge: boolean;
  /** The preview text was cut; an editor fed with it would save a truncated file. */
  isTruncated: boolean;
  /** The mount accepts writes from this user; otherwise only the rich editor opens, read-only. */
  canWrite: boolean;
  owner: LightWorkspaceType | undefined;
  /** The file text as fetched, for the rich editor. The processed text is trimmed. */
  rawContent: string | null;
  processedContent: ProcessedContent | null;
}

export type CollabViewMode = "live" | "source" | "preview";

const NEXT_COLLAB_VIEW_MODE: Record<CollabViewMode, CollabViewMode> = {
  live: "source",
  source: "preview",
  preview: "live",
};

export interface MarkdownFileEditor {
  canEdit: boolean;
  collabViewMode: CollabViewMode;
  content: string | undefined;
  /** Unsaved edits in the plain editor. */
  isDirty: boolean;
  isSaving: boolean;
  revert: () => void;
  /**
   * Set when the file opens in the rich editor: every Markdown file behind the co_edition flag,
   * when a live session server is reachable.
   */
  richEditor: MarkdownRichEditor | null;
  save: () => Promise<void>;
  setDraft: (content: string) => void;
  setViewMode: (mode: MarkdownFilePreviewViewMode) => void;
  /**
   * Hidden switch cycling the rich editor, the source and the read-only preview; a no-op while an
   * edit is unsaved.
   */
  cycleCollabViewMode: () => void;
  viewMode: MarkdownFilePreviewViewMode;
}

/**
 * @cc [owner:tdraier,label:product] rich-editor-replaces-preview
 * With `co_edition` and a live session server, a Markdown file not too large to preview MUST open
 * in the rich editor rather than the plain preview, outside source mode and unless its text was cut
 * before the editor opened. It MUST be read-only when the user cannot write the file, and not live
 * and without its comments, whose signatures cannot be checked, when it has no canonical path.
 */
/**
 * @cc [owner:tdraier,label:product] collab-view-mode-cycle
 * `cycleCollabViewMode` MUST cycle `live` → `source` → `preview` → `live`. It MUST leave `live`
 * only when debug tools are shown (`showDebugTools`), from an open rich editor on a file the plain
 * editor can edit, and MUST NOT leave `source` while the plain editor holds an unsaved or saving
 * edit. In `source` the rich editor MUST NOT be open and the plain editor MUST stay in edit mode on
 * the file's text as fetched, unprocessed, savable even while a live session holds the file, unless
 * that session refuses outside writes (`collab-session-source-write`). In `preview` the rich editor
 * MUST be open read-only, still live. Leaving `source` MUST reopen the rich editor on the file as
 * fetched then, not on what it held before. The mode MUST go back to `live` when another file opens
 * or the preview closes.
 */
export function useMarkdownFileEditor({
  category,
  entryPath,
  fileUrl,
  isActive,
  isContentLoading,
  isTooLarge,
  isTruncated,
  canWrite,
  owner,
  rawContent,
  processedContent,
}: UseMarkdownFileEditorParams): MarkdownFileEditor {
  const [viewMode, setViewMode] =
    useState<MarkdownFilePreviewViewMode>("preview");
  const [draft, setDraft] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [collabViewMode, setCollabViewMode] = useState<CollabViewMode>("live");
  const [resetKey, setResetKey] = useState({ isActive, path: entryPath });
  const initKeyRef = useRef<string | null>(null);

  const { t } = useLingui();
  const sendNotification = useSendNotification();
  const { mutate } = useSWRConfig();
  const { featureFlags, hasFeature } = useFeatureFlags();
  const collabUrl = useCollabUrl();

  const editablePath =
    entryPath && owner && parseCanonicalScopedPath(entryPath)
      ? entryPath
      : null;
  const isPreviewableMarkdown = category === "markdown" && !isTooLarge;
  const canOpenEditor = isPreviewableMarkdown && !!editablePath && canWrite;

  if (isActive !== resetKey.isActive || entryPath !== resetKey.path) {
    setResetKey({ isActive, path: entryPath });
    setViewMode("preview");
    setCollabViewMode("live");
    setSourcePath(null);
    setDraft("");
    setSavedContent("");
    initKeyRef.current = null;
  }

  const isPlainDirty = draft !== savedContent;
  // Saving cut preview text would truncate the file. An open draft stays so it can be copied.
  const canEdit = canOpenEditor && (!isTruncated || isPlainDirty);
  const isSourceMode = collabViewMode === "source";
  const plainText = isSourceMode
    ? rawContent
    : (processedContent?.text ?? null);

  useEffect(() => {
    if (
      !isActive ||
      !canEdit ||
      !entryPath ||
      isContentLoading ||
      plainText === null
    ) {
      return;
    }

    const initKey = `${entryPath}:${plainText}`;
    if (initKeyRef.current === initKey) {
      return;
    }

    const hadInitializedForPath = initKeyRef.current?.startsWith(
      `${entryPath}:`
    );
    if (hadInitializedForPath && isPlainDirty) {
      return;
    }

    setSourcePath(entryPath);
    setDraft(plainText);
    setSavedContent(plainText);
    initKeyRef.current = initKey;
  }, [canEdit, entryPath, isActive, isContentLoading, isPlainDirty, plainText]);

  const writeFile = async (content: string): Promise<Result<void, string>> => {
    if (!owner || !editablePath) {
      return new Err(t`This file cannot be edited.`);
    }
    const result = await writeFileContentByPath({
      owner,
      canonicalPath: editablePath,
      content,
      contentType: "text/markdown",
    });
    return result.isOk()
      ? new Ok(undefined)
      : new Err(formatError(result.error).description);
  };

  /**
   * Makes written content the one the preview shows and the plain editor's saved baseline. The
   * plain draft is left alone: whatever was typed or undone during the save is still the draft.
   */
  const adoptWritten = async (content: string) => {
    await mutate(
      fileUrl,
      { kind: "loaded", content },
      {
        revalidate: false,
      }
    );
    setSavedContent(content);
    initKeyRef.current = `${entryPath}:${content}`;
  };

  const save = async () => {
    if (!isPlainDirty || isSaving) {
      return;
    }
    if (isTruncated) {
      sendNotification({
        type: "error",
        title: t(CUT_TEXT_SAVE_REFUSED.title),
        description: t(CUT_TEXT_SAVE_REFUSED.description),
      });
      return;
    }
    setIsSaving(true);
    try {
      const result = await writeFile(draft);
      if (result.isOk()) {
        await adoptWritten(draft);
        sendNotification({ type: "success", title: t`File saved` });
      } else {
        // we loose the error details here because we want to be iso between the rich and plain editor
        sendNotification({
          type: "error",
          title: t`Failed to save file`,
          description: result.error,
        });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const rich = useRichMarkdownEditor({
    // Not `canEdit`: an open rich editor must not unmount when the file grows past the cut.
    enabled: hasFeature("co_edition") && isPreviewableMarkdown && !isSourceMode,
    collabUrl: collabUrl,
    fileKey: fileUrl ?? undefined,
    livePath: editablePath,
    // Each switch to or from the source resets the rich editor, so it reopens on the file rather
    // than its old content.
    isActive: isActive && !isSourceMode,
    rawContent,
    isTruncated,
    readOnly: !canOpenEditor || collabViewMode === "preview",
  });

  const cycleCollabViewMode = () => {
    if (isPlainDirty || isSaving) {
      return;
    }
    if (
      collabViewMode === "live" &&
      (!showDebugTools(featureFlags) || !rich.richEditor || !canEdit)
    ) {
      return;
    }
    setCollabViewMode(NEXT_COLLAB_VIEW_MODE[collabViewMode]);
  };

  return {
    canEdit,
    collabViewMode,
    content:
      canEdit && sourcePath === entryPath ? draft : (plainText ?? undefined),
    isDirty: isPlainDirty,
    isSaving,
    revert: () => setDraft(savedContent),
    richEditor: rich.richEditor,
    save,
    setDraft,
    setViewMode,
    cycleCollabViewMode,
    viewMode: canEdit ? (isSourceMode ? "edit" : viewMode) : "preview",
  };
}

import { parseDfmWithAnchors, serializeDfm } from "@app/lib/markdown/dfm";
import { useState } from "react";

/** The rich Document editor takes over the file; the host hides its own edit controls. */
export interface MarkdownRichEditor {
  /** Changes when the editor must reopen on new content; use it as the component key. */
  mountKey: string;
  /** Scoped path of the file, edited live; null for a file without one, shown read-only. */
  path: string | null;
  /** The live session server the document is edited in. */
  collabUrl: string;
  initialContent: string;
  readOnly: boolean;
}

interface UseRichMarkdownEditorParams {
  /** The rich editor is wanted for this file: the flag is on and the file is Markdown. */
  enabled: boolean;
  /** The live session server, when one is reachable; without one, the rich editor does not open. */
  collabUrl: string | undefined;
  /** Identifies the file shown: another one reopens the editor. */
  fileKey: string | undefined;
  /**
   * Scoped path of the file, to open it live; without one, the file shows read-only and without
   * its comments, whose signatures name the path.
   */
  livePath: string | null;
  isActive: boolean;
  /** The file text as fetched, or null while it loads. */
  rawContent: string | null;
  /** The fetched text was cut; the plain editor keeps such a file. */
  isTruncated: boolean;
  /** The user cannot write the file: the editor shows it read-only, still live. */
  readOnly: boolean;
}

export interface RichMarkdownEditorState {
  richEditor: MarkdownRichEditor | null;
}

/** What the editor opened on. Latched: later fetches do not rewrite it. */
interface Opened {
  content: string;
  /** The live session server at that moment: the editor never moves under the user. */
  collabUrl: string;
}

/** `source` without its comment threads and anchors; a file the codec cannot read as it is. */
const withoutComments = (source: string): string => {
  const parsed = parseDfmWithAnchors(source);
  if (parsed.isErr()) {
    return source;
  }
  const { document, anchors } = parsed.value;
  const serialized = serializeDfm({
    frontMatter: document.frontMatter,
    body: anchors.text,
    comments: [],
  });
  return serialized.isOk() ? serialized.value : anchors.text;
};

/**
 * Which content the rich editor is open on. It opens on the file as fetched, in the live session
 * reachable then, and never reopens on later fetches: the session holds the document.
 */
/**
 * @cc [owner:PopDaph,label:product] collab-mode-latched
 * The rich editor MUST open only with a live session server, and an open editor MUST keep the one
 * it opened with until the file is reopened: `collabUrl` changing or disappearing MUST NOT move it.
 */
export function useRichMarkdownEditor({
  enabled,
  collabUrl,
  fileKey,
  livePath,
  isActive,
  rawContent,
  isTruncated,
  readOnly,
}: UseRichMarkdownEditorParams): RichMarkdownEditorState {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [resetKey, setResetKey] = useState({ isActive, fileKey });

  if (isActive !== resetKey.isActive || fileKey !== resetKey.fileKey) {
    setResetKey({ isActive, fileKey });
    setOpened(null);
  }

  const opens = enabled && (opened !== null || !isTruncated);
  // Latched while rendering, not in an effect, so the editor shows in the same commit.
  if (opens && opened === null && rawContent !== null && collabUrl) {
    setOpened({
      content: livePath === null ? withoutComments(rawContent) : rawContent,
      collabUrl,
    });
  }

  return {
    richEditor:
      opens && opened && fileKey !== undefined
        ? {
            mountKey: fileKey,
            path: livePath,
            collabUrl: opened.collabUrl,
            initialContent: opened.content,
            readOnly: readOnly || livePath === null,
          }
        : null,
  };
}

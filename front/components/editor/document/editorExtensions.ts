import { parseMarkdownBlocks } from "@app/components/editor/document/content";
import type { DocumentImageOptions } from "@app/components/editor/document/DocumentImage";
import { DocumentLinks } from "@app/components/editor/document/DocumentLinks";
import { DocumentListJoin } from "@app/components/editor/document/DocumentListJoin";
import { DocumentTaskBadges } from "@app/components/editor/document/DocumentTaskBadges";
import { buildSchemaExtensions } from "@app/components/editor/document/extensions";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { AnyExtension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";

export type Translate = (descriptor: MessageDescriptor) => string;

/**
 * The editor's extensions. A live document drops StarterKit's undo history for the
 * collaboration one, and protects comment marks whose thread its editor does not hold.
 */
export const buildDocumentEditorExtensions = (
  t: Translate,
  {
    live = false,
    resolveImageSource,
  }: {
    live?: boolean;
    resolveImageSource: DocumentImageOptions["resolveSource"];
  }
): AnyExtension[] => [
  ...buildSchemaExtensions({
    live,
    resolveImageSource,
    parsePastedMarkdown: parseMarkdownBlocks,
  }),
  DocumentListJoin,
  DocumentLinks,
  DocumentTaskBadges.configure({
    emptyTaskLabel: t(
      msg({
        message: "Task",
        context: "name of a task's checkbox when the task has no text",
      })
    ),
  }),
  Placeholder.configure({
    placeholder: ({ node, pos, editor }) =>
      node.type.name === "heading"
        ? pos === 0
          ? t(msg`Untitled`)
          : t(msg`Heading`)
        : node.type.name === "paragraph"
          ? editor.isEmpty
            ? t(msg`Start writing, or type / for elements…`)
            : t(msg`Type / for elements…`)
          : "",
  }),
];

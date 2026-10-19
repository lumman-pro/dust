import { DocumentAnchors } from "@app/components/editor/document/DocumentAnchors";
import { DocumentCommentAnchor } from "@app/components/editor/document/DocumentCommentAnchor";
import {
  COMMENT_MARK_NAME,
  DocumentCommentMark,
  DocumentComments,
} from "@app/components/editor/document/DocumentComments";
import { DocumentFilePreview } from "@app/components/editor/document/DocumentFilePreview";
import { DocumentFrame } from "@app/components/editor/document/DocumentFrame";
import type { DocumentImageOptions } from "@app/components/editor/document/DocumentImage";
import { DocumentImage } from "@app/components/editor/document/DocumentImage";
import { DocumentListItem } from "@app/components/editor/document/DocumentListItem";
import type { DocumentOrderedListOptions } from "@app/components/editor/document/DocumentOrderedList";
import { DocumentOrderedList } from "@app/components/editor/document/DocumentOrderedList";
import {
  DocumentTable,
  DocumentTableCell,
  DocumentTableRow,
} from "@app/components/editor/document/DocumentTable";
import { createDocumentMarked } from "@app/components/editor/document/marked_instance";
import { cn } from "@dust-tt/sparkle";
import type { AnyExtension } from "@tiptap/core";
import { Code } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Markdown } from "@tiptap/markdown";
import type { StarterKitOptions } from "@tiptap/starter-kit";
import { StarterKit } from "@tiptap/starter-kit";

/**
 * @cc [owner:tdraier,label:product] document-link-click
 * In an editable document, clicking a link MUST NOT open it, so its text can be clicked and
 * selected like any other text.
 */
const starterKitOptions: Partial<StarterKitOptions> = {
  heading: {
    HTMLAttributes: {
      class: cn(
        "text-pretty font-semibold tracking-tight",
        "[&:is(h1)]:heading-3xl [&:is(h1)]:mt-9 [&:is(h1)]:mb-3",
        "[&:is(h2)]:heading-2xl [&:is(h2)]:mt-8 [&:is(h2)]:mb-3",
        "[&:is(h3)]:heading-xl [&:is(h3)]:mt-7 [&:is(h3)]:mb-2"
      ),
    },
  },
  paragraph: { HTMLAttributes: { class: "my-2.5" } },
  bold: { HTMLAttributes: { class: "font-semibold" } },
  bulletList: { HTMLAttributes: { class: "my-3 list-disc pl-6" } },
  orderedList: false,
  listItem: false,
  blockquote: {
    HTMLAttributes: {
      class:
        "my-6 border-l-2 border-foreground/30 px-4 py-0.5 text-foreground/85 [&>p]:my-1",
    },
  },
  codeBlock: false,
  code: false,
  link: {
    openOnClick: false,
    HTMLAttributes: {
      rel: "noopener noreferrer",
      class:
        "underline decoration-foreground/35 underline-offset-4 transition-colors hover:decoration-current motion-reduce:transition-none",
    },
  },
  horizontalRule: {
    HTMLAttributes: { class: "my-8 border-0 border-t border-border" },
  },
};

/**
 * @cc [owner:avervaet,label:product] document-code-marks
 * Inline code MUST accept the bold, italic, strike and link marks Markdown can wrap it in, and
 * MUST exclude the comment mark, since an anchor written inside a code span reads back as code.
 */
const DocumentCode = Code.extend({ excludes: COMMENT_MARK_NAME });

// A line of at least as many backticks as the fence, indented by up to three spaces, closes it.
const CLOSING_FENCE_CANDIDATE = /^ {0,3}(`{3,})/gm;

/** The shortest backtick fence that the code it wraps cannot close. */
const backtickFenceFor = (code: string) => {
  const longestRun = Math.max(
    2,
    ...Array.from(
      code.matchAll(CLOSING_FENCE_CANDIDATE),
      ([, run]) => run.length
    )
  );
  return "`".repeat(longestRun + 1);
};

/**
 * @cc [owner:avervaet,label:product] document-code-block-fences
 * Every code block marked reads MUST open with its code, whatever its fence. A save MUST fence it
 * with backticks, longer than any backtick line in the code, so it reads back the same.
 */
const DocumentCodeBlock = CodeBlock.extend({
  parseMarkdown: (token, helpers) =>
    helpers.createNode(
      "codeBlock",
      { language: token.lang || null },
      token.text ? [helpers.createTextNode(token.text)] : []
    ),
  renderMarkdown: (node, helpers) => {
    const language = node.attrs?.language || "";
    const code = node.content ? helpers.renderChildren(node.content) : "";
    const fence = backtickFenceFor(code);
    return `${fence}${language}\n${code}\n${fence}`;
  },
});

// TipTap builds each editor's parser from the extension's options, which every editor built from
// the same extensions shares: setting the instance right before it does gives each its own.
const DocumentMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.options.marked = createDocumentMarked();
    this.parent?.(event);
  },
});

/** The schema; a live document protects comment marks without a thread and drops StarterKit's undo. */
export const buildSchemaExtensions = ({
  live,
  resolveImageSource,
  parsePastedMarkdown = null,
}: {
  live: boolean;
  resolveImageSource?: DocumentImageOptions["resolveSource"];
  parsePastedMarkdown?: DocumentOrderedListOptions["parsePastedMarkdown"];
}): AnyExtension[] => [
  DocumentAnchors,
  DocumentComments,
  live
    ? DocumentCommentMark.configure({ holdsThreads: false })
    : DocumentCommentMark,
  DocumentCommentAnchor,
  resolveImageSource
    ? DocumentImage.configure({ resolveSource: resolveImageSource })
    : DocumentImage,
  DocumentFrame,
  DocumentFilePreview,
  StarterKit.configure(
    live ? { ...starterKitOptions, undoRedo: false } : starterKitOptions
  ),
  DocumentCode.configure({
    // Mirrors the Markdown preview's inline code style, spelled out because the collab server
    // bundles this file and cannot pull in the design system's rendering dependencies.
    HTMLAttributes: {
      class:
        "mx-0.5 my-0.5 cursor-text rounded-md border border-border bg-muted/70 px-0.5 py-0 text-[0.90em] text-info-700",
    },
  }),
  DocumentOrderedList.configure({
    HTMLAttributes: { class: "my-3 list-decimal pl-6" },
    parsePastedMarkdown,
  }),
  DocumentListItem.configure({
    HTMLAttributes: {
      class:
        "pl-1 marker:text-muted-foreground marker:tabular-nums [&>p]:my-1 [&>ul]:my-1 [&>ol]:my-1",
    },
  }),
  DocumentCodeBlock.configure({
    HTMLAttributes: {
      class:
        "my-6 overflow-x-auto whitespace-pre rounded-xl border border-border bg-muted-background px-5 py-4 font-mono text-sm leading-relaxed [tab-size:2] [&>code]:font-mono",
    },
  }),
  DocumentTable.configure({
    HTMLAttributes: {
      class: "my-6 w-full table-fixed border-collapse text-sm",
    },
  }),
  DocumentTableRow,
  DocumentTableCell.configure({
    HTMLAttributes: {
      class: "border border-border px-3 py-1.5 align-top [&>p]:my-0",
    },
  }),
  DocumentMarkdown,
];

export const documentExtensions = buildSchemaExtensions({ live: false });

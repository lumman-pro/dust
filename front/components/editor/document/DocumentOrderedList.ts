import { isNumber } from "@app/types/shared/utils/general";
import type { JSONContent } from "@tiptap/core";
import type { OrderedListOptions } from "@tiptap/extension-list";
import { OrderedList } from "@tiptap/extension-list";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export type DocumentOrderedListOptions = OrderedListOptions & {
  /** The blocks of pasted Markdown as a file opens them, or null when a file would not open. */
  parsePastedMarkdown: ((markdown: string) => JSONContent[] | null) | null;
};

const isOrderedListMarkdown = (tokens: { type: string; ordered?: boolean }[]) =>
  tokens.some((token) => token.type === "list") &&
  tokens.every(
    (token) =>
      token.type === "space" || (token.type === "list" && token.ordered)
  );

/**
 * @cc [owner:rfrenoy,label:product] document-ordered-list-gfm
 * Numbered lists MUST be read by marked's GFM list parser, their items through the list item's
 * handler, so a numbered task list reads as one. Lists numbered with letters or Roman numerals
 * are not GFM: their Markdown MUST read as text, and a list pasted with them MUST be
 * numbered with decimals. A numbered list pasted as text MUST be read by `parsePastedMarkdown`,
 * and pasted as plain text when it refuses it or is not given.
 */
/**
 * @cc [owner:rfrenoy,label:product] document-ordered-list-after-empty-paragraph
 * A numbered list not starting at 1 that directly follows an empty paragraph in a list item MUST
 * be written after a blank line, so it reads back as a list instead of that paragraph's text.
 */
export const DocumentOrderedList =
  OrderedList.extend<DocumentOrderedListOptions>({
    addOptions() {
      return {
        ...OrderedList.options,
        parsePastedMarkdown: null,
      };
    },

    // A tokenizer that never matches leaves numbered lists to marked's own list tokenizer.
    markdownTokenizer: {
      name: "orderedList",
      level: "block",
      start: () => -1,
      tokenize: () => undefined,
    },

    parseMarkdown: (token, helpers) => {
      if (token.type !== "list" || !token.ordered) {
        return [];
      }
      const start = isNumber(token.start) ? token.start : 1;
      return {
        type: "orderedList",
        ...(start !== 1 ? { attrs: { start } } : {}),
        content: token.items ? helpers.parseChildren(token.items) : [],
      };
    },

    renderMarkdown(node, h, context) {
      const markdown = this.parent?.(node, h, context) ?? "";
      const previous = context.previousNode;
      const start = node.attrs?.start;
      return context.parentType === "listItem" &&
        previous?.type === "paragraph" &&
        !previous.content?.length &&
        isNumber(start) &&
        start !== 1
        ? `\n${markdown}`
        : markdown;
    },

    addAttributes() {
      return {
        ...this.parent?.(),
        type: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      };
    },

    // Replaces TipTap's plain-text paste, which keeps letters and Roman numerals, with the document's
    // own Markdown reading.
    addProseMirrorPlugins() {
      const { parsePastedMarkdown } = this.options;
      if (!parsePastedMarkdown) {
        return [];
      }
      return [
        new Plugin({
          key: new PluginKey("documentOrderedListPaste"),
          props: {
            handlePaste: (_view, event) => {
              const markdown = this.editor.markdown;
              const text = event.clipboardData?.getData("text/plain");
              if (
                !markdown ||
                !text ||
                event.clipboardData?.getData("text/html").trim() ||
                !isOrderedListMarkdown(markdown.instance.lexer(text))
              ) {
                return false;
              }
              const content = parsePastedMarkdown(text);
              return (
                content !== null && this.editor.commands.insertContent(content)
              );
            },
          },
        }),
      ];
    },
  });

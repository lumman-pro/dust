import { isEmptyParagraphMarker } from "@app/components/editor/document/DocumentParagraph";
import { isNumber } from "@app/types/shared/utils/general";
import type { JSONContent, MarkdownToken, RenderContext } from "@tiptap/core";
import { renderNestedMarkdownContent } from "@tiptap/core";
import { ListItem } from "@tiptap/extension-list";

const listMarker = (context: RenderContext) => {
  if (context.parentType !== "orderedList") {
    return "- ";
  }
  const start = context.meta?.parentAttrs?.start;
  return `${(isNumber(start) ? start : 1) + context.index}. `;
};

const opensWithEmptyParagraphMarker = (token: MarkdownToken) => {
  const [first] = token.tokens ?? [];
  return (
    (first?.type === "text" || first?.type === "paragraph") &&
    isEmptyParagraphMarker(first.raw?.replace(/\n+$/, ""))
  );
};

const isMarkerParagraph = (node: JSONContent | undefined) => {
  const [text, ...rest] = node?.content ?? [];
  return (
    node?.type === "paragraph" &&
    rest.length === 0 &&
    text?.type === "text" &&
    isEmptyParagraphMarker(text.text) &&
    !text.marks?.length
  );
};

/** StarterKit's list item, a numbered one counted from its list's `start`, 0 included. */
/**
 * @cc [owner:rfrenoy,label:product] document-empty-list-item
 * An item whose first paragraph consists only of `&nbsp;` or a non-breaking space MUST read with
 * an empty first paragraph, as TipTap's paragraph reads one. Any other text, the marker escaped
 * included, MUST read as text.
 */
export const DocumentListItem = ListItem.extend({
  parseMarkdown(token, helpers) {
    const parsed = this.parent?.(token, helpers) ?? [];
    if (
      Array.isArray(parsed) ||
      "mark" in parsed ||
      !opensWithEmptyParagraphMarker(token)
    ) {
      return parsed;
    }
    const [first, ...rest] = parsed.content ?? [];
    return isMarkerParagraph(first)
      ? { ...parsed, content: [{ type: "paragraph" }, ...rest] }
      : parsed;
  },

  renderMarkdown(node, h, context) {
    return renderNestedMarkdownContent(node, h, listMarker(context), context, {
      alignNestedToPrefix: context.parentType === "orderedList",
    });
  },
});

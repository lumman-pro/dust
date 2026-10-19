import { isString } from "@app/types/shared/utils/general";
import { Paragraph } from "@tiptap/extension-paragraph";

/** TipTap's Markdown for an empty paragraph that blank lines would not keep. */
export const EMPTY_PARAGRAPH_MARKDOWN = "&nbsp;";

const NON_BREAKING_SPACE = "\u00a0";

const MARKER_PARENT_TYPES = new Set(["listItem", "blockquote"]);

/** Whether text read as a whole paragraph is the empty paragraph marker, as TipTap reads it. */
export const isEmptyParagraphMarker = (text: string | undefined) =>
  text === EMPTY_PARAGRAPH_MARKDOWN || text === NON_BREAKING_SPACE;

/**
 * @cc [owner:rfrenoy,label:product] document-empty-paragraph
 * An empty paragraph in a list item or a quote MUST be written as `&nbsp;`, which reads back as an
 * empty paragraph. Anywhere else it MUST be written as TipTap's paragraph writes it.
 */
export const DocumentParagraph = Paragraph.extend({
  renderMarkdown(node, h, context) {
    if (
      !node.content?.length &&
      isString(context.parentType) &&
      MARKER_PARENT_TYPES.has(context.parentType)
    ) {
      return EMPTY_PARAGRAPH_MARKDOWN;
    }
    return this.parent?.(node, h, context) ?? "";
  },
});

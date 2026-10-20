import {
  isEmptyParagraphMarker,
  KEEPS_EMPTY_ATTR,
} from "@app/components/editor/document/DocumentParagraph";
import { isNumber } from "@app/types/shared/utils/general";
import type { JSONContent, MarkdownToken, RenderContext } from "@tiptap/core";
import { renderNestedMarkdownContent } from "@tiptap/core";
import { ListItem } from "@tiptap/extension-list";

export const LIST_ITEM_NODE_NAME = "listItem";

const isCheckbox = (token: MarkdownToken) => token.type === "checkbox";

/**
 * A task item's tokens without its checkbox, which marked puts either first in the item or first
 * in the item's first paragraph or text.
 */
export const taskItemTokens = (token: MarkdownToken): MarkdownToken[] => {
  const [first, ...rest] = token.tokens ?? [];
  if (!token.task || !first) {
    return token.tokens ?? [];
  }
  if (isCheckbox(first)) {
    return rest;
  }
  return first.tokens?.some(isCheckbox)
    ? [
        { ...first, tokens: first.tokens.filter((t) => !isCheckbox(t)) },
        ...rest,
      ]
    : (token.tokens ?? []);
};

/** GFM reads a task marker only when text follows it on its line. */
export const isWritableTask = (node: JSONContent) =>
  node.attrs?.task === true && (node.content?.[0]?.content?.length ?? 0) > 0;

const taskMarker = (node: JSONContent) =>
  isWritableTask(node) ? (node.attrs?.checked ? "[x] " : "[ ] ") : "";

const ALTERNATE_MARKER_ATTR = "alternateMarker";

const isList = (node: JSONContent | undefined) =>
  node?.type === "bulletList" || node?.type === "orderedList";

const listMarker = (context: RenderContext) => {
  const alternate = context.meta?.parentAttrs?.[ALTERNATE_MARKER_ATTR] === true;
  if (context.parentType !== "orderedList") {
    return alternate ? "* " : "- ";
  }
  const start = context.meta?.parentAttrs?.start;
  return `${(isNumber(start) ? start : 1) + context.index}${alternate ? ")" : "."} `;
};

const isEmptyParagraph = (node: JSONContent | undefined) =>
  node?.type === "paragraph" && !node.content?.length;

const withAttr = (node: JSONContent, name: string): JSONContent => ({
  ...node,
  attrs: { ...node.attrs, [name]: true },
});

/**
 * @cc [owner:rfrenoy,label:product] document-adjacent-lists
 * Lists of the same type MUST be written so each reads back as its own list: a list directly after
 * one of its type with the other marker of its kind, `*` for `-` and `)` for `.`, alternating along
 * a run of such lists, and a single empty paragraph between two of them as `&nbsp;`. Every other
 * list MUST be written with `-` or `.`.
 */
export const withSeparatedLists = (node: JSONContent): JSONContent => {
  const children = node.content;
  if (!children) {
    return node;
  }
  let alternate = false;
  const content = children.map((child, index) => {
    const previous = children[index - 1];
    const next = children[index + 1];
    alternate = isList(child) && previous?.type === child.type && !alternate;
    const written = withSeparatedLists(child);
    if (alternate) {
      return withAttr(written, ALTERNATE_MARKER_ATTR);
    }
    return isEmptyParagraph(child) &&
      isList(previous) &&
      previous?.type === next?.type
      ? withAttr(written, KEEPS_EMPTY_ATTR)
      : written;
  });
  return { ...node, content };
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

/**
 * StarterKit's list item, which is a task when `task` is set, done when `checked` also is. A
 * task item is written `- [ ] ` or `1. [x] `, its content aligned with the list marker, and an
 * empty one as an empty item.
 */
/**
 * @cc [owner:rfrenoy,label:product] document-empty-list-item
 * An item whose first paragraph consists only of `&nbsp;` or a non-breaking space MUST read with
 * an empty first paragraph, as TipTap's paragraph reads one. Any other text, the marker escaped
 * included, MUST read as text.
 */
export const DocumentListItem = ListItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      task: {
        default: false,
        keepOnSplit: true,
        renderHTML: ({ task }) => (task ? { "data-task": "true" } : {}),
      },
      checked: {
        default: false,
        keepOnSplit: false,
        renderHTML: ({ task, checked }) =>
          task && checked ? { "data-checked": "true" } : {},
      },
    };
  },

  parseMarkdown(token, helpers) {
    const itemToken = { ...token, tokens: taskItemTokens(token) };
    const parsed = this.parent?.(itemToken, helpers) ?? [];
    if (Array.isArray(parsed) || "mark" in parsed) {
      return parsed;
    }
    const [first, ...others] = parsed.content ?? [];
    const item =
      opensWithEmptyParagraphMarker(itemToken) && isMarkerParagraph(first)
        ? { ...parsed, content: [{ type: "paragraph" }, ...others] }
        : parsed;
    return token.task
      ? {
          ...item,
          attrs: { ...item.attrs, task: true, checked: token.checked === true },
        }
      : item;
  },

  // The task marker follows the list marker, which alone sets where nested content aligns.
  renderMarkdown(node, h, context) {
    const prefix = listMarker(context);
    const rendered = renderNestedMarkdownContent(node, h, prefix, context, {
      alignNestedToPrefix: context.parentType === "orderedList",
    });
    return `${prefix}${taskMarker(node)}${rendered.slice(prefix.length)}`;
  },
});

import { documentSchema } from "@app/components/editor/document/content";
import { getCommentAnchor } from "@app/components/editor/document/liveCommentAnchor";
import type { CommentAnchor } from "@app/types/collab";
import { BODY_FRAGMENT_NAME } from "@app/types/collab";
import { initProseMirrorDoc } from "@tiptap/y-tiptap";
import type * as Y from "yjs";

/** The anchor a browser bound to `doc` sends for a comment on the first occurrence of `text`. */
export function commentAnchorOf(doc: Y.Doc, text: string): CommentAnchor {
  const fragment = doc.getXmlFragment(BODY_FRAGMENT_NAME);
  const { doc: body, mapping } = initProseMirrorDoc(fragment, documentSchema);
  let from: number | null = null;
  body.descendants((node, pos) => {
    const index = node.isText ? (node.text ?? "").indexOf(text) : -1;
    if (from === null && index >= 0) {
      from = pos + index;
    }
  });
  if (from === null) {
    throw new Error(`No "${text}" in the document.`);
  }
  const anchor = getCommentAnchor(fragment, mapping, {
    from,
    to: from + text.length,
  });
  if (!anchor) {
    throw new Error(`No anchor for "${text}".`);
  }
  return anchor;
}

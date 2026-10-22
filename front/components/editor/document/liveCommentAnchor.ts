import type { CommentRange } from "@app/components/editor/document/DocumentComments";
import { getMarkableRange } from "@app/components/editor/document/DocumentComments";
import type { CommentAnchor } from "@app/types/collab";
import type { EditorState } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  ProsemirrorBinding,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import type * as Y from "yjs";

/**
 * @cc [owner:tdraier,label:product] live-comment-anchor
 * `getCommentAnchor` MUST name, by Yjs relative positions in `type` (mapped by `mapping`), the
 * positions right after the first and last characters of `range`, each attached to its character
 * so text typed at the range's edges stays out of it, and null when either cannot be.
 * `getLiveCommentAnchor` MUST return that anchor for the characters between `from` and `to` a
 * comment mark can sit on, in the shared document `state` is bound to, and null when `state` is
 * bound to no shared document or no character in the range can take the mark.
 */
export function getCommentAnchor(
  type: Y.XmlFragment,
  mapping: ProsemirrorBinding["mapping"],
  range: CommentRange
): CommentAnchor | null {
  const at = (position: number): CommentAnchor["first"] | null => {
    // y-tiptap attaches a position to the character before it.
    const relative: Y.RelativePosition = absolutePositionToRelativePosition(
      position,
      type,
      mapping
    );
    if (!relative.item || relative.assoc !== -1) {
      return null;
    }
    return {
      item: { client: relative.item.client, clock: relative.item.clock },
      assoc: -1,
    };
  };
  const first = at(range.from + 1);
  const last = at(range.to);
  return first && last ? { first, last } : null;
}

export function getLiveCommentAnchor(
  state: EditorState,
  { from, to }: { from: number; to: number }
): CommentAnchor | null {
  const binding = ySyncPluginKey.getState(state)?.binding;
  const range = getMarkableRange(state.doc, from, to);
  if (!(binding instanceof ProsemirrorBinding) || !range) {
    return null;
  }
  return getCommentAnchor(binding.type, binding.mapping, range);
}

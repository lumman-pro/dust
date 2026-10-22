import { documentSchema } from "@app/components/editor/document/content";
import type { DfmEnvelope } from "@app/components/editor/document/dfm_persistence";
import {
  getUnsavableBodyReason,
  loadDfm,
  saveDfm,
  UNSAVABLE_BODY_MESSAGE,
} from "@app/components/editor/document/dfm_persistence";
import {
  getCommentedTexts,
  getDocumentJSONComments,
  markComment,
  withDocumentJSONComments,
  withoutDocumentJSONComments,
  withoutOrphanCommentMarks,
} from "@app/components/editor/document/DocumentComments";
import type { DfmComment } from "@app/lib/markdown/dfm";
import type { CommentAnchor, CommentRequestErrorCode } from "@app/types/collab";
import { BODY_FRAGMENT_NAME } from "@app/types/collab";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import type { LocalTransactionOrigin } from "@hocuspocus/server";
import type { JSONContent } from "@tiptap/core";
import {
  initProseMirrorDoc,
  prosemirrorJSONToYXmlFragment,
  relativePositionToAbsolutePosition,
  updateYFragment,
  yXmlFragmentToProsemirrorJSON,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { z } from "zod";

/** What the editor content does not carry: front matter and anchor order. */
export const ENVELOPE_MAP_NAME = "envelope";

const envelopeSchema = z.object({
  frontMatter: z.string().nullable(),
  anchorOrder: z.array(z.string()),
}) satisfies z.ZodType<DfmEnvelope>;

/** A file as the live session holds it: the shared document, and the threads kept beside it. */
export interface SessionContent {
  doc: Y.Doc;
  comments: DfmComment[];
}

/**
 * @cc [owner:PopDaph,label:product] co-edition-ydoc-round-trip
 * `yDocToDfm(dfmToYDoc(source))` MUST return what `saveDfm` returns for the same file loaded
 * with `loadDfm`, and `dfmToYDoc` MUST refuse a file `loadDfm` refuses, with the same reason.
 */
/**
 * @cc [owner:PopDaph,label:architecture;security] co-edition-threads-outside-ydoc
 * Comment threads MUST NOT be stored in the `Y.Doc`: they travel in `comments`, so a browser
 * update to the shared document can never write a thread or change its author.
 */
export function dfmToYDoc(source: string): Result<SessionContent, string> {
  const loaded = loadDfm(source);
  if (loaded.isErr()) {
    return loaded;
  }
  const { envelope, content } = loaded.value;

  const doc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(
    documentSchema,
    withoutDocumentJSONComments(content),
    doc.getXmlFragment(BODY_FRAGMENT_NAME)
  );
  const map = doc.getMap(ENVELOPE_MAP_NAME);
  map.set("frontMatter", envelope.frontMatter);
  map.set("anchorOrder", envelope.anchorOrder);
  return new Ok({ doc, comments: getDocumentJSONComments(content) });
}

/**
 * @cc [owner:tdraier,label:product;concurrency] co-edition-ydoc-replace
 * `replaceYDocContent` MUST change `doc` so that `yDocToDfm`, with the threads it returns, gives
 * what it gives for `dfmToYDoc(source)`, in one transaction with `origin`, leaving what is equal
 * in place so the people editing keep their cursors. It MUST refuse a file `loadDfm` refuses, with
 * the same reason, without changing `doc`.
 */
export function replaceYDocContent(
  doc: Y.Doc,
  source: string,
  origin: LocalTransactionOrigin
): Result<DfmComment[], string> {
  const loaded = loadDfm(source);
  if (loaded.isErr()) {
    return loaded;
  }
  const { envelope, content } = loaded.value;

  const body = documentSchema.nodeFromJSON(
    withoutDocumentJSONComments(content)
  );
  doc.transact(() => {
    updateYFragment(doc, doc.getXmlFragment(BODY_FRAGMENT_NAME), body, {
      mapping: new Map(),
      isOMark: new Map(),
    });
    // Setting an unchanged value would still send an update to every editor.
    const map = doc.getMap(ENVELOPE_MAP_NAME);
    if (map.get("frontMatter") !== envelope.frontMatter) {
      map.set("frontMatter", envelope.frontMatter);
    }
    if (
      JSON.stringify(map.get("anchorOrder")) !==
      JSON.stringify(envelope.anchorOrder)
    ) {
      map.set("anchorOrder", envelope.anchorOrder);
    }
  }, origin);
  return new Ok(getDocumentJSONComments(content));
}

/**
 * @cc [owner:tdraier,label:product] co-edition-orphan-anchors-dropped
 * `yDocToDfm` MUST write without the comment marks whose id has no thread in `comments`, so a
 * mark left without its thread, by an undo or a failed comment command, never blocks a save.
 */
export function yDocToDfm(session: SessionContent): Result<string, string> {
  const live = readLiveDocument(session);
  return live.isOk() ? saveDfm(live.value.envelope, live.value.content) : live;
}

/**
 * Why `yDocToDfm` refused the session's body with `failure`, without its text. Null when
 * `failure` is not about the body or the body writes.
 */
export function getYDocUnsavableBodyReason(
  session: SessionContent,
  failure: string
): string | null {
  if (failure !== UNSAVABLE_BODY_MESSAGE) {
    return null;
  }
  const live = readLiveDocument(session);
  return live.isOk()
    ? getUnsavableBodyReason(live.value.envelope, live.value.content)
    : null;
}

const readEnvelope = (doc: Y.Doc): DfmEnvelope | null => {
  const envelope = envelopeSchema.safeParse(
    doc.getMap(ENVELOPE_MAP_NAME).toJSON()
  );
  return envelope.success ? envelope.data : null;
};

const withSessionThreads = (
  content: JSONContent,
  comments: DfmComment[]
): JSONContent =>
  withDocumentJSONComments(
    withoutOrphanCommentMarks(content, new Set(comments.map(({ id }) => id))),
    comments
  );

const readLiveDocument = ({
  doc,
  comments,
}: SessionContent): Result<
  { envelope: DfmEnvelope; content: JSONContent },
  string
> => {
  const envelope = readEnvelope(doc);
  if (!envelope) {
    return new Err("The live document has no valid envelope.");
  }

  // A client can send structures the binding cannot read back.
  let content: JSONContent;
  try {
    content = yXmlFragmentToProsemirrorJSON(
      doc.getXmlFragment(BODY_FRAGMENT_NAME)
    );
  } catch {
    return new Err("The live document has an unreadable body.");
  }
  return new Ok({ envelope, content: withSessionThreads(content, comments) });
};

/**
 * @cc [owner:tdraier,label:product;security] co-edition-comment-anchored
 * `anchorYDocComment` MUST mark `commentId`, as the editor's `addComment` marks a draft, on the
 * text from the character `anchor.first` follows, or from where it was when it was deleted,
 * through the one `anchor.last` follows, in one transaction with `origin`, changing nothing else.
 * It MUST refuse without changing `doc`: as `unanchored` when either position resolves nowhere in
 * the body, that text is empty, or none of it can take the mark; as `unwritable` when
 * `yDocToDfm` would refuse the document with the mark and `comments`; as `unavailable` when the
 * body or envelope cannot be read.
 */
/**
 * @cc [owner:tdraier,label:coding] co-edition-comment-anchored-in-place
 * An exception to `no-parameter-mutation` limited to `doc`: `anchorYDocComment` MUST change the
 * live document it is handed in place, since its connections sync from that very instance, and
 * MUST NOT change `anchor` or `comments`.
 */
export function anchorYDocComment(
  doc: Y.Doc,
  {
    commentId,
    anchor,
    comments,
  }: { commentId: string; anchor: CommentAnchor; comments: DfmComment[] },
  origin: LocalTransactionOrigin
): Result<void, CommentRequestErrorCode> {
  const envelope = readEnvelope(doc);
  const fragment = doc.getXmlFragment(BODY_FRAGMENT_NAME);
  let body: ReturnType<typeof initProseMirrorDoc>;
  // A client can send structures the binding or the schema cannot read back.
  try {
    body = initProseMirrorDoc(fragment, documentSchema);
  } catch {
    return new Err("unavailable");
  }
  if (!envelope) {
    return new Err("unavailable");
  }

  const resolve = (position: CommentAnchor["first"]) =>
    relativePositionToAbsolutePosition(
      doc,
      fragment,
      Y.createRelativePositionFromJSON(position),
      body.mapping
    );
  const afterFirst = resolve(anchor.first);
  const to = resolve(anchor.last);
  if (afterFirst === null || to === null) {
    return new Err("unanchored");
  }
  // A deleted character's position resolves to where it was, so the text left starts there.
  const firstDeleted = Y.getItem(
    doc.store,
    Y.createID(anchor.first.item.client, anchor.first.item.clock)
  ).deleted;
  const from = firstDeleted ? afterFirst : afterFirst - 1;
  if (to <= from) {
    return new Err("unanchored");
  }
  const marked = markComment(body.doc, from, to, commentId);
  if (!marked) {
    return new Err("unanchored");
  }
  if (
    saveDfm(envelope, withSessionThreads(marked.doc.toJSON(), comments)).isErr()
  ) {
    return new Err("unwritable");
  }

  doc.transact(() => {
    updateYFragment(doc, fragment, marked.doc, body.meta);
  }, origin);
  return new Ok(undefined);
}

/**
 * @cc [owner:tdraier,label:product] co-edition-commented-texts
 * `yDocCommentedTexts` MUST return, for each comment marked in `doc`, the text `getCommentedTexts`
 * gives the editor for it, and nothing when the body cannot be read.
 */
export function yDocCommentedTexts(doc: Y.Doc): Map<string, string> {
  // A client can send structures the binding or the schema cannot read back.
  try {
    return getCommentedTexts(
      documentSchema.nodeFromJSON(
        yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(BODY_FRAGMENT_NAME))
      )
    );
  } catch {
    return new Map();
  }
}

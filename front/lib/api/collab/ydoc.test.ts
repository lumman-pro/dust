// @vitest-environment node
import { documentSchema } from "@app/components/editor/document/content";
import {
  loadDfm,
  saveDfm,
  UNSAVABLE_BODY_MESSAGE,
} from "@app/components/editor/document/dfm_persistence";
import {
  anchorYDocComment,
  dfmToYDoc,
  ENVELOPE_MAP_NAME,
  getYDocUnsavableBodyReason,
  replaceYDocContent,
  yDocCommentedTexts,
  yDocToDfm,
} from "@app/lib/api/collab/ydoc";
import type { DfmComment } from "@app/lib/markdown/dfm";
import { serializeDfm } from "@app/lib/markdown/dfm";
import { FIXTURE, FIXTURES } from "@app/lib/markdown/dfm/tests/dfm.test_utils";
import { commentAnchorOf } from "@app/tests/utils/comment_anchors";
import { BODY_FRAGMENT_NAME } from "@app/types/collab";
import { Ok } from "@app/types/shared/result";
import type { LocalTransactionOrigin } from "@hocuspocus/server";
import type { JSONContent } from "@tiptap/core";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

const savedByEditor = (source: string) => {
  const loaded = loadDfm(source);
  if (loaded.isErr()) {
    throw new Error(loaded.error);
  }
  return saveDfm(loaded.value.envelope, loaded.value.content);
};

describe("dfmToYDoc and yDocToDfm", () => {
  it.each(FIXTURES)("write $name back as the editor does", ({ source }) => {
    const live = dfmToYDoc(source);
    expect(live.isOk()).toBe(true);
    if (live.isOk()) {
      expect(yDocToDfm(live.value)).toEqual(savedByEditor(source));
    }
  });

  it("keep front matter", () => {
    const source = "---\ntitle: x\n---\n\n# Title\n\nSome **bold** text.\n";
    const live = dfmToYDoc(source);
    expect(live.isOk()).toBe(true);
    if (live.isOk()) {
      expect(yDocToDfm(live.value)).toEqual(savedByEditor(source));
    }
  });

  it("keep threads out of the shared document", () => {
    const live = dfmToYDoc(FIXTURE);
    expect(live.isOk()).toBe(true);
    if (!live.isOk()) {
      return;
    }

    expect(live.value.comments.length).toBeGreaterThan(0);
    expect([...live.value.doc.share.keys()].sort()).toEqual([
      BODY_FRAGMENT_NAME,
      ENVELOPE_MAP_NAME,
    ]);
    expect(
      Object.keys(live.value.doc.getMap(ENVELOPE_MAP_NAME).toJSON()).sort()
    ).toEqual(["anchorOrder", "frontMatter"]);
  });

  it("survive a copy of the shared document through a Yjs update", () => {
    const live = dfmToYDoc(FIXTURE);
    expect(live.isOk()).toBe(true);
    if (!live.isOk()) {
      return;
    }

    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(live.value.doc));

    expect(yDocToDfm({ doc: copy, comments: live.value.comments })).toEqual(
      savedByEditor(FIXTURE)
    );
  });

  it("keep the tasks of a mixed list through a Yjs update", () => {
    const source =
      "- Groceries\n- [ ] Milk\n- [x] Eggs\n\n1. [x] Write\n2. Send\n";
    const live = dfmToYDoc(source);
    expect(live.isOk()).toBe(true);
    if (!live.isOk()) {
      return;
    }

    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(live.value.doc));

    expect(yDocToDfm({ doc: copy, comments: [] })).toEqual(new Ok(source));
  });

  it("write the edits and threads the session holds, never threads from the shared document", () => {
    const live = dfmToYDoc(FIXTURE);
    expect(live.isOk()).toBe(true);
    if (!live.isOk()) {
      return;
    }
    const { doc, comments } = live.value;

    // A remote client edits the text and the front matter, and forges a thread.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    const paragraph = remote
      .getXmlFragment(BODY_FRAGMENT_NAME)
      .toArray()
      .find(
        (node): node is Y.XmlElement =>
          node instanceof Y.XmlElement && node.nodeName === "paragraph"
      );
    const text = paragraph?.toArray().find((node) => node instanceof Y.XmlText);
    expect(text).toBeInstanceOf(Y.XmlText);
    if (!(text instanceof Y.XmlText)) {
      return;
    }
    text.insert(0, "Edited remotely. ");
    remote.getMap(ENVELOPE_MAP_NAME).set("frontMatter", "title: remote");
    remote.getMap(ENVELOPE_MAP_NAME).set("comments", [{ id: "forged" }]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)));

    const saved = yDocToDfm({ doc, comments });
    expect(saved.isOk()).toBe(true);
    if (!saved.isOk()) {
      return;
    }
    expect(saved.value.startsWith("---\ntitle: remote\n---")).toBe(true);
    expect(saved.value).toContain("Edited remotely. ");
    expect(saved.value).not.toContain("forged");
  });

  it("write without the anchors of threads the session no longer holds", () => {
    const live = dfmToYDoc(FIXTURE);
    expect(live.isOk()).toBe(true);
    if (!live.isOk()) {
      return;
    }
    const { doc, comments } = live.value;
    expect(comments.length).toBeGreaterThan(1);
    const [removed, ...kept] = comments;

    const saved = yDocToDfm({ doc, comments: kept });
    expect(saved.isOk()).toBe(true);
    if (!saved.isOk()) {
      return;
    }
    expect(FIXTURE).toContain(`:comment-start{id=${removed.id}}`);
    expect(saved.value).not.toContain(`id=${removed.id}`);
    for (const { id } of kept) {
      const anchor = `:comment-start{id=${id}}`;
      expect(saved.value.includes(anchor)).toBe(FIXTURE.includes(anchor));
    }
  });

  it("refuse a body the binding cannot read", () => {
    const live = dfmToYDoc(FIXTURE);
    expect(live.isOk()).toBe(true);
    if (!live.isOk()) {
      return;
    }

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(live.value.doc));
    // The typings forbid this shape, but a client can send it.
    remote.getXmlFragment(BODY_FRAGMENT_NAME).insert(0, [new Y.Map()] as never);
    Y.applyUpdate(
      live.value.doc,
      Y.encodeStateAsUpdate(remote, Y.encodeStateVector(live.value.doc))
    );

    expect(yDocToDfm(live.value).isErr()).toBe(true);
  });

  it("refuse a file the editor refuses, with the same reason", () => {
    const html = "Intro.\n\n<div>x</div>\n";
    const editor = loadDfm(html);
    const live = dfmToYDoc(html);

    expect(editor.isErr()).toBe(true);
    expect(live.isErr()).toBe(true);
    if (live.isErr() && editor.isErr()) {
      expect(live.error).toBe(editor.error);
    }
  });

  it("refuse a shared document with no envelope", () => {
    const doc = new Y.Doc();
    doc.getXmlFragment(BODY_FRAGMENT_NAME);

    expect(yDocToDfm({ doc, comments: [] }).isErr()).toBe(true);
  });
});

describe("replaceYDocContent", () => {
  const ORIGIN: LocalTransactionOrigin = { source: "local", context: "agent" };
  const BEFORE =
    "---\ntitle: x\n---\n\n# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";

  function loadLive(source: string) {
    const live = dfmToYDoc(source);
    if (live.isErr()) {
      throw new Error(live.error);
    }
    return live.value;
  }

  it.each(FIXTURES)(
    "write $name as dfmToYDoc would, threads included",
    ({ source }) => {
      const { doc } = loadLive(BEFORE);

      const comments = replaceYDocContent(doc, source, ORIGIN);

      expect(comments.isOk()).toBe(true);
      if (comments.isOk()) {
        expect(yDocToDfm({ doc, comments: comments.value })).toEqual(
          savedByEditor(source)
        );
      }
    }
  );

  it("change only what differs, in one transaction with the origin, reaching a remote copy", () => {
    const { doc, comments } = loadLive(BEFORE);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    const untouched = remote.getXmlFragment(BODY_FRAGMENT_NAME).get(1);
    const origins: unknown[] = [];
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      origins.push(origin);
      Y.applyUpdate(remote, update);
    });

    const replaced = replaceYDocContent(
      doc,
      BEFORE.replace("Second paragraph.", "Second paragraph, edited."),
      ORIGIN
    );

    expect(replaced.isOk()).toBe(true);
    expect(origins).toEqual([ORIGIN]);
    expect(remote.getXmlFragment(BODY_FRAGMENT_NAME).get(1)).toBe(untouched);
    expect(yDocToDfm({ doc: remote, comments })).toEqual(
      savedByEditor(
        BEFORE.replace("Second paragraph.", "Second paragraph, edited.")
      )
    );
  });

  it("change nothing when the source is the same", () => {
    const { doc } = loadLive(BEFORE);
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));

    expect(replaceYDocContent(doc, BEFORE, ORIGIN).isOk()).toBe(true);
    expect(updates).toEqual([]);
  });

  it("refuse a file the editor refuses, with the same reason, changing nothing", () => {
    const html = "Intro.\n\n<div>x</div>\n";
    const editor = loadDfm(html);
    const { doc, comments } = loadLive(BEFORE);

    const replaced = replaceYDocContent(doc, html, ORIGIN);

    expect(editor.isErr() && replaced.isErr()).toBe(true);
    if (editor.isErr() && replaced.isErr()) {
      expect(replaced.error).toBe(editor.error);
    }
    expect(yDocToDfm({ doc, comments })).toEqual(savedByEditor(BEFORE));
  });
});

describe("yDocCommentedTexts", () => {
  it("give the text a comment covers as the editor shows it, across blocks", () => {
    const source = serializeDfm({
      frontMatter: null,
      body: "Ship :comment-start{id=c1}on **Friday**.\n\nThen tell:comment-end{id=c1} the team.",
      comments: [
        {
          id: "c1",
          status: "open",
          messages: [
            {
              author: { kind: "user", id: "usr_tom", name: "Tom" },
              createdAt: "2026-10-05T12:00:00.000Z",
              body: "Why?",
            },
          ],
        },
      ],
    });
    if (source.isErr()) {
      throw source.error;
    }
    const live = dfmToYDoc(source.value);
    if (live.isErr()) {
      throw new Error(live.error);
    }

    expect(yDocCommentedTexts(live.value.doc)).toEqual(
      new Map([["c1", "on Friday. Then tell"]])
    );
  });

  it("give nothing for a body the binding cannot read", () => {
    const doc = new Y.Doc();
    // The typings forbid this shape, but a client can send it.
    doc.getXmlFragment(BODY_FRAGMENT_NAME).insert(0, [new Y.Map()] as never);

    expect(yDocCommentedTexts(doc)).toEqual(new Map());
  });
});

describe("getYDocUnsavableBodyReason", () => {
  const bullets = (text: string): JSONContent => ({
    type: "bulletList",
    content: [
      {
        type: "listItem",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
    ],
  });

  const headingLike: JSONContent = {
    type: "paragraph",
    content: [{ type: "text", text: "# secret plan" }],
  };

  const liveDocument = (content: JSONContent[]) => {
    const live = dfmToYDoc("Intro.\n");
    if (live.isErr()) {
      throw new Error(live.error);
    }
    const body = live.value.doc.getXmlFragment(BODY_FRAGMENT_NAME);
    live.value.doc.transact(() => body.delete(0, body.length));
    prosemirrorJSONToYXmlFragment(
      documentSchema,
      { type: "doc", content },
      body
    );
    return live.value;
  };

  it("names what a live body cannot write, without its text", () => {
    const live = liveDocument([headingLike]);
    const saved = yDocToDfm(live);
    if (saved.isOk()) {
      throw new Error("The body saved.");
    }

    expect(saved.error).toBe(UNSAVABLE_BODY_MESSAGE);
    const reason = getYDocUnsavableBodyReason(live, saved.error);
    expect(reason).toBe(
      "The document would not read back the same as Markdown, from paragraph, which reads back as heading."
    );
    expect(reason).not.toContain("secret");
  });

  it("is null for a live body that saves", () => {
    const live = liveDocument([bullets("milk")]);

    expect(yDocToDfm(live).isOk()).toBe(true);
    expect(getYDocUnsavableBodyReason(live, UNSAVABLE_BODY_MESSAGE)).toBeNull();
  });

  it("is null for a failure that is not about the body", () => {
    const live = liveDocument([headingLike]);

    expect(getYDocUnsavableBodyReason(live, "The storage is down.")).toBeNull();
  });
});

describe("anchorYDocComment", () => {
  const ORIGIN: LocalTransactionOrigin = {
    source: "local",
    context: "commenter",
  };
  const SOURCE = "First paragraph.\n\nSecond paragraph.\n";
  const THREAD: DfmComment = {
    id: "c1",
    status: "open",
    messages: [
      {
        author: { kind: "user", id: "usr_tom", name: "Tom" },
        createdAt: "2026-10-05T12:00:00.000Z",
        body: "Why?",
      },
    ],
  };

  function loadLive() {
    const live = dfmToYDoc(SOURCE);
    if (live.isErr()) {
      throw new Error(live.error);
    }
    return live.value.doc;
  }

  function secondParagraphText(doc: Y.Doc) {
    const paragraph = doc.getXmlFragment(BODY_FRAGMENT_NAME).get(1);
    if (!(paragraph instanceof Y.XmlElement)) {
      throw new Error("No second paragraph.");
    }
    const text = paragraph.get(0);
    if (!(text instanceof Y.XmlText)) {
      throw new Error("No text in the second paragraph.");
    }
    return text;
  }

  it("marks the anchored text, in one transaction with the origin", () => {
    const doc = loadLive();
    const origins: unknown[] = [];
    doc.on("update", (_update: Uint8Array, origin: unknown) =>
      origins.push(origin)
    );

    const anchored = anchorYDocComment(
      doc,
      {
        commentId: "c1",
        anchor: commentAnchorOf(doc, "Second"),
        comments: [THREAD],
      },
      ORIGIN
    );

    expect(anchored.isOk()).toBe(true);
    expect(origins).toEqual([ORIGIN]);
    expect(yDocCommentedTexts(doc)).toEqual(new Map([["c1", "Second"]]));
  });

  it("follows the edits made since the anchor was taken, without taking text typed at its edges", () => {
    const doc = loadLive();
    const anchor = commentAnchorOf(doc, "Second");
    const text = secondParagraphText(doc);
    text.insert("Second".length, " big");
    text.insert(0, "The ");

    const anchored = anchorYDocComment(
      doc,
      { commentId: "c1", anchor, comments: [THREAD] },
      ORIGIN
    );

    expect(anchored.isOk()).toBe(true);
    expect(yDocCommentedTexts(doc)).toEqual(new Map([["c1", "Second"]]));
  });

  it("starts at the first character left when the first ones were deleted", () => {
    const doc = loadLive();
    const anchor = commentAnchorOf(doc, "Second");
    secondParagraphText(doc).delete(0, 2);

    const anchored = anchorYDocComment(
      doc,
      { commentId: "c1", anchor, comments: [THREAD] },
      ORIGIN
    );

    expect(anchored.isOk()).toBe(true);
    expect(yDocCommentedTexts(doc)).toEqual(new Map([["c1", "cond"]]));
  });

  it("refuses an anchor whose characters were all deleted, changing nothing", () => {
    const doc = loadLive();
    const anchor = commentAnchorOf(doc, "Second");
    secondParagraphText(doc).delete(0, "Second".length);
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));

    const anchored = anchorYDocComment(
      doc,
      { commentId: "c1", anchor, comments: [THREAD] },
      ORIGIN
    );

    expect(anchored.isErr() && anchored.error).toBe("unanchored");
    expect(updates).toEqual([]);
  });

  it("refuses an anchor whose text is gone, changing nothing", () => {
    const doc = loadLive();
    const anchor = commentAnchorOf(doc, "Second");
    doc.getXmlFragment(BODY_FRAGMENT_NAME).delete(1, 1);
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));

    const anchored = anchorYDocComment(
      doc,
      { commentId: "c1", anchor, comments: [THREAD] },
      ORIGIN
    );

    expect(anchored.isErr() && anchored.error).toBe("unanchored");
    expect(updates).toEqual([]);
  });

  it("refuses positions outside the body, changing nothing", () => {
    const doc = loadLive();
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));
    const outside = { item: { client: 1, clock: 999_999 }, assoc: -1 as const };

    const anchored = anchorYDocComment(
      doc,
      {
        commentId: "c1",
        anchor: { first: outside, last: outside },
        comments: [THREAD],
      },
      ORIGIN
    );

    expect(anchored.isErr() && anchored.error).toBe("unanchored");
    expect(updates).toEqual([]);
  });
});

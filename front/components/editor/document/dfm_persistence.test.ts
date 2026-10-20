// @vitest-environment node
import { documentSchema } from "@app/components/editor/document/content";
import {
  loadDfm,
  loggableRefusal,
  getUnsavableBodyReason,
  saveDfm,
  isWritableThread,
} from "@app/components/editor/document/dfm_persistence";
import {
  getDocumentJSONComments,
  withDocumentJSONComments,
} from "@app/components/editor/document/DocumentComments";
import type { DfmComment } from "@app/lib/markdown/dfm";
import { parseDfm } from "@app/lib/markdown/dfm";
import { FIXTURE, FIXTURES } from "@app/lib/markdown/dfm/tests/dfm.test_utils";
import { FILE_PREVIEW_NODE_TYPE } from "@app/lib/markdown/file_preview";
import type { Result } from "@app/types/shared/result";
import { Ok } from "@app/types/shared/result";
import type { JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Lexer } from "marked";
import { fromMarkdown } from "mdast-util-from-markdown";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("mdast-util-from-markdown", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("mdast-util-from-markdown")>();
  return { ...original, fromMarkdown: vi.fn(original.fromMarkdown) };
});

const AT = "2026-09-25T14:16:32.380Z";
const THREAD = `:::annotations\n::comment{id=c1 status=resolved}\n\n::message{author=user:usr_daph name="Daph" at=${AT}}\n\nKept as is.\n:::\n`;
const OPEN_THREAD = THREAD.replace("resolved", "open");

const COMMENT: DfmComment = {
  id: "c1",
  status: "open",
  messages: [
    {
      author: { kind: "user", id: "usr_daph", name: "Daph" },
      createdAt: AT,
      body: "Kept as is.",
    },
  ],
};

function load(source: string) {
  const loaded = loadDfm(source);
  if (loaded.isErr()) {
    throw new Error(loaded.error);
  }
  return loaded.value;
}

function roundTrip(source: string): string {
  const { envelope, content } = load(source);
  const saved = saveDfm(envelope, content);
  if (saved.isErr()) {
    throw new Error(saved.error);
  }
  return saved.value;
}

/** Comment ids on each text node, as `text[id,id]`. */
function markedTexts(document: JSONContent): string[] {
  const texts: string[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === "text") {
      const ids = (node.marks ?? [])
        .filter((mark) => mark.type === "comment")
        .map((mark) => mark.attrs?.id);
      texts.push(
        ids.length > 0 ? `${node.text}[${ids.join(",")}]` : `${node.text}`
      );
    }
    node.content?.forEach(visit);
  };
  visit(document);
  return texts;
}

/** Each text node with its marks, comment ids by id, as `text[mark,id]`. */
function formattedTexts(document: JSONContent): string[] {
  const texts: string[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === "text") {
      const marks = (node.marks ?? []).map((mark) =>
        mark.type === "comment" ? mark.attrs?.id : mark.type
      );
      texts.push(
        marks.length > 0 ? `${node.text}[${marks.join(",")}]` : `${node.text}`
      );
    }
    node.content?.forEach(visit);
  };
  visit(document);
  return texts;
}

// The live session server runs these functions in Node: see `document-model-runs-without-dom`.
it("runs without a DOM", () => {
  expect(typeof window).toBe("undefined");
  expect(typeof document).toBe("undefined");
});

describe("loadDfm", () => {
  it("opens a plain Markdown file", () => {
    const { envelope, content } = load("# Title\n\nSome **bold** text.\n");

    expect(envelope).toEqual({ frontMatter: null, anchorOrder: [] });
    expect(content.type).toBe("doc");
    expect(getDocumentJSONComments(content)).toEqual([]);
  });

  it.each([
    "French frontend ~done.",
    "5 * 3 = 15",
    "Call snake_case_name.",
    "Read array[0], see [note.",
    "Open path\\to\\file.",
    "Already escaped \\*b\\*.",
  ])("opens and saves text with characters Markdown escapes: %s", (source) => {
    const textOf = (markdown: string) =>
      load(markdown).content.content?.[0].content?.[0].text;

    // The serializer escapes them; the file must still open, and keep its text once saved.
    expect(textOf(roundTrip(source))).toBe(textOf(source));
  });

  it("keeps real formatting next to escaped characters", () => {
    const source = "~~Gone~~, **bold** and 5 \\* 3.\n";

    expect(roundTrip(source)).toBe(source);
  });

  it("keeps front matter in the envelope and threads in the document", () => {
    const { envelope, content } = load(
      `---\ntitle: x\n---\n\n# Title\n\n${THREAD}`
    );

    expect(envelope.frontMatter).toBe("title: x");
    expect(getDocumentJSONComments(content).map((c) => c.id)).toEqual(["c1"]);
  });

  it("parses the body once with the DFM parser, anchors included", () => {
    const body = "Some :comment-start{id=c1}**bold**:comment-end{id=c1} text.";
    const parser = vi.mocked(fromMarkdown);
    parser.mockClear();

    load(`${body}\n\n${OPEN_THREAD}`);

    expect(parser.mock.calls.filter(([text]) => text === body)).toHaveLength(1);
  });

  it("turns anchors into comment marks, overlapping and across paragraphs", () => {
    const thread = (id: string) =>
      `::comment{id=${id} status=open}\n\n::message{author=user:u name="U" at=${AT}}\n\nNote.\n`;
    const { content } = load(
      `:comment-start{id=a}One :comment-start{id=b}two:comment-end{id=a} three\n\nfour:comment-end{id=b} five\n\n:::annotations\n${thread("a")}\n${thread("b")}:::\n`
    );

    expect(markedTexts(content)).toEqual([
      "One [a]",
      "two[a,b]",
      " three[b]",
      "four[b]",
      " five",
    ]);
    expect(JSON.stringify(content)).not.toContain("commentAnchor");
  });

  it("does not mark inline code inside a commented range", () => {
    const { content } = load(
      `:comment-start{id=c1}Run \`npm test\` now:comment-end{id=c1}\n\n${OPEN_THREAD}`
    );

    expect(markedTexts(content)).toEqual(["Run [c1]", "npm test", " now[c1]"]);
  });

  it.each([
    [
      "anchors inside italic",
      "*foo :comment-start{id=c1}bar:comment-end{id=c1} baz*",
      ["foo [italic]", "bar[italic,c1]", " baz[italic]"],
    ],
    [
      "anchors inside bold, ending at its edge",
      "**foo :comment-start{id=c1}bar:comment-end{id=c1}** end",
      ["foo [bold]", "bar[bold,c1]", " end"],
    ],
    [
      "an anchor starting inside link text and ending after it",
      "[see :comment-start{id=c1}the docs](https://example.com) and more:comment-end{id=c1} here",
      ["see [link]", "the docs[link,c1]", " and more[c1]", " here"],
    ],
  ])("opens a file with %s", (_, body, texts) => {
    const source = `${body}\n\n${OPEN_THREAD}`;
    const { content } = load(source);

    expect(formattedTexts(content)).toEqual(texts);
    expect(load(roundTrip(source)).content).toEqual(content);
  });

  it.each([
    [
      "inline code at a comment's start",
      `Hi :comment-start{id=c1}\`code\` there:comment-end{id=c1}\n\n${OPEN_THREAD}`,
    ],
    [
      "inline code at a comment's end",
      `Hi :comment-start{id=c1}there \`code\`:comment-end{id=c1} now\n\n${OPEN_THREAD}`,
    ],
    [
      "a code block at a comment's start",
      `Intro :comment-start{id=c1}\n\n\`\`\`\ncode\n\`\`\`\n\nafter:comment-end{id=c1}\n\n${OPEN_THREAD}`,
    ],
  ])("refuses %s, which a save would drop from the comment", (_, source) => {
    const loaded = loadDfm(source);

    expect(loaded.isErr() && loaded.error).toContain(
      "starts or ends on text the editor cannot highlight"
    );
  });

  it.each([
    [
      "HTML",
      "Intro.\n\n<div>x</div>\n",
      "The Markdown uses formatting the editor cannot keep: HTML.",
    ],
    [
      "HTML in a quote",
      "> Intro.\n>\n> <div>x</div>\n",
      "The Markdown uses formatting the editor cannot keep: HTML.",
    ],
  ])("refuses %s, naming it", (_, source, reason) => {
    const loaded = loadDfm(source);

    expect(loaded.isErr() && loaded.error).toBe(reason);
  });

  // Each source makes the editor write one of its own refusals: rewording one without updating
  // the log allowlist fails here instead of silently logging it as invalid DFM.
  it.each([
    ["an unsupported element", "Intro.\n\n<div>x</div>\n"],
    ["a task the editor would not read as one", "- 1. [ ] todo\n"],
    [
      "Markdown that changes when saved",
      "See [docs](<https://example.com/a b>)\n",
    ],
    [
      "an anchor the editor cannot show",
      `See [docs](https://example.com/:comment-start{id=c1}a:comment-end{id=c1})\n\n${OPEN_THREAD}`,
    ],
    [
      "a comment edge on text the editor cannot highlight",
      `Hi :comment-start{id=c1}\`code\` there:comment-end{id=c1}\n\n${OPEN_THREAD}`,
    ],
    [
      "a comment covering no text the editor can highlight",
      `Run :comment-start{id=c1}\`npm test\`:comment-end{id=c1}\n\n${OPEN_THREAD}`,
    ],
  ])("logs the editor's own refusal for %s, ids masked", (_, source) => {
    const loaded = loadDfm(source);
    const reason = loaded.isErr() ? loaded.error : "";

    expect(reason).not.toBe("");
    expect(loggableRefusal(reason)).toBe(reason.replaceAll('"c1"', '"…"'));
  });

  it("logs a codec error without what it quotes from the file", () => {
    const loaded = loadDfm(
      ":comment-start{id=c1 secret=SensitiveValue broken}hello:comment-end{id=c1}\n"
    );
    const reason = loaded.isErr() ? loaded.error : "";

    expect(reason).toContain("SensitiveValue");
    expect(loggableRefusal(reason)).toBe("The file is not valid DFM.");
  });

  it.each([
    ["bold", "**`Apply` is one transaction.**\n"],
    ["italic", "*see `x` here*\n"],
    ["a link", "[`docs`](https://example.com)\n"],
    ["bold in a list item", "- **`Apply` is one transaction.** Then more.\n"],
  ])("round-trips inline code inside %s", (_, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it("keeps inline code inside commented bold text out of the comment", () => {
    const source = `**:comment-start{id=c1}Run \`npm test\` now:comment-end{id=c1}**\n\n${OPEN_THREAD}`;

    expect(markedTexts(load(source).content)).toEqual([
      "Run [c1]",
      "npm test",
      " now[c1]",
    ]);
    expect(roundTrip(source)).toBe(source);
  });

  it.each([
    [
      "a tilde fence",
      "~~~ts\nconst a = 1;\n~~~\n",
      "```ts\nconst a = 1;\n```\n",
    ],
    [
      "an indented backtick fence",
      "  ```\n  code\n  ```\n",
      "```\ncode\n```\n",
    ],
    [
      "an indented code block",
      "Intro.\n\n    code\n",
      "Intro.\n\n```\ncode\n```\n",
    ],
    [
      "a tilde fence in a list item",
      "- item\n\n  ~~~\n  code\n  ~~~\n",
      "- item\n  ```\n  code\n  ```\n",
    ],
  ])("opens %s and saves it with backticks", (_, source, saved) => {
    expect(roundTrip(source)).toBe(saved);
  });

  it.each([
    [
      "a tilde fence holding a backtick fence",
      "~~~md\n```js\ncode\n```\n~~~\n",
      "````md\n```js\ncode\n```\n````\n",
    ],
    [
      "a longer backtick fence holding a backtick fence",
      "`````\n````\n```\ncode\n```\n````\n`````\n",
      "`````\n````\n```\ncode\n```\n````\n`````\n",
    ],
    [
      "a backtick fence holding indented backticks",
      "````\n   ```\n````\n",
      "````\n   ```\n````\n",
    ],
    [
      "a backtick fence holding backticks mid-line",
      "```\na ``` b\n```\n",
      "````\na ``` b\n````\n",
    ],
    [
      "a tilde fence whose info string holds a backtick",
      "~~~js title=`demo`\ncode\n~~~\n",
      "~~~js title=`demo`\ncode\n~~~\n",
    ],
    [
      "a tilde fence holding tildes, whose info string holds a backtick",
      "~~~~js title=`demo`\n~~~\n~~~~\n",
      "~~~~js title=`demo`\n~~~\n~~~~\n",
    ],
    [
      "a tilde fence whose info string starts with a tilde",
      "~~~ ~js`demo`\ncode\n~~~\n",
      "~~~ ~js`demo`\ncode\n~~~\n",
    ],
  ])("opens %s and saves it with a longer fence", (_, source, saved) => {
    expect(roundTrip(source)).toBe(saved);
  });

  it("opens a comment with inline code inside it", () => {
    const source = `:comment-start{id=c1}Run \`npm test\` now:comment-end{id=c1}\n\n${OPEN_THREAD}`;

    expect(roundTrip(source)).toBe(source);
  });

  it.each([
    [
      "invalid DFM",
      "Body\n\n:::annotations\n::comment{id=c1}\n:::\n",
      "status",
    ],
    [
      "Markdown the editor cannot reproduce",
      "Intro.\n\n<div>x</div>\n",
      "formatting the editor cannot keep",
    ],
    [
      "a comment covering only code",
      `Run :comment-start{id=c1}\`npm test\`:comment-end{id=c1}\n\n${OPEN_THREAD}`,
      "covers no text the editor can highlight",
    ],
    [
      "an anchor inside a link destination",
      `See [docs](https://example.com/:comment-start{id=c1}a:comment-end{id=c1})\n\n${OPEN_THREAD}`,
      "cannot show it",
    ],
  ])("refuses %s with a reason", (_, source, reason) => {
    const loaded = loadDfm(source);

    expect(loaded.isErr()).toBe(true);
    if (loaded.isErr()) {
      expect(loaded.error).toContain(reason);
    }
  });
});

describe("saveDfm", () => {
  it.each([
    [
      "in one cell",
      "| a | :comment-start{id=c1}b:comment-end{id=c1} |\n| --- | --- |\n| 1 | 2 |",
    ],
    [
      "across cells",
      "| :comment-start{id=c1}a | b |\n| --- | --- |\n| 1 | 2:comment-end{id=c1} |",
    ],
  ])("writes back a comment %s as it reads", (_, body) => {
    const source = `${body}\n\n${OPEN_THREAD}`;

    expect(roundTrip(source)).toBe(source);
  });

  it("round-trips a file through load and save", () => {
    const source = `---\ntitle: x\n---\n\n# Title\n\nSome **bold** text.\n\n- one\n- two\n\n${THREAD}`;

    const saved = roundTrip(source);

    expect(saved).toBe(source);
    expect(parseDfm(saved).isOk()).toBe(true);
  });

  it.each([
    "Intro.\n\n1. one\n2. two\n\nAfter.\n",
    "3. three\n4. four\n",
    "1. one\n   1. nested\n2. two\n",
    "- a\n- b\n\n1. c\n",
  ])("round-trips ordered lists: %j", (source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it("parses the tokens it checked instead of lexing the Markdown again", () => {
    const parse = vi.spyOn(MarkdownManager.prototype, "parse");
    const lex = vi.spyOn(Lexer.prototype, "lex");

    const { envelope, content } = load(
      `# Title\n\nSome **bold** text.\n\n${THREAD}`
    );
    // Loading reads the body, then checks the Markdown a save would write reads back the same.
    expect(lex).toHaveBeenCalledTimes(2);
    lex.mockClear();
    expect(saveDfm(envelope, content).isOk()).toBe(true);
    expect(lex).toHaveBeenCalledTimes(1);
    expect(parse).not.toHaveBeenCalled();
    lex.mockRestore();
    parse.mockRestore();
  });

  it("saves underlined text and opens it underlined again", () => {
    const source = "Hello ++brave++ world.\n";

    expect(roundTrip(source)).toBe(source);
    expect(load(source).content.content?.[0].content?.[1]).toEqual({
      type: "text",
      text: "brave",
      marks: [{ type: "underline" }],
    });
  });

  it("round-trips the codec fixture, anchors and threads included", () => {
    expect(roundTrip(FIXTURE)).toBe(FIXTURE);
  });

  it.each([
    "**foo :comment-start{id=c1}bar:comment-end{id=c1}** end",
    "*foo :comment-start{id=c1}bar:comment-end{id=c1}* end",
    "**:comment-start{id=c1}bar:comment-end{id=c1}** end",
    "[foo :comment-start{id=c1}bar:comment-end{id=c1}](https://example.com) end",
  ])(
    "keeps anchors inside the formatting of the text they comment: %s",
    (body) => {
      const source = `${body}\n\n${OPEN_THREAD}`;

      expect(roundTrip(source)).toBe(source);
    }
  );

  it("keeps message signatures through load and save", () => {
    const signed = FIXTURES.find(({ name }) => name === "signed_comments.md");
    if (!signed) {
      throw new Error("Missing signed_comments.md fixture.");
    }

    expect(roundTrip(signed.source)).toBe(signed.source);
  });

  it("writes anchors inside formatting without splitting it", () => {
    const source = `Some **bo:comment-start{id=c1}ld** and *it:comment-end{id=c1}alic* text.\n\n${OPEN_THREAD}`;

    expect(roundTrip(source)).toBe(source);
  });

  const commented = { type: "comment", attrs: { id: "c1" } };
  it.each([
    [
      "italic running into the comment",
      [
        { type: "text", text: "foo ", marks: [{ type: "italic" }] },
        { type: "text", text: "bar", marks: [{ type: "italic" }, commented] },
        { type: "text", text: " baz" },
      ],
      "*foo :comment-start{id=c1}bar:comment-end{id=c1}* baz",
    ],
    [
      "bold running out of the comment",
      [
        { type: "text", text: "foo " },
        { type: "text", text: "bar", marks: [{ type: "bold" }, commented] },
        { type: "text", text: " baz", marks: [{ type: "bold" }] },
      ],
      "foo **:comment-start{id=c1}bar:comment-end{id=c1} baz**",
    ],
    [
      "bold right after a word, where an anchor inside it would not read back",
      [
        { type: "text", text: "foo" },
        { type: "text", text: "bar", marks: [{ type: "bold" }, commented] },
      ],
      "foo:comment-start{id=c1}**bar**:comment-end{id=c1}",
    ],
    [
      "a link across both edges",
      [
        {
          type: "text",
          text: "see the docs",
          marks: [{ type: "link", attrs: { href: "https://example.com" } }],
        },
        {
          type: "text",
          text: " here",
          marks: [
            { type: "link", attrs: { href: "https://example.com" } },
            commented,
          ],
        },
        {
          type: "text",
          text: " now",
          marks: [{ type: "link", attrs: { href: "https://example.com" } }],
        },
      ],
      "[see the docs:comment-start{id=c1} here:comment-end{id=c1} now](https://example.com)",
    ],
  ])("saves %s and reopens it the same", (_, content, body) => {
    const document = withDocumentJSONComments(
      { type: "doc", content: [{ type: "paragraph", content }] },
      [COMMENT]
    );

    const saved = saveDfm({ frontMatter: null, anchorOrder: [] }, document);

    expect(saved.isOk() && saved.value).toBe(`${body}\n\n${OPEN_THREAD}`);
    if (saved.isOk()) {
      expect(markedTexts(load(saved.value).content)).toEqual(
        markedTexts(document)
      );
    }
  });

  const twoThreads = (first: string, second: string) =>
    `:::annotations\n::comment{id=${first} status=open}\n\n::message{author=user:u name="U" at=${AT}}\n\nOne.\n\n::comment{id=${second} status=open}\n\n::message{author=user:u name="U" at=${AT}}\n\nTwo.\n:::\n`;

  it.each([
    [
      "nested ends",
      "A :comment-start{id=c2}b :comment-start{id=c1}c:comment-end{id=c1}:comment-end{id=c2} d",
    ],
    [
      "crossing ends",
      "A :comment-start{id=c2}b :comment-start{id=c1}c:comment-end{id=c2}:comment-end{id=c1} d",
    ],
    [
      "starts sharing a place",
      "A :comment-start{id=c1}:comment-start{id=c2}b:comment-end{id=c1} c:comment-end{id=c2} d",
    ],
    [
      "a start written before an end at the same place",
      "A :comment-start{id=c1}b:comment-start{id=c2}:comment-end{id=c1}c:comment-end{id=c2} d",
    ],
  ])("keeps %s in the file's order", (_, body) => {
    const source = `${body}\n\n${twoThreads("c1", "c2")}`;

    expect(roundTrip(source)).toBe(source);
  });

  it("nests the anchors of a new comment with the existing ones", () => {
    const source = `A :comment-start{id=c1}b c:comment-end{id=c1} d\n\n${twoThreads("c1", "c2")}`;
    const { envelope, content } = load(source);
    const paragraph = content.content?.[0];
    if (!paragraph?.content) {
      throw new Error("No paragraph.");
    }
    // A second comment on exactly the same text, as the editor adds one.
    paragraph.content = paragraph.content.map((node) =>
      node.marks?.some((mark) => mark.type === "comment")
        ? {
            ...node,
            marks: [...node.marks, { type: "comment", attrs: { id: "c2" } }],
          }
        : node
    );

    const saved = saveDfm(envelope, content);

    expect(saved.isOk() && saved.value.split("\n")[0]).toBe(
      "A :comment-start{id=c1}:comment-start{id=c2}b c:comment-end{id=c2}:comment-end{id=c1} d"
    );
  });

  it("saves a new comment around an existing one", () => {
    const source = `A :comment-start{id=c1}b:comment-end{id=c1} c\n\n${twoThreads("c1", "c2")}`;
    const { envelope, content } = load(source);
    const paragraph = content.content?.[0];
    if (!paragraph?.content) {
      throw new Error("No paragraph.");
    }
    // The editor adds the new comment's mark after the existing one, as on the whole paragraph.
    paragraph.content = paragraph.content.map((node) => ({
      ...node,
      marks: [...(node.marks ?? []), { type: "comment", attrs: { id: "c2" } }],
    }));

    const saved = saveDfm(envelope, content);

    expect(saved.isOk() && saved.value.split("\n")[0]).toBe(
      ":comment-start{id=c2}A :comment-start{id=c1}b:comment-end{id=c1} c:comment-end{id=c2}"
    );
  });

  it("keeps front matter when the body is empty", () => {
    const source = "---\ntitle: x\n---\n";

    expect(roundTrip(source)).toBe(source);
  });

  it("writes LF line endings for a CRLF file", () => {
    expect(roundTrip("# Title\r\n\r\nText\r\n")).toBe("# Title\n\nText\n");
  });

  it("round-trips images with their Markdown source", () => {
    for (const source of [
      "![Revenue chart](pod-abc/charts/revenue.png)\n",
      "# Report\n\n![Chart](pod-abc/chart.png)\n\nText.\n",
      "> ![Chart](pod-abc/chart.png)\n",
      "- ![Chart](pod-abc/chart.png)\n",
      '![A \\[draft\\] chart](<conversation-c1/my chart.png> "Q3 \\"draft\\"")\n',
      "Before ![x](pod-abc/x%20y.png) after.\n",
      ":comment-start{id=c1}See ![x](pod-abc/x.png) here.:comment-end{id=c1}\n\n" +
        OPEN_THREAD,
    ]) {
      expect(roundTrip(source)).toBe(source);
      expect(() =>
        documentSchema.nodeFromJSON(load(source).content).check()
      ).not.toThrow();
    }
  });

  it("round-trips Frame embeds with their path", () => {
    for (const source of [
      '::embed_frame{path="pod-abc/dashboards/revenue.tsx"}\n',
      '# Report\n\n::embed_frame{path="conversation-c1/a &amp; b.tsx"}\n\nText.\n',
      'Intro\n\n::embed_frame{path="pod-abc/x.tsx"}\n\n::embed_frame{path="pod-abc/y.tsx"}\n',
      '::embed_frame{path="pod-abc/x.tsx" height="400"}\n',
    ]) {
      expect(roundTrip(source)).toBe(source);
      expect(() =>
        documentSchema.nodeFromJSON(load(source).content).check()
      ).not.toThrow();
    }
  });

  it("round-trips file previews with their attributes", () => {
    for (const source of [
      ':preview_file{path="pod-abc/report.pdf"}\n',
      'See :preview_file{path="pod-abc/report.pdf" title="Q3 report" contentType="application/pdf"} for details.\n',
      '- :preview_file{path="conversation-c1/a &amp; b.md" title="&quot;A&quot; &amp; B"}\n',
      ':comment-start{id=c1}Read :preview_file{path="pod-abc/x.pdf"} first.:comment-end{id=c1}\n\n' +
        OPEN_THREAD,
      ':preview_file{path="pod-abc/x.pdf" title="" contentType=""}\n',
    ]) {
      expect(roundTrip(source)).toBe(source);
      expect(() =>
        documentSchema.nodeFromJSON(load(source).content).check()
      ).not.toThrow();
    }
  });

  it("reads a Frame embed only from a line holding the directive alone", () => {
    for (const source of [
      'See ::embed_frame{path="pod-abc/x.tsx"} here.\n',
      'See::embed_frame{path="pod-abc/x.tsx"}\n',
      '::embed_frame{path="pod-abc/x.tsx" title="X"}\n',
    ]) {
      expect(JSON.stringify(load(source).content)).not.toContain("frameEmbed");
    }
  });

  it("writes text that reads as a Frame embed so it reopens as text", () => {
    const line = '::embed_frame{path="pod-abc/x.tsx"}';
    for (const paragraph of [
      [{ type: "text", text: line }],
      [
        { type: "text", text: "Intro" },
        { type: "hardBreak" },
        { type: "text", text: line },
      ],
    ]) {
      const saved = saveDfm(
        { frontMatter: null, anchorOrder: [] },
        { type: "doc", content: [{ type: "paragraph", content: paragraph }] }
      );
      if (saved.isErr()) {
        throw new Error(saved.error);
      }
      expect(saved.value).toContain(line.replace("_", "\\_"));
      expect(JSON.stringify(load(saved.value).content)).not.toContain(
        "frameEmbed"
      );
    }
  });

  it("reads a Frame line opening a list item as its text", () => {
    const source = '- ::embed_frame{path="pod-abc/x.tsx"}\n';
    expect(JSON.stringify(load(source).content)).not.toContain("frameEmbed");
    expect(roundTrip(source)).toBe('- ::embed\\_frame{path="pod-abc/x.tsx"}\n');
    expect(
      roundTrip('- ::embed_frame{path="pod-abc/x.tsx" height="400"}\n')
    ).toBe('- ::embed\\_frame{path="pod-abc/x.tsx" height="400"}\n');
  });

  it("reads an image's width after its alt text, and keeps alt text ending like one", () => {
    for (const source of [
      "![Chart|400](pod-abc/chart.png)\n",
      "![|240](pod-abc/chart.png)\n",
      '![A \\[draft\\] chart|560](<conversation-c1/my chart.png> "Q3")\n',
      "![Chart\\|2024](pod-abc/chart.png)\n",
      "![Chart|2024|400](pod-abc/chart.png)\n",
      "![Chart|0](pod-abc/chart.png)\n",
      "![C:\\\\|400](pod-abc/chart.png)\n",
    ]) {
      expect(roundTrip(source)).toBe(source);
    }

    const image = (source: string) =>
      load(source).content.content?.[0].content?.[0].attrs;
    expect(image("![Chart|400](pod-abc/chart.png)\n")).toMatchObject({
      alt: "Chart",
      width: 400,
    });
    expect(image("![Chart\\|2024](pod-abc/chart.png)\n")).toMatchObject({
      alt: "Chart|2024",
      width: null,
    });
    expect(image("![Chart|0](pod-abc/chart.png)\n")).toMatchObject({
      alt: "Chart|0",
      width: null,
    });
    expect(image("![C:\\\\|400](pod-abc/chart.png)\n")).toMatchObject({
      alt: "C:\\",
      width: 400,
    });
  });

  it("writes an image's width after its alt text, escaping alt text ending like one", () => {
    const save = (attrs: Record<string, unknown>) =>
      saveDfm(
        { frontMatter: null, anchorOrder: [] },
        {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "image",
                  attrs: { src: "pod-abc/chart.png", ...attrs },
                },
              ],
            },
          ],
        }
      );

    expect(save({ alt: "Chart", width: 240 })).toEqual(
      new Ok("![Chart|240](pod-abc/chart.png)\n")
    );
    expect(save({ alt: "Chart|2024", width: null })).toEqual(
      new Ok("![Chart\\|2024](pod-abc/chart.png)\n")
    );
    expect(save({ alt: "C:\\", width: 400 })).toEqual(
      new Ok("![C:\\\\|400](pod-abc/chart.png)\n")
    );
  });

  it("keeps a file preview with another attribute as text", () => {
    const source =
      ':preview_file{path="pod-abc/x.pdf" mimeType="application/pdf"}\n';

    const reopened = load(roundTrip(source)).content;

    expect(JSON.stringify(reopened)).not.toContain(FILE_PREVIEW_NODE_TYPE);
    expect(reopened.content?.[0]?.content?.[0]?.text).toBe(source.trimEnd());
  });

  it("refuses content the editor cannot write as Markdown", () => {
    const saved = saveDfm(
      { frontMatter: null, anchorOrder: [] },
      { type: "doc", content: [{ type: "table" }] }
    );

    expect(saved.isErr()).toBe(true);
    if (saved.isErr()) {
      expect(saved.error).toContain("cannot be saved as Markdown");
    }
  });

  it("writes an edited body with the document's threads", () => {
    const { envelope } = load("# Title\n");
    const saved = saveDfm(
      envelope,
      withDocumentJSONComments(
        {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Rewritten " },
                {
                  type: "text",
                  text: "here",
                  marks: [{ type: "comment", attrs: { id: "c1" } }],
                },
                { type: "text", text: "." },
              ],
            },
          ],
        },
        [COMMENT]
      )
    );

    expect(saved.isOk()).toBe(true);
    if (saved.isOk()) {
      expect(saved.value).toBe(
        `Rewritten :comment-start{id=c1}here:comment-end{id=c1}.\n\n${OPEN_THREAD}`
      );
    }
  });

  it("keeps a thread whose text was deleted", () => {
    const { envelope, content } = load(
      `Hi :comment-start{id=c1}there:comment-end{id=c1}\n\n${OPEN_THREAD}`
    );
    const saved = saveDfm(
      envelope,
      withDocumentJSONComments(
        {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Hi" }] },
          ],
        },
        getDocumentJSONComments(content)
      )
    );

    expect(saved.isOk()).toBe(true);
    if (saved.isOk()) {
      expect(saved.value).toBe(`Hi\n\n${OPEN_THREAD}`);
    }
  });
});

describe("isWritableThread", () => {
  it("accepts a thread the codec can write", () => {
    expect(isWritableThread(COMMENT)).toBe(true);
  });

  it.each([
    ["a directive line", "First line\n::message{author=user:x}"],
    ["an unclosed code fence", "```\ncode"],
  ])("refuses a message with %s", (_, body) => {
    const thread: DfmComment = {
      ...COMMENT,
      messages: [{ ...COMMENT.messages[0], body }],
    };

    expect(isWritableThread(thread)).toBe(false);
  });
});

type DfmPersistence =
  typeof import("@app/components/editor/document/dfm_persistence");

/** This module again, over a TipTap without its token parsing step, so it parses through `parse`. */
async function importWithPublicParse(
  onParse: () => void
): Promise<DfmPersistence> {
  vi.resetModules();
  vi.doMock("@tiptap/markdown", async (importOriginal) => {
    const original = await importOriginal<typeof import("@tiptap/markdown")>();
    class PublicMarkdownManager extends original.MarkdownManager {
      constructor(
        ...args: ConstructorParameters<typeof original.MarkdownManager>
      ) {
        super(...args);
        Reflect.deleteProperty(this, "activeParseLexer");
      }

      override parse(markdown: string): JSONContent {
        onParse();
        return super.parse(markdown);
      }
    }
    return { ...original, MarkdownManager: PublicMarkdownManager };
  });
  try {
    return await import("@app/components/editor/document/dfm_persistence");
  } finally {
    vi.doUnmock("@tiptap/markdown");
  }
}

function loadAndSave(
  { loadDfm, saveDfm }: Pick<DfmPersistence, "loadDfm" | "saveDfm">,
  source: string
) {
  const outcome = <T>(result: Result<T, string>) =>
    result.isOk() ? { value: result.value } : { error: result.error };
  const loaded = loadDfm(source);
  return {
    loaded: outcome(loaded),
    saved: loaded.isOk()
      ? outcome(saveDfm(loaded.value.envelope, loaded.value.content))
      : null,
  };
}

describe("TipTap's token parsing step", () => {
  const publicParse = vi.fn();
  let withPublicParse: DfmPersistence;

  beforeAll(async () => {
    withPublicParse = await importWithPublicParse(publicParse);
  });

  it.each([
    ...FIXTURES.map(({ source }) => source),
    "# Title\n\nSome **bold**, *italic*, ~~struck~~ and ++underlined++ text.\n",
    "One.\n\n\n\nTwo, after blank lines.\n",
    "Line one  \nline two\\\nline three.\n",
    "- a\n  - nested **b**\n- c\n\n3. three\n4. four\n",
    '> Quoted [link](https://example.com "Title").\n>\n> - in a list\n',
    "```ts\nconst a = 1;\n```\n\nText with `code`.\n\n---\n\nAfter a rule.\n",
    "Before ![x](pod-abc/x.png) after.\n\n![Chart](pod-abc/chart.png)\n",
    "| Left | Center | Right |\n| :--- | :---: | ---: |\n| **a** | `b` | c |\n",
    'Intro\n\n::embed_frame{path="pod-abc/x.tsx"}\n\n- ::embed_frame{path="pod-abc/y.tsx"}\n',
    'See :preview_file{path="pod-abc/report.pdf" title="Q3 report" contentType="application/pdf"} for details.\n',
    `Hi :comment-start{id=c1}there:comment-end{id=c1} now.\n\n${OPEN_THREAD}`,
  ])("loads and saves as TipTap's public parse does: %j", (source) => {
    publicParse.mockClear();

    const expected = loadAndSave(withPublicParse, source);

    expect(publicParse).toHaveBeenCalled();
    expect(expected.loaded).toHaveProperty("value");
    expect(loadAndSave({ loadDfm, saveDfm }, source)).toEqual(expected);
  });
});

/** Each list item as `depth:mark:text`, the mark `[ ]`, `[x]` or `-` for a plain item. */
function listItems(document: JSONContent): string[] {
  const items: string[] = [];
  const visit = (node: JSONContent, depth: number) => {
    if (node.type === "listItem") {
      const mark = node.attrs?.task
        ? node.attrs.checked
          ? "[x]"
          : "[ ]"
        : "-";
      const text = (node.content?.[0]?.content ?? [])
        .map((inline) => inline.text ?? "")
        .join("");
      items.push(`${depth}:${mark}:${text}`);
    }
    node.content?.forEach((child) =>
      visit(child, node.type === "listItem" ? depth + 1 : depth)
    );
  };
  visit(document, 0);
  return items;
}

describe("task lists", () => {
  it.each([
    [
      "checked and unchecked items, nested",
      "- [ ] Prepare the launch\n  - [x] Blog post\n  - [ ] Press kit\n- [x] Done\n",
      [
        "0:[ ]:Prepare the launch",
        "1:[x]:Blog post",
        "1:[ ]:Press kit",
        "0:[x]:Done",
      ],
    ],
    [
      "alternating items",
      "- a\n- [ ] b\n- c\n- [x] d\n",
      ["0:-:a", "0:[ ]:b", "0:-:c", "0:[x]:d"],
    ],
    [
      "a numbered task list starting at 3",
      "3. [x] Third\n4. [ ] Fourth\n",
      ["0:[x]:Third", "0:[ ]:Fourth"],
    ],
    [
      "a task list nested in a numbered list",
      "1. one\n   - [ ] todo\n   - [x] done\n2. two\n",
      ["0:-:one", "1:[ ]:todo", "1:[x]:done", "0:-:two"],
    ],
    [
      "a task with two paragraphs",
      "- [ ] A task\n\n  and its second paragraph\n- [x] Another\n",
      ["0:[ ]:A task", "0:[x]:Another"],
    ],
  ])("opens %s and saves it as written", (_, source, items) => {
    expect(listItems(load(source).content)).toEqual(items);
    expect(roundTrip(source)).toBe(source);
  });

  it.each([
    [
      "`*` bullets and `X`",
      "* [X] Done\n* [ ] Open\n",
      "- [x] Done\n- [ ] Open\n",
    ],
    ["`)` numbers", "1) [ ] One\n2) [x] Two\n", "1. [ ] One\n2. [x] Two\n"],
  ])("normalizes %s", (_, source, saved) => {
    expect(roundTrip(source)).toBe(saved);
    expect(roundTrip(saved)).toBe(saved);
  });

  it.each([
    [
      "inside one item",
      "- [ ] Buy :comment-start{id=c1}fresh:comment-end{id=c1} milk\n- Notes\n",
    ],
    [
      "across a task and a plain item",
      "- [ ] Buy :comment-start{id=c1}milk\n- Notes:comment-end{id=c1} here\n",
    ],
  ])("keeps a comment %s", (_, body) => {
    const source = `${body}\n${OPEN_THREAD}`;
    const { content } = load(source);

    expect(markedTexts(content).some((text) => text.endsWith("[c1]"))).toBe(
      true
    );
    expect(roundTrip(source)).toBe(source);
  });

  it("refuses a task the editor would not read as one", () => {
    const loaded = loadDfm("- 1. [ ] todo\n");

    expect(loaded.isErr() && loaded.error).toBe(
      "The Markdown's task lists would not read back the same."
    );
  });
});

describe("numbered lists", () => {
  it.each([
    ["starting at 1", "1. one\n2. two\n"],
    ["starting at 3", "3. three\n4. four\n"],
    ["starting at 0", "0. zero\n1. one\n"],
    ["with a nested list", "1. one\n   - a\n   - b\n2. two\n"],
    ["with two paragraphs", "1. a\n\n   para\n2. b\n"],
  ])("opens one %s and saves it as written", (_, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it("opens an item whose text wraps onto an indented line, saving it as a lazy one", () => {
    const source =
      "1. **Save the doc.** The collab server writes the new content to the doc, alone in its own\n   `Apply`.\n";
    const { content } = load(source);

    const saved = roundTrip(source);
    expect(saved).toBe(
      "1. **Save the doc.** The collab server writes the new content to the doc, alone in its own\n`Apply`.\n"
    );
    expect(load(saved).content).toEqual(content);
    expect(roundTrip(saved)).toBe(saved);
  });

  it("writes `)` numbers with a period", () => {
    expect(roundTrip("1) one\n2) two\n")).toBe("1. one\n2. two\n");
  });

  it.each([
    ["letters and Roman numerals", "a. one\nb. two\n\ni. first\n"],
    ["a phone number", "Call (216) 555-1234 now\n"],
  ])("reads %s as text, as GFM does", (_, source) => {
    expect(JSON.stringify(load(source).content)).not.toContain("orderedList");
    expect(roundTrip(source)).toBe(source);
  });
});

/** Each list item's first paragraph text, in document order. */
function itemTexts(node: JSONContent): string[] {
  const own =
    node.type === "listItem"
      ? [(node.content?.[0]?.content ?? []).map((n) => n.text ?? "").join("")]
      : [];
  return [...own, ...(node.content ?? []).flatMap(itemTexts)];
}

describe("empty blocks", () => {
  const text = (value: string): JSONContent => ({ type: "text", text: value });
  const paragraph = (value?: string): JSONContent => ({
    type: "paragraph",
    ...(value ? { content: [text(value)] } : {}),
  });
  const item = (value?: string, ...blocks: JSONContent[]): JSONContent => ({
    type: "listItem",
    content: [paragraph(value), ...blocks],
  });
  const bullets = (...items: JSONContent[]): JSONContent => ({
    type: "bulletList",
    content: items,
  });
  const quote = (...blocks: JSONContent[]): JSONContent => ({
    type: "blockquote",
    content: blocks,
  });
  const heading = (level: number, value?: string): JSONContent => ({
    type: "heading",
    attrs: { level },
    ...(value ? { content: [text(value)] } : {}),
  });

  it.each([
    ["alone", "- &nbsp;\n", [""]],
    ["opening a list", "- &nbsp;\n- b\n", ["", "b"]],
    ["ending a list", "- a\n- &nbsp;\n", ["a", ""]],
    ["numbered from 3", "3. &nbsp;\n4. four\n", ["", "four"]],
    ["after a paragraph", "Intro\n\n- &nbsp;\n", [""]],
    ["opening a sub-list", "- a\n  - &nbsp;\n  - c\n", ["a", "", "c"]],
    ["opening a numbered sub-list", "1. a\n   1. &nbsp;\n", ["a", ""]],
    ["holding a sub-list", "- &nbsp;\n  - b\n", ["", "b"]],
    ["before a second paragraph", "- &nbsp;\n\n  x\n", [""]],
    ["in a quote", "> - a\n>   - &nbsp;\n", ["a", ""]],
  ])(
    "opens an empty list item %s and saves it as written",
    (_, source, texts) => {
      expect(itemTexts(load(source).content)).toEqual(texts);
      expect(roundTrip(source)).toBe(source);
    }
  );

  it.each([
    ["a quote holding only it", "> &nbsp;\n"],
    ["a quote, after text", "> a\n>\n> &nbsp;\n"],
    ["a list item, after text", "- a\n\n  &nbsp;\n"],
    ["a list item, between paragraphs", "- a\n\n  &nbsp;\n\n  b\n"],
  ])("opens an empty paragraph in %s and saves it as written", (_, source) => {
    expect(JSON.stringify(load(source).content)).not.toContain("&nbsp;");
    expect(roundTrip(source)).toBe(source);
  });

  it.each([
    ["alone", "##\n"],
    ["between paragraphs", "Before\n\n###\n\nAfter\n"],
  ])("opens an empty heading %s and saves it as written", (_, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it.each([
    [
      "a list holding only an empty item",
      [paragraph("Intro"), bullets(item())],
      "Intro\n\n- &nbsp;\n",
    ],
    [
      "a sub-list opening with an empty item",
      [bullets(item("a", bullets(item(), item("c"))))],
      "- a\n  - &nbsp;\n  - c\n",
    ],
    [
      "an item whose text was deleted, holding a sub-list",
      [bullets(item(undefined, bullets(item("b"))))],
      "- &nbsp;\n  - b\n",
    ],
    ["a quote holding an empty paragraph", [quote(paragraph())], "> &nbsp;\n"],
    [
      "a list item ending with an empty paragraph",
      [bullets(item("a", paragraph()))],
      "- a\n\n  &nbsp;\n",
    ],
    ["an empty heading", [heading(2)], "##\n"],
  ])("saves %s", (_, content, expected) => {
    const document = { type: "doc", content };
    const saved = saveDfm({ frontMatter: null, anchorOrder: [] }, document);
    expect(saved).toEqual(new Ok(expected));
    expect(
      documentSchema.nodeFromJSON(load(expected).content).toJSON()
    ).toEqual(documentSchema.nodeFromJSON(document).toJSON());
  });

  it("reads a non-breaking space opening a list item as an empty item", () => {
    expect(itemTexts(load("- \u00a0\n- b\n").content)).toEqual(["", "b"]);
  });

  it.each([
    ["the marker escaped", "- &amp;nbsp;\n", "&nbsp;"],
    ["the marker followed by text", "- &nbsp;milk\n", "milk"],
    [
      "the marker followed by a continuation line",
      "- &nbsp;\n  continued\n",
      "continued",
    ],
  ])("reads %s as the item's text", (_, source, kept) => {
    const [first] = itemTexts(load(source).content);
    expect(first).toContain(kept);
  });
});

describe("getUnsavableBodyReason", () => {
  const envelope = { frontMatter: null, anchorOrder: [] };
  const bullets = (text: string): JSONContent => ({
    type: "bulletList",
    content: [
      {
        type: "listItem",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
    ],
  });

  it("is null for a body saveDfm writes", () => {
    const content = { type: "doc", content: [bullets("milk")] };

    expect(saveDfm(envelope, content).isOk()).toBe(true);
    expect(getUnsavableBodyReason(envelope, content)).toBeNull();
  });

  it("names where a refused body would read back differently, without its text", () => {
    const content = {
      type: "doc",
      content: [paragraphOf("    secret plan")],
    };

    expect(saveDfm(envelope, content).isErr()).toBe(true);
    const reason = getUnsavableBodyReason(envelope, content);
    expect(reason).toBe(
      "The document would not read back the same as Markdown, from paragraph, which reads back as codeBlock."
    );
    expect(reason).not.toContain("secret");
  });

  it("names the marks where only formatting would read back differently", () => {
    const content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "secret ", marks: [{ type: "bold" }] },
            { type: "text", text: "plan" },
          ],
        },
      ],
    };

    const reason = getUnsavableBodyReason(envelope, content);
    expect(reason).toBe(
      "The document would not read back the same as Markdown, from paragraph > text[bold], which reads back as paragraph > text."
    );
    expect(reason).not.toContain("secret");
  });

  it.each([
    "The document would not read back the same as Markdown, from bulletList > end, which reads back as bulletList > listItem.",
    "The document would not read back the same as Markdown, from paragraph > text[bold,link], which reads back as paragraph > text[bold].",
    "The document would be written as html Markdown, which the editor cannot read.",
    "The document could not be written as Markdown.",
  ])("logs the serializer's reason %s as is", (reason) => {
    expect(loggableRefusal(reason)).toBe(reason);
  });
});

describe("lists following each other", () => {
  const list = (type: string, ...texts: string[]): JSONContent => ({
    type,
    content: texts.map((text) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    })),
  });
  const empty: JSONContent = { type: "paragraph" };

  it.each([
    ["two bulleted lists", "- a\n\n* b\n"],
    ["three bulleted lists", "- a\n\n* b\n\n- c\n"],
    ["two numbered lists", "1. a\n2. b\n\n1) c\n"],
    ["a numbered list from 3, then one from 1", "3. a\n\n1) b\n"],
    ["two nested lists", "- x\n  - a\n  * b\n"],
    ["two lists in a quote", "> - a\n>\n> * b\n"],
    ["two bulleted lists with an empty line between", "- a\n\n&nbsp;\n\n- b\n"],
    [
      "two numbered lists with an empty line between",
      "1. a\n\n&nbsp;\n\n1. b\n",
    ],
  ])("opens %s as separate lists and saves them as written", (_, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it.each([
    [
      "two bulleted lists",
      [list("bulletList", "a"), list("bulletList", "b")],
      "- a\n\n* b\n",
    ],
    [
      "three numbered lists",
      [
        list("orderedList", "a"),
        list("orderedList", "b"),
        list("orderedList", "c"),
      ],
      "1. a\n\n1) b\n\n1. c\n",
    ],
    [
      "a bulleted list, then a numbered one",
      [list("bulletList", "a"), list("orderedList", "b")],
      "- a\n\n1. b\n",
    ],
    [
      "two numbered lists with an empty line between",
      [list("orderedList", "a"), empty, list("orderedList", "b")],
      "1. a\n\n&nbsp;\n\n1. b\n",
    ],
    [
      "a list, an empty line and text",
      [list("bulletList", "a"), empty, paragraphOf("b")],
      "- a\n\n\n\nb\n",
    ],
  ])("saves %s", (_, content, expected) => {
    const document = { type: "doc", content };
    const saved = saveDfm({ frontMatter: null, anchorOrder: [] }, document);
    expect(saved).toEqual(new Ok(expected));
    expect(
      documentSchema.nodeFromJSON(load(expected).content).toJSON()
    ).toEqual(documentSchema.nodeFromJSON(document).toJSON());
  });

  it("opens lists written without a blank line between them, saving them with one", () => {
    expect(roundTrip("- a\n* b\n1. c\n1) d\n")).toBe(
      "- a\n\n* b\n\n1. c\n\n1) d\n"
    );
  });

  it("writes a lone list with `-` or `.`, whatever marker it was read with", () => {
    expect(roundTrip("* a\n\nText\n\n1) b\n")).toBe("- a\n\nText\n\n1. b\n");
  });
});

function paragraphOf(text: string): JSONContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

describe("numbered sub-lists after an empty paragraph", () => {
  const item = (...content: JSONContent[]): JSONContent => ({
    type: "listItem",
    content,
  });
  const numbered = (start: number, text: string): JSONContent => ({
    type: "orderedList",
    ...(start !== 1 ? { attrs: { start } } : {}),
    content: [item(paragraphOf(text))],
  });
  const document = (start: number): JSONContent => ({
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          item(
            paragraphOf("x"),
            numbered(1, "a"),
            { type: "paragraph" },
            numbered(start, "b")
          ),
        ],
      },
    ],
  });

  it.each([
    ["from 3, after a blank line", 3, "- x\n  1. a\n\n  &nbsp;\n  \n  3. b\n"],
    ["from 1, on the next line", 1, "- x\n  1. a\n\n  &nbsp;\n  1. b\n"],
  ])("saves one starting %s", (_, start, expected) => {
    const saved = saveDfm(
      { frontMatter: null, anchorOrder: [] },
      document(start)
    );
    expect(saved).toEqual(new Ok(expected));
    expect(
      documentSchema.nodeFromJSON(load(expected).content).toJSON()
    ).toEqual(documentSchema.nodeFromJSON(document(start)).toJSON());
  });
});

describe("hard breaks", () => {
  const envelope = { frontMatter: null, anchorOrder: [] };
  const text = (value: string): JSONContent => ({ type: "text", text: value });
  const hardBreak: JSONContent = { type: "hardBreak" };
  const paragraph = (...content: JSONContent[]): JSONContent => ({
    type: "paragraph",
    content,
  });

  it.each([
    ["between texts", [paragraph(text("a"), hardBreak, text("b"))], "a\\\nb\n"],
    [
      "following each other",
      [paragraph(text("a"), hardBreak, hardBreak, text("b"))],
      "a\\\n\\\nb\n",
    ],
    ["opening a paragraph", [paragraph(hardBreak, text("a"))], "\\\na\n"],
  ])("saves breaks %s so they read back", (_, content, expected) => {
    const document = { type: "doc", content };
    expect(saveDfm(envelope, document)).toEqual(new Ok(expected));
    expect(
      documentSchema.nodeFromJSON(load(expected).content).toJSON()
    ).toEqual(documentSchema.nodeFromJSON(document).toJSON());
  });

  it.each([
    ["a paragraph", [paragraph(text("Hello"), hardBreak)], "Hello\n"],
    [
      "a paragraph before another",
      [paragraph(text("a"), hardBreak, hardBreak), paragraph(text("b"))],
      "a\n\nb\n",
    ],
    [
      "a heading",
      [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [text("H"), hardBreak],
        },
      ],
      "# H\n",
    ],
    [
      "a list item",
      [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [paragraph(text("a"), hardBreak)] },
          ],
        },
      ],
      "- a\n",
    ],
  ])("saves without the breaks ending %s", (_, content, expected) => {
    expect(saveDfm(envelope, { type: "doc", content })).toEqual(
      new Ok(expected)
    );
  });

  it("opens breaks written with two spaces", () => {
    expect(load("a  \nb\n").content.content).toEqual([
      paragraph(text("a"), hardBreak, text("b")),
    ]);
  });
});

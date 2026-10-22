import { Readable } from "node:stream";
import { editCollabSource, readCollabSource } from "@app/lib/api/collab/client";
import {
  editAgentDocument,
  readAgentDocument,
} from "@app/lib/api/documents/agent_edits";
import { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import {
  readCanonicalFileContent,
  WriteCanonicalFileContentError,
  writeCanonicalFileContent,
} from "@app/lib/api/files/file_system_ops";
import type { Authenticator } from "@app/lib/auth";
import { INPUT_LIMITS, parseDfm } from "@app/lib/markdown/dfm";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { Err, Ok } from "@app/types/shared/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("@app/lib/api/collab/client"), async (importOriginal) => ({
  ...(await importOriginal()),
  editCollabSource: vi.fn(),
  readCollabSource: vi.fn(),
}));

vi.mock(
  import("@app/lib/api/files/file_system_ops"),
  async (importOriginal) => {
    const mod = await importOriginal();
    return {
      ...mod,
      readCanonicalFileContent: vi.fn(),
      writeCanonicalFileContent: vi.fn(),
    };
  }
);

const PATH = "pod-p1/spec.md";

const SOURCE =
  "---\ntitle: Spec\n---\n\n# Spec\n\nShip it :comment-start{id=c1}on Friday:comment-end{id=c1}.\n\n" +
  ":::annotations\n::comment{id=c1 status=open}\n\n" +
  '::message{author=user:usr_tom name="Tom" at=2026-10-05T12:00:00.000Z}\n\nWhy Friday?\n:::\n';

function stored(content: string, revision?: string) {
  return new Ok({
    stream: Readable.from([Buffer.from(content, "utf8")]),
    contentType: "text/markdown",
    revision,
  });
}

function written(call: number) {
  const [, , , content, , revision] = vi.mocked(writeCanonicalFileContent).mock
    .calls[call];
  return { content: Buffer.from(content).toString("utf8"), revision };
}

const conflict = () =>
  new Err(
    new WriteCanonicalFileContentError("revision_conflict", "File changed.")
  );

describe("readAgentDocument", () => {
  let authenticator: Authenticator;
  let dustFs: DustFileSystem;

  beforeEach(async () => {
    vi.resetAllMocks();
    ({ authenticator } = await createResourceTest({}));
    const fileSystem = await DustFileSystem.forConversations(authenticator, []);
    if (fileSystem.isErr()) {
      throw fileSystem.error;
    }
    dustFs = fileSystem.value;
    vi.mocked(readCollabSource).mockResolvedValue(new Ok({ open: false }));
  });

  it("returns the full source, anchors and threads included", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored(SOURCE, "7"));

    const result = await readAgentDocument(authenticator, dustFs, PATH);
    expect(result.isOk() && result.value.source).toBe(SOURCE);
  });

  it("refuses a file that is not Markdown or that the codec cannot read", async () => {
    const notMarkdown = await readAgentDocument(
      authenticator,
      dustFs,
      "pod-p1/notes.txt"
    );
    expect(notMarkdown.isErr() && notMarkdown.error.code).toBe("not_markdown");

    vi.mocked(readCanonicalFileContent).mockResolvedValue(
      stored("Hi :comment-start{id=c1}there.\n", "7")
    );
    const unreadable = await readAgentDocument(authenticator, dustFs, PATH);
    expect(unreadable.isErr() && unreadable.error.code).toBe(
      "invalid_document"
    );
  });
});

describe("editAgentDocument", () => {
  let auth: Authenticator;
  let dustFs: DustFileSystem;

  beforeEach(async () => {
    vi.resetAllMocks();
    auth = (await createResourceTest({})).authenticator;
    const fileSystem = await DustFileSystem.forConversations(auth, []);
    if (fileSystem.isErr()) {
      throw fileSystem.error;
    }
    dustFs = fileSystem.value;
    vi.mocked(readCollabSource).mockResolvedValue(new Ok({ open: false }));
  });

  /** A live session holding the document, which the file system lets the agent write. */
  function openSession() {
    vi.mocked(readCollabSource).mockResolvedValueOnce(
      new Ok({ open: true, source: SOURCE })
    );
    vi.spyOn(DustFileSystem.prototype, "checkWriteAccess").mockReturnValue(
      new Ok(undefined)
    );
    vi.spyOn(DustFileSystem.prototype, "stat").mockResolvedValue(
      new Ok({ contentType: "text/markdown", sizeBytes: SOURCE.length })
    );
  }

  it("reports the live session's refusal with the code it sent, writing no file", async () => {
    openSession();
    vi.mocked(editCollabSource).mockResolvedValue(
      new Ok({
        result: "edit_refused",
        code: "string_not_found",
        message: "The text to replace was not found.",
      })
    );

    const result = await edit("Ship it", "Ship");

    expect(result.isErr() && result.error.code).toBe("string_not_found");
    expect(writeCanonicalFileContent).not.toHaveBeenCalled();
  });

  it("writes the file when the live session closed before applying the edit", async () => {
    openSession();
    vi.mocked(editCollabSource).mockResolvedValue(new Ok({ result: "closed" }));
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored(SOURCE, "7"));
    vi.mocked(writeCanonicalFileContent).mockResolvedValue(
      new Ok({ created: false, revision: "8" })
    );

    const result = await edit("Ship it", "Ship");

    expect(result.isOk() && result.value.replacements).toBe(1);
    expect(written(0).revision).toBe("7");
  });

  const edit = (oldString: string, newString: string, expected = 1) =>
    editAgentDocument(auth, dustFs, {
      scopedPath: PATH,
      oldString,
      newString,
      expectedReplacements: expected,
    });

  it("replaces text in the body and keeps the front matter and threads", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored(SOURCE, "7"));
    vi.mocked(writeCanonicalFileContent).mockResolvedValue(
      new Ok({ created: false, revision: "8" })
    );

    const result = await edit("Ship it", "Ship $& it");
    expect(result.isOk() && result.value.replacements).toBe(1);

    const { content, revision } = written(0);
    expect(revision).toBe("7");
    const before = parseDfm(SOURCE);
    const after = parseDfm(content);
    if (before.isErr() || after.isErr()) {
      throw new Error("Unparsable document.");
    }
    expect(after.value.body).toBe(
      "# Spec\n\nShip $& it :comment-start{id=c1}on Friday:comment-end{id=c1}."
    );
    expect(after.value.frontMatter).toBe(before.value.frontMatter);
    expect(after.value.comments).toEqual(before.value.comments);
  });

  it("edits text inside a comment anchor and keeps the anchor", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored(SOURCE, "7"));
    vi.mocked(writeCanonicalFileContent).mockResolvedValue(
      new Ok({ created: false, revision: "8" })
    );

    expect((await edit("on Friday", "on Monday")).isOk()).toBe(true);
    expect(written(0).content).toContain(
      ":comment-start{id=c1}on Monday:comment-end{id=c1}"
    );
  });

  it("deletes commented text with its anchors and keeps its open thread", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored(SOURCE, "7"));
    vi.mocked(writeCanonicalFileContent).mockResolvedValue(
      new Ok({ created: false, revision: "8" })
    );

    const result = await edit(
      "Ship it :comment-start{id=c1}on Friday:comment-end{id=c1}.",
      "Ship it."
    );
    expect(result.isOk() && result.value.replacements).toBe(1);

    const before = parseDfm(SOURCE);
    const after = parseDfm(written(0).content);
    if (before.isErr() || after.isErr()) {
      throw new Error("Unparsable document.");
    }
    expect(after.value.body).toBe("# Spec\n\nShip it.");
    expect(after.value.comments).toEqual(before.value.comments);
  });

  it("matches a passage quoted from a source stored with CRLF line endings", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(
      stored("# Spec\r\n\r\nalpha\r\nbeta\r\n", "7")
    );
    vi.mocked(writeCanonicalFileContent).mockResolvedValue(
      new Ok({ created: false, revision: "8" })
    );

    const result = await edit("alpha\r\nbeta", "gamma");
    expect(result.isOk() && result.value.replacements).toBe(1);
    expect(written(0).content).toBe("# Spec\n\ngamma\n");
  });

  it.each([
    ["breaks an anchor pair", ":comment-end{id=c1}", "", "anchors_invalid"],
    ["empties an anchor pair", "on Friday", "", "anchors_invalid"],
    [
      "adds an anchor",
      "Ship it",
      ":comment-start{id=c2}Ship it:comment-end{id=c2}",
      "anchors_invalid",
    ],
  ])("refuses an edit that %s", async (_, oldString, newString, code) => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored(SOURCE, "7"));

    const result = await edit(oldString, newString);
    expect(result.isErr() && result.error.code).toBe(code);
    expect(writeCanonicalFileContent).not.toHaveBeenCalled();
  });

  it.each([
    ["outside the body", "Why Friday?", "outside_body"],
    ["missing", "Ship it on Monday", "string_not_found"],
  ])("refuses text %s without writing", async (_, oldString, code) => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored(SOURCE, "7"));

    const result = await edit(oldString, "x");
    expect(result.isErr() && result.error.code).toBe(code);
    expect(writeCanonicalFileContent).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty file", "", "# Plan\n\nFirst draft.\n"],
    [
      "a file with only front matter",
      "---\ntitle: Plan\n---\n",
      "---\ntitle: Plan\n---\n\n# Plan\n\nFirst draft.\n",
    ],
  ])(
    "writes the body of %s with an empty old_string",
    async (_, source, expected) => {
      vi.mocked(readCanonicalFileContent).mockResolvedValue(
        stored(source, "7")
      );
      vi.mocked(writeCanonicalFileContent).mockResolvedValue(
        new Ok({ created: false, revision: "8" })
      );

      const result = await edit("", "# Plan\r\n\r\nFirst draft.\n\n");
      expect(result.isOk() && result.value.replacements).toBe(1);
      expect(written(0).content).toBe(expected);
    }
  );

  it("refuses an empty old_string when the body has content", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored(SOURCE, "7"));

    const result = await edit("", "Replaced.");
    expect(result.isErr() && result.error.code).toBe("string_not_found");
    expect(writeCanonicalFileContent).not.toHaveBeenCalled();
  });

  it("counts a replacement's CRLF line breaks as written, normalized", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored(SOURCE, "7"));
    vi.mocked(writeCanonicalFileContent).mockResolvedValue(
      new Ok({ created: false, revision: "8" })
    );
    // 9,800 lines: over the codec's limit with CRLF (27 characters each), within it with LF (26).
    const replacement = ("a".repeat(25) + "\r\n").repeat(9_800);
    expect(replacement.length).toBeGreaterThan(INPUT_LIMITS.length);

    const result = await edit("Ship it", replacement);

    expect(result.isOk()).toBe(true);
  });

  it("refuses a whole body longer than the codec reads, writing nothing", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored("", "7"));

    // Exactly the limit: the line break written after the body would exceed it.
    const result = await edit("", "a".repeat(INPUT_LIMITS.length));

    expect(result.isErr() && result.error.code).toBe("too_large");
    expect(writeCanonicalFileContent).not.toHaveBeenCalled();
  });

  it("writes a whole body that fits once its trailing line break is dropped", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored("", "7"));
    vi.mocked(writeCanonicalFileContent).mockResolvedValue(
      new Ok({ created: false, revision: "8" })
    );

    const result = await edit("", "a".repeat(INPUT_LIMITS.length - 1) + "\n");

    expect(result.isOk()).toBe(true);
  });

  it("counts the source as written, not the stored file's extra line breaks", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored("a\n\n", "7"));
    vi.mocked(writeCanonicalFileContent).mockResolvedValue(
      new Ok({ created: false, revision: "8" })
    );

    // Written as the body and one line break: exactly the limit.
    const result = await edit("a", "b".repeat(INPUT_LIMITS.length - 1));

    expect(result.isOk()).toBe(true);
  });

  it("leaves the front matter out of the size, as the codec does", async () => {
    const body = "b" + "a".repeat(INPUT_LIMITS.length - 2);
    vi.mocked(readCanonicalFileContent).mockResolvedValue(
      stored(`---\ntitle: Notes\n---\n\n${body}\n`, "7")
    );
    vi.mocked(writeCanonicalFileContent).mockResolvedValue(
      new Ok({ created: false, revision: "8" })
    );

    // The body and its line break are exactly the limit; the front matter is not counted.
    const result = await edit("b", "c");

    expect(result.isOk()).toBe(true);
  });

  it("refuses an empty old_string expecting more than one replacement", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored("", "7"));

    const result = await edit("", "# Plan\n", 2);
    expect(result.isErr() && result.error.code).toBe("unexpected_count");
    expect(writeCanonicalFileContent).not.toHaveBeenCalled();
  });

  it("refuses when the number of occurrences differs from the expected one", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored(SOURCE, "7"));

    const result = await edit("i", "I");
    expect(result.isErr() && result.error.code).toBe("unexpected_count");
    expect(writeCanonicalFileContent).not.toHaveBeenCalled();
  });

  it("refuses a file whose storage returns no revision", async () => {
    vi.mocked(readCanonicalFileContent).mockResolvedValue(stored(SOURCE));

    const result = await edit("Ship it", "Ship");
    expect(result.isErr() && result.error.code).toBe("refused");
    expect(writeCanonicalFileContent).not.toHaveBeenCalled();
  });

  it("starts over from a fresh read when the file changed, never overwriting it", async () => {
    const edited = SOURCE.replace("# Spec", "# Spec v2");
    vi.mocked(readCanonicalFileContent)
      .mockResolvedValueOnce(stored(SOURCE, "7"))
      .mockResolvedValueOnce(stored(edited, "9"));
    vi.mocked(writeCanonicalFileContent)
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(new Ok({ created: false, revision: "10" }));

    expect((await edit("Ship it", "Ship")).isOk()).toBe(true);

    const { content, revision } = written(1);
    expect(revision).toBe("9");
    expect(content).toContain("# Spec v2\n\nShip :comment-start");
  });

  it("gives up after repeated conflicts", async () => {
    vi.mocked(readCanonicalFileContent).mockImplementation(async () =>
      stored(SOURCE, "7")
    );
    vi.mocked(writeCanonicalFileContent).mockResolvedValue(conflict());

    const result = await edit("Ship it", "Ship");
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(writeCanonicalFileContent).toHaveBeenCalledTimes(3);
  });
});

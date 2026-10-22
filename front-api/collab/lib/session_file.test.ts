import { openCollabAccess } from "@app/lib/api/collab/access";
import { readStoredText } from "@app/lib/api/documents/comment_signatures";
import { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import {
  WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES,
  WriteCanonicalFileContentError,
  writeCanonicalFileContent,
} from "@app/lib/api/files/file_system_ops";
import { runOnRedisCollab } from "@app/lib/api/redis";
import { writeConversationFile } from "@app/tests/utils/conversation_files";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import { writeUserFile } from "@app/tests/utils/user_files";
import {
  BODY_FRAGMENT_NAME,
  parseSessionName,
  toSessionName,
} from "@app/types/collab";
import { Err, Ok } from "@app/types/shared/result";
import {
  keepConflictingFile,
  loadCollabSession,
  saveCollabSession,
} from "@front-api/collab/lib/session_file";
import {
  fetchYDocState,
  storeYDocState,
} from "@front-api/collab/lib/ydoc_state";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("@app/lib/api/files/file_system_ops", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/files/file_system_ops")>();
  return {
    ...actual,
    writeCanonicalFileContent: vi.fn(actual.writeCanonicalFileContent),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function typeInto(content: { doc: Y.Doc }, text: string) {
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  const body = content.doc.getXmlFragment(BODY_FRAGMENT_NAME);
  body.insert(body.length, [paragraph]);
}

describe("live document names", () => {
  it("round trip a workspace and a path containing the separator", () => {
    const name = toSessionName("w1", "user-u1/notes:draft.md");
    expect(parseSessionName(name)).toEqual({
      workspaceId: "w1",
      canonicalPath: "user-u1/notes:draft.md",
    });
  });

  it("refuse a name without a workspace or a path", () => {
    expect(parseSessionName("user-u1/notes.md")).toBeNull();
    expect(parseSessionName(":user-u1/notes.md")).toBeNull();
    expect(parseSessionName("w1:")).toBeNull();
  });
});

describe("openCollabAccess and loadCollabSession", () => {
  it("open a conversation's Markdown file for writing and load its content", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const path = await writeConversationFile(
      auth,
      "notes.md",
      "# Notes\n\nHello.\n"
    );

    const file = await openCollabAccess(auth, path);
    expect(file.isOk()).toBe(true);
    if (!file.isOk()) {
      return;
    }
    expect(file.value.canWrite).toBe(true);

    const loaded = await loadCollabSession(file.value);
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(
        loaded.value.content.doc.getXmlFragment(BODY_FRAGMENT_NAME).toString()
      ).toContain("Hello.");
      expect(loaded.value.lastSave.source).toBe("# Notes\n\nHello.\n");
    }
  });

  it("open a .markdown file, as the editor does", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const path = await writeConversationFile(
      auth,
      "notes.markdown",
      "# Notes\n"
    );

    expect((await openCollabAccess(auth, path)).isOk()).toBe(true);
  });

  it("refuse a file that is not Markdown", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const path = await writeConversationFile(
      auth,
      "notes.txt",
      "Hello.\n",
      "text/plain"
    );

    expect((await openCollabAccess(auth, path)).isErr()).toBe(true);
  });

  it("refuse a path that is not normalized", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const path = await writeConversationFile(auth, "notes.md", "# Notes\n");
    const [scope, name] = path.split("/");

    expect((await openCollabAccess(auth, `${scope}/./${name}`)).isErr()).toBe(
      true
    );
    expect((await openCollabAccess(auth, path)).isOk()).toBe(true);
  });

  it("refuse a path with a trailing slash, which a backend may resolve to the file", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const path = await writeConversationFile(auth, "notes.md", "# Notes\n");
    vi.spyOn(DustFileSystem.prototype, "stat").mockResolvedValue(
      new Ok({ contentType: "text/markdown", sizeBytes: 8 })
    );

    expect((await openCollabAccess(auth, `${path}/`)).isErr()).toBe(true);
  });

  it("refuse a missing file", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const notes = await writeConversationFile(auth, "notes.md", "# Notes\n");
    const path = notes.replace(/notes\.md$/, "missing.md");
    fileStorageMock.setFileExists(
      (filePath) => !filePath.endsWith("missing.md")
    );

    expect((await openCollabAccess(auth, path)).isErr()).toBe(true);
  });

  it("refuse a directory named like a Markdown file", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const path = await writeConversationFile(auth, "notes.md", "# Notes\n");
    vi.spyOn(DustFileSystem.prototype, "stat").mockResolvedValue(
      new Ok({ contentType: "application/x-directory", sizeBytes: 0 })
    );

    expect((await openCollabAccess(auth, path)).isErr()).toBe(true);
  });

  it("refuse a file larger than the file API can write", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const path = await writeConversationFile(auth, "notes.md", "# Notes\n");
    vi.spyOn(DustFileSystem.prototype, "stat").mockResolvedValue(
      new Ok({
        contentType: "text/markdown",
        sizeBytes: WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES + 1,
      })
    );

    expect((await openCollabAccess(auth, path)).isErr()).toBe(true);
  });

  it("refuse another user's file", async () => {
    const { authenticator: owner } = await createResourceTest({});
    const { authenticator: other } = await createResourceTest({});
    const path = await writeConversationFile(owner, "notes.md", "# Notes\n");

    expect((await openCollabAccess(other, path)).isErr()).toBe(true);
  });

  it("refuse a user's own file, which the file API reads without a revision", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const path = await writeUserFile(auth, "notes.md", "# Notes\n");

    const file = await openCollabAccess(auth, path);

    expect(file.isErr() && file.error.code).toBe("unsupported_location");
  });

  it("fail to load a file read without a revision", async () => {
    const { authenticator: auth, workspace } = await createResourceTest({});
    const path = await writeUserFile(auth, "notes.md", "# Notes\n");
    const dustFs = await DustFileSystem.forUser(auth);
    if (dustFs.isErr()) {
      throw dustFs.error;
    }

    const loaded = await loadCollabSession({
      auth,
      workspaceId: workspace.sId,
      canonicalPath: path,
      dustFs: dustFs.value,
      canWrite: true,
    });

    expect(loaded.isErr()).toBe(true);
  });
});

describe("saveCollabSession", () => {
  async function loadFile(text: string) {
    const { authenticator: auth } = await createResourceTest({});
    const path = await writeConversationFile(auth, "notes.md", text);
    const file = await openCollabAccess(auth, path);
    if (file.isErr()) {
      throw new Error(file.error.message);
    }
    const loaded = await loadCollabSession(file.value);
    if (loaded.isErr()) {
      throw new Error(loaded.error);
    }
    vi.mocked(writeCanonicalFileContent).mockClear();
    return { auth, file: file.value, ...loaded.value };
  }

  it("does not write a document that has not changed", async () => {
    const { file, content, lastSave } = await loadFile("# Notes\n");

    const result = await saveCollabSession(file, content, lastSave);
    expect(result.isOk() && result.value).toEqual(lastSave);
    expect(writeCanonicalFileContent).not.toHaveBeenCalled();
  });

  it("writes an edit to the file", async () => {
    const { auth, file, content, lastSave } = await loadFile("# Notes\n");
    typeInto(content, "Edited.");

    const result = await saveCollabSession(file, content, lastSave);
    expect(result.isOk() && result.value.source).toContain("Edited.");

    const reopened = await openCollabAccess(auth, file.canonicalPath);
    expect(reopened.isOk()).toBe(true);
    if (reopened.isOk()) {
      const reloaded = await loadCollabSession(reopened.value);
      expect(reloaded.isOk() && reloaded.value.lastSave.source).toContain(
        "Edited."
      );
    }
  });

  it("writes conditional on the last revision and returns the new one", async () => {
    const { file, content, lastSave } = await loadFile("# Notes\n");
    typeInto(content, "Edited.");
    vi.mocked(writeCanonicalFileContent).mockResolvedValueOnce(
      new Ok({ created: false, revision: "8" })
    );

    const result = await saveCollabSession(file, content, {
      ...lastSave,
      revision: "7",
    });
    expect(result.isOk() && result.value.revision).toBe("8");
    expect(vi.mocked(writeCanonicalFileContent).mock.calls[0][5]).toBe("7");
  });

  it("fails when the file changed since its last revision", async () => {
    const { file, content, lastSave } = await loadFile("# Notes\n");
    typeInto(content, "Edited.");
    vi.mocked(writeCanonicalFileContent).mockResolvedValueOnce(
      new Err(
        new WriteCanonicalFileContentError("revision_conflict", "File changed.")
      )
    );

    const result = await saveCollabSession(file, content, {
      ...lastSave,
      revision: "7",
    });
    expect(result.isErr() && result.error.code).toBe("revision_conflict");
  });

  describe("keepConflictingFile", () => {
    const COPY_NAME =
      /notes \(conflict \d{4}-\d{2}-\d{2} \d{2}-\d{2}( \d)?\)\.md$/;

    // A conversation's file: the storage there keeps revisions, unlike a user's own files.
    async function loadConversationFile(text: string, name = "notes.md") {
      const { authenticator: auth } = await createResourceTest({});
      const path = await writeConversationFile(auth, name, text);
      const file = await openCollabAccess(auth, path);
      if (file.isErr()) {
        throw new Error(file.error.message);
      }
      const loaded = await loadCollabSession(file.value);
      if (loaded.isErr()) {
        throw new Error(loaded.error);
      }
      return { file: file.value, ...loaded.value };
    }

    // Straight to storage, around the session, the way a sandbox writes.
    async function writeAround(
      file: Awaited<ReturnType<typeof loadConversationFile>>["file"],
      text: string
    ) {
      const written = await file.dustFs.write(
        file.canonicalPath,
        text,
        "text/markdown"
      );
      if (written.isErr()) {
        throw written.error;
      }
    }

    async function readText(
      file: Awaited<ReturnType<typeof loadConversationFile>>["file"],
      path: string
    ) {
      const read = await file.dustFs.readBuffer(path);
      return read.isOk() && read.value ? read.value.toString("utf8") : null;
    }

    it("keeps the file's exact bytes next to it, then the session saves over it", async () => {
      const { file, content, lastSave } =
        await loadConversationFile("# Notes\n");
      typeInto(content, "Ours.");
      const theirs = "# Notes\n\nTheirs,  *spelled* their way.\n";
      await writeAround(file, theirs);

      const conflict = await saveCollabSession(file, content, lastSave);
      expect(conflict.isErr() && conflict.error.code).toBe("revision_conflict");

      const kept = await keepConflictingFile(file, lastSave);
      if (kept.isErr()) {
        throw kept.error;
      }
      const { copyPath } = kept.value;
      expect(copyPath).toMatch(COPY_NAME);
      expect(await readText(file, copyPath ?? "")).toBe(theirs);

      const saved = await saveCollabSession(file, content, kept.value.lastSave);
      expect(saved.isOk()).toBe(true);
      expect(await readText(file, file.canonicalPath)).toContain("Ours.");
    });

    it("keeps no copy when the file holds the same content", async () => {
      const { file, lastSave } = await loadConversationFile("# Notes\n");
      await writeAround(file, "# Notes\n");

      const writesBefore = fileStorageMock.saveFileCalls.length;

      const kept = await keepConflictingFile(file, lastSave);
      expect(kept.isOk() && kept.value.copyPath).toBeNull();
      expect(kept.isOk() && kept.value.lastSave.revision).not.toBe(
        lastSave.revision
      );
      expect(fileStorageMock.saveFileCalls).toHaveLength(writesBefore);
    });

    it("numbers a copy whose name is taken", async () => {
      const { file, lastSave } = await loadConversationFile("# Notes\n");
      await writeAround(file, "# Notes\n\nFirst.\n");
      const first = await keepConflictingFile(file, lastSave);
      await writeAround(file, "# Notes\n\nSecond.\n");
      const second = await keepConflictingFile(file, lastSave);

      const firstPath = first.isOk() ? first.value.copyPath : null;
      const secondPath = second.isOk() ? second.value.copyPath : null;
      expect(firstPath).toMatch(COPY_NAME);
      expect(secondPath).toMatch(COPY_NAME);
      expect(secondPath).not.toBe(firstPath);
      expect(await readText(file, firstPath ?? "")).toContain("First.");
    });

    it("keeps the raw text of a file the editor cannot open", async () => {
      const { file, lastSave } = await loadConversationFile("# Notes\n");
      const theirs = "# Notes\n\n- [ ] A task list the editor refuses\n";
      await writeAround(file, theirs);

      const kept = await keepConflictingFile(file, lastSave);
      if (kept.isErr()) {
        throw kept.error;
      }
      expect(kept.value.lastSave.source).toBe(theirs);
      expect(await readText(file, kept.value.copyPath ?? "")).toBe(theirs);
    });

    it("keeps the copy in the file's own folder", async () => {
      const { file, lastSave } = await loadConversationFile(
        "# Notes\n",
        "plans/notes.md"
      );
      await writeAround(file, "# Notes\n\nTheirs.\n");

      const kept = await keepConflictingFile(file, lastSave);
      const copyPath = kept.isOk() ? kept.value.copyPath : null;
      expect(copyPath).toMatch(/\/plans\/notes \(conflict [^/]+\)\.md$/);
    });

    it("fails without a copy when the file is larger than a save can write", async () => {
      const { file, lastSave } = await loadConversationFile("# Notes\n");
      await writeAround(
        file,
        "a".repeat(WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES + 1)
      );

      const writesBefore = fileStorageMock.saveFileCalls.length;

      const kept = await keepConflictingFile(file, lastSave);
      expect(kept.isErr()).toBe(true);
      expect(fileStorageMock.saveFileCalls).toHaveLength(writesBefore);
    });

    it("fails without writing anything when the file was deleted", async () => {
      const { file, lastSave } = await loadConversationFile("# Notes\n");
      const deleted = await file.dustFs.delete(file.canonicalPath);
      expect(deleted.isOk()).toBe(true);

      const writesBefore = fileStorageMock.saveFileCalls.length;

      const kept = await keepConflictingFile(file, lastSave);
      expect(kept.isErr()).toBe(true);
      expect(fileStorageMock.saveFileCalls).toHaveLength(writesBefore);
    });
  });
});

describe("loadCollabSession with the stored Yjs state", () => {
  // A conversation's file: the storage there keeps revisions, unlike a user's own files.
  async function openConversationFile(text: string) {
    const { authenticator: auth } = await createResourceTest({});
    const path = await writeConversationFile(auth, "notes.md", text);
    const file = await openCollabAccess(auth, path);
    if (file.isErr()) {
      throw new Error(file.error.message);
    }
    return file.value;
  }

  type ConversationFile = Awaited<ReturnType<typeof openConversationFile>>;

  async function load(file: ConversationFile) {
    const loaded = await loadCollabSession(file);
    if (loaded.isErr()) {
      throw new Error(loaded.error);
    }
    return loaded.value;
  }

  /** Stores a load's document as the session does once loaded. */
  async function storeLoaded(
    file: ConversationFile,
    { epoch, lastSave, content }: Awaited<ReturnType<typeof load>>
  ) {
    const stored = await storeYDocState(
      toSessionName(file.workspaceId, file.canonicalPath),
      { epoch, revision: lastSave.revision, ...content }
    );
    expect(stored.isOk()).toBe(true);
  }

  async function rewrite(file: ConversationFile, text: string) {
    const written = await file.dustFs.write(
      file.canonicalPath,
      text,
      "text/markdown"
    );
    if (written.isErr()) {
      throw written.error;
    }
  }

  const bodyOf = (doc: Y.Doc) =>
    doc.getXmlFragment(BODY_FRAGMENT_NAME).toString();

  it("keeps the Yjs ids and the epoch from one load to the next while the file is unchanged", async () => {
    const file = await openConversationFile("# Notes\n\nHello.\n");
    const first = await load(file);
    await storeLoaded(file, first);

    const second = await load(file);

    expect(second.epoch).toBe(first.epoch);
    expect(Y.encodeStateVector(second.content.doc)).toEqual(
      Y.encodeStateVector(first.content.doc)
    );
    expect(second.hasUnsavedEdits).toBe(false);
    expect(second.shouldStoreState).toBe(false);
  });

  it("reuses the stored state when the file has its content under a newer revision", async () => {
    const text = "# Notes\n\nHello.\n";
    const file = await openConversationFile(text);
    const first = await load(file);
    await storeLoaded(file, first);
    // As a save the process stopped before storing the state after.
    await rewrite(file, text);

    const second = await load(file);

    expect(second.lastSave.revision).not.toBe(first.lastSave.revision);
    expect(second.epoch).toBe(first.epoch);
    expect(Y.encodeStateVector(second.content.doc)).toEqual(
      Y.encodeStateVector(first.content.doc)
    );
    expect(second.hasUnsavedEdits).toBe(false);
    expect(second.shouldStoreState).toBe(true);
  });

  it("reloads the edits the file lacks, the last save staying the file's", async () => {
    const file = await openConversationFile("# Notes\n");
    const first = await load(file);
    typeInto(first.content, "Not saved.");
    await storeLoaded(file, first);

    const second = await load(file);

    expect(second.epoch).toBe(first.epoch);
    expect(bodyOf(second.content.doc)).toContain("Not saved.");
    expect(second.hasUnsavedEdits).toBe(true);
    expect(second.lastSave).toEqual(first.lastSave);
    expect(second.shouldStoreState).toBe(false);
  });

  it("reloads the stored state over a file the editor cannot load, as edits the file lacks", async () => {
    const file = await openConversationFile("# Notes\n");
    const first = await load(file);
    const theirs = "# Notes\n\n<div>HTML the editor refuses</div>\n";
    await rewrite(file, theirs);
    const read = await readStoredText(file.dustFs, file.canonicalPath);
    const revision = read.isOk() ? read.value?.revision : undefined;
    if (revision === undefined) {
      throw new Error("A conversation's file has revisions.");
    }
    // As a save failing after a conflict kept that file stores the session's state.
    await storeYDocState(toSessionName(file.workspaceId, file.canonicalPath), {
      epoch: first.epoch,
      revision,
      ...first.content,
    });

    const second = await load(file);

    expect(second.epoch).toBe(first.epoch);
    expect(second.lastSave).toEqual({ revision, source: theirs });
    expect(second.hasUnsavedEdits).toBe(true);
  });

  it("builds the document from the file with a new epoch, asking to store it, once the file changed", async () => {
    const file = await openConversationFile("# Notes\n");
    const first = await load(file);
    await storeLoaded(file, first);
    await rewrite(file, "# Notes\n\nTheirs.\n");

    const second = await load(file);

    expect(second.epoch).not.toBe(first.epoch);
    expect(bodyOf(second.content.doc)).toContain("Theirs.");
    expect(second.hasUnsavedEdits).toBe(false);
    expect(second.shouldStoreState).toBe(true);
  });

  it("stores nothing itself", async () => {
    const file = await openConversationFile("# Notes\n\nHello.\n");

    const loaded = await load(file);

    expect(loaded.shouldStoreState).toBe(true);
    const stored = await fetchYDocState(
      toSessionName(file.workspaceId, file.canonicalPath)
    );
    expect(stored.isOk() && stored.value).toBeNull();
  });

  it("loads from the file when Redis fails, without asking to store its state", async () => {
    const file = await openConversationFile("# Notes\n\nHello.\n");
    vi.mocked(runOnRedisCollab).mockRejectedValueOnce(
      new Error("Redis is down.")
    );

    const loaded = await load(file);

    expect(bodyOf(loaded.content.doc)).toContain("Hello.");
    expect(loaded.hasUnsavedEdits).toBe(false);
    expect(loaded.shouldStoreState).toBe(false);
  });
});

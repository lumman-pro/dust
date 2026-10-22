import path from "node:path";
import type { CollabAccess } from "@app/lib/api/collab/access";
import type { SessionContent } from "@app/lib/api/collab/ydoc";
import { dfmToYDoc, yDocToDfm } from "@app/lib/api/collab/ydoc";
import { readStoredText } from "@app/lib/api/documents/comment_signatures";
import { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import {
  WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES,
  readCanonicalFileContent,
  writeCanonicalFileContent,
} from "@app/lib/api/files/file_system_ops";
import {
  ABSENT_FILE_REVISION,
  writeFileWithRevision,
} from "@app/lib/api/files/revisions";
import { decodeBuffer } from "@app/lib/api/files/utils";
import { streamToBoundedBuffer } from "@app/lib/utils/streams";
import logger from "@app/logger/logger";
import { toSessionName } from "@app/types/collab";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { fetchYDocState, newYDocEpoch } from "@front-api/collab/lib/ydoc_state";

/** The file as the session last read or saved it. */
export interface CollabSave {
  revision: string;
  source: string;
}

export interface LoadedCollabSession {
  content: SessionContent;
  lastSave: CollabSave;
  epoch: string;
  hasUnsavedEdits: boolean;
  shouldStoreState: boolean;
}

function readSessionText(
  text: string
): Result<{ content: SessionContent; source: string }, string> {
  const content = dfmToYDoc(text);
  if (content.isErr()) {
    return content;
  }
  const source = yDocToDfm(content.value);
  return source.isErr()
    ? source
    : new Ok({ content: content.value, source: source.value });
}

/**
 * @cc [owner:PopDaph;tdraier,label:product;concurrency] collab-session-load
 * The save returned MUST carry the revision of the bytes read, and as source what `yDocToDfm`
 * gives for the document those bytes load, so a load alone never counts as a change, or the text
 * read when the editor cannot load them and the stored state is returned. A read without a
 * revision MUST fail the load, since none of the session's saves could be conditional.
 */
/**
 * @cc [owner:PopDaph;tdraier,label:product;concurrency] collab-session-load-state
 * When `yDocToDfm` accepts the Yjs state stored for the file (`fetchYDocState`) and that state
 * continues from the revision read, or gives the source of the returned save, the load MUST return
 * that state's document, threads and epoch, so its Yjs ids survive a reload, even when the editor
 * cannot load the bytes read, with `hasUnsavedEdits` when `yDocToDfm` gives it another source than
 * the returned save's. Otherwise the document MUST be built from the bytes read, with a new epoch
 * and no unsaved edits. `shouldStoreState` MUST be set when the fetch did not fail and no state
 * was stored at that revision. A state that cannot be fetched MUST only be logged: the load then
 * goes on from the bytes read. The load MUST NOT store anything.
 */
export async function loadCollabSession({
  dustFs,
  canonicalPath,
  workspaceId,
}: CollabAccess): Promise<Result<LoadedCollabSession, string>> {
  const read = await readStoredText(dustFs, canonicalPath);
  if (read.isErr()) {
    return new Err(read.error.message);
  }
  if (read.value === null) {
    return new Err("File not found.");
  }

  const { text, revision } = read.value;
  if (revision === undefined) {
    return new Err("This file's storage does not support revisions.");
  }
  const fromFile = readSessionText(text);

  const documentName = toSessionName(workspaceId, canonicalPath);
  const stored = await fetchYDocState(documentName);
  if (stored.isErr()) {
    logger.warn(
      { err: stored.error, documentName, workspaceId },
      "Collab document state not fetched"
    );
  } else if (stored.value) {
    const storedSource = yDocToDfm(stored.value);
    // A file the editor cannot load stands as its text, as a save conflict keeps it: the state
    // then holds the session's edits over it.
    const source = fromFile.isOk() ? fromFile.value.source : text;
    // The state's own revision is older when the process stopped between the file's save and its.
    if (
      storedSource.isOk() &&
      (stored.value.revision === revision || storedSource.value === source)
    ) {
      const { doc, comments, epoch } = stored.value;
      return new Ok({
        content: { doc, comments },
        lastSave: { revision, source },
        epoch,
        hasUnsavedEdits: storedSource.value !== source,
        shouldStoreState: stored.value.revision !== revision,
      });
    }
  }
  if (fromFile.isErr()) {
    return fromFile;
  }

  return new Ok({
    content: fromFile.value.content,
    lastSave: { revision, source: fromFile.value.source },
    epoch: newYDocEpoch(),
    hasUnsavedEdits: false,
    // A state that could not be fetched may hold edits the file lacks: storing would replace it.
    shouldStoreState: stored.isOk(),
  });
}

/** Why a save failed: `revision_conflict` when something else wrote the file since the last save. */
export type CollabSaveErrorCode = "revision_conflict" | "failed";

export class CollabSaveError extends Error {
  constructor(
    readonly code: CollabSaveErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CollabSaveError";
  }
}

/**
 * @cc [owner:PopDaph;tdraier,label:product;concurrency] collab-session-save
 * The save MUST write `yDocToDfm` of the session, its threads included, only when it
 * differs from `last.source`, and conditional on `last.revision`: a file changed since then MUST
 * be left unchanged and the save MUST fail. It MUST return the file as now stored: `last` when
 * nothing was written, otherwise the written source and its revision. A write refused because the
 * file changed since `last.revision` MUST fail with `revision_conflict`, any other failure with
 * `failed`.
 */
export async function saveCollabSession(
  { auth, dustFs, canonicalPath }: CollabAccess,
  content: SessionContent,
  last: CollabSave
): Promise<Result<CollabSave, CollabSaveError>> {
  const source = yDocToDfm(content);
  if (source.isErr()) {
    return new Err(new CollabSaveError("failed", source.error));
  }
  if (source.value === last.source) {
    return new Ok(last);
  }

  // TODO(co-edition): it decodes the source back from the buffer and stats the file again, on
  // every save.
  const written = await writeCanonicalFileContent(
    auth,
    dustFs,
    canonicalPath,
    Buffer.from(source.value, "utf8"),
    undefined,
    last.revision
  );
  if (written.isErr()) {
    return new Err(
      new CollabSaveError(
        written.error.code === "revision_conflict"
          ? "revision_conflict"
          : "failed",
        written.error.message
      )
    );
  }
  const { revision } = written.value;
  if (revision === undefined) {
    return new Err(
      new CollabSaveError("failed", "The file was written without a revision.")
    );
  }
  return new Ok({ revision, source: source.value });
}

// A name taken by another copy made in the same minute gets a number: past this many, give up.
const MAX_CONFLICT_COPY_NAMES = 5;

/** `notes (conflict 2026-10-14 14-05).md`, numbered from the second: `… 14-05 2).md`. */
function conflictCopyPath(filePath: string, date: Date, index: number): string {
  const { dir, name, ext } = path.posix.parse(filePath);
  const stamp = date
    .toISOString()
    .slice(0, 16)
    .replace("T", " ")
    .replace(":", "-");
  const number = index === 0 ? "" : ` ${index + 1}`;
  return path.posix.join(dir, `${name} (conflict ${stamp}${number})${ext}`);
}

/**
 * @cc [owner:PopDaph,label:product;concurrency;security] collab-session-conflict-copy
 * After a save refused with `revision_conflict`, the file as now stored MUST be kept before
 * anything overwrites it: when its content, read through the codec when the codec accepts it,
 * differs from `last.source`, its exact bytes MUST be written next to it under a new name, only
 * where no file exists, with `file`'s access. It MUST then return the file as now stored, its
 * revision and that content, as the session's new last save, and the copy's path, or none when
 * the content was the same. A file gone, unreadable, larger than the write limit, or on storage
 * without revisions MUST fail without writing anything, and so MUST a copy that cannot be written.
 */
export async function keepConflictingFile(
  { dustFs, canonicalPath }: CollabAccess,
  last: CollabSave
): Promise<Result<{ lastSave: CollabSave; copyPath: string | null }, Error>> {
  const read = await readCanonicalFileContent(dustFs, canonicalPath);
  if (read.isErr()) {
    return new Err(read.error);
  }
  if (!read.value) {
    return new Err(new Error("The file was deleted while it was open."));
  }
  const { revision } = read.value;
  if (revision === undefined) {
    read.value.stream.on("error", () => undefined).destroy();
    return new Err(
      new Error("This file's storage does not support revisions.")
    );
  }
  const bytes = await streamToBoundedBuffer(
    read.value.stream,
    WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES
  );
  if (bytes.isErr()) {
    return new Err(new Error(bytes.error));
  }
  if (!bytes.value) {
    return new Err(
      new Error("The file is larger than a live document can save.")
    );
  }

  // Read through the codec, the way the session saves, so the same Markdown spelled differently
  // counts as the same.
  const text = decodeBuffer(bytes.value);
  const loaded = dfmToYDoc(text);
  const normalized = loaded.isOk() ? yDocToDfm(loaded.value) : null;
  const source = normalized?.isOk() ? normalized.value : text;
  const lastSave = { revision, source };
  if (source === last.source) {
    return new Ok({ lastSave, copyPath: null });
  }

  const date = new Date();
  // Every candidate name is in the file's own folder: one access check covers them all.
  const writable = dustFs.checkWriteAccess(
    conflictCopyPath(canonicalPath, date, 0)
  );
  if (writable.isErr()) {
    return new Err(writable.error);
  }
  for (let index = 0; index < MAX_CONFLICT_COPY_NAMES; index++) {
    const copyPath = conflictCopyPath(canonicalPath, date, index);
    const normalizedCopyPath = DustFileSystem.normalizeScopedPath(copyPath);
    const copyStoragePath =
      normalizedCopyPath && dustFs.toMountFilePath(normalizedCopyPath);
    if (!copyStoragePath) {
      return new Err(
        new Error("This file's storage does not support revisions.")
      );
    }
    const written = await writeFileWithRevision(copyStoragePath, {
      content: bytes.value,
      contentType: read.value.contentType,
      revision: ABSENT_FILE_REVISION,
    });
    if (written.isOk()) {
      return new Ok({ lastSave, copyPath });
    }
    if (written.error !== "conflict") {
      return new Err(written.error);
    }
  }
  return new Err(new Error("Every name for the copy is taken."));
}

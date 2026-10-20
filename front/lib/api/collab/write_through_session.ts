import {
  editCollabSource,
  readCollabSource,
  writeCollabSource,
} from "@app/lib/api/collab/client";
import type { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import type { Authenticator } from "@app/lib/auth";
import type { CollabAgent } from "@app/types/collab";
import type {
  CollabEditRefusalCode,
  CollabSourceEdit,
} from "@app/types/collab_internal";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";

const MAX_SESSION_WRITE_ATTEMPTS = 3;

const UNSAVED_MESSAGE =
  "This file's live session cannot save it right now, so it takes no changes. Try again later.";

export type CollabSessionWriteErrorCode =
  | "read_only"
  | "refused"
  | "conflict"
  | "unavailable";

export class CollabSessionWriteError extends Error {
  constructor(
    readonly code: CollabSessionWriteErrorCode,
    message: string
  ) {
    super(message);
  }
}

export function isCollabSessionWriteError(
  error: unknown
): error is CollabSessionWriteError {
  return error instanceof CollabSessionWriteError;
}

export type CollabSessionWrite<T> =
  | { kind: "no_session" }
  | { kind: "written"; value: T };

/**
 * @cc [owner:PopDaph,label:product;concurrency;security] collab-session-write
 * Every write of a file through its live session MUST go through this function, or
 * `editThroughCollabSession` for an agent's find-and-replace. While a session
 * holds `filePath`, `dustFs` MUST be able to write it, else `read_only`; `change` MUST receive the
 * session's source and its result MUST be pushed conditional on that source, starting over from a
 * fresh read when the session changed or was busy, and failing with `conflict` after
 * `MAX_SESSION_WRITE_ATTEMPTS`, or at once with `unavailable` when the session cannot save
 * (`unsaved`). Without a session, or once it closed, it MUST write nothing and
 * answer `no_session`, so the caller writes the file. Failing to learn whether a session is open
 * MUST be an error, never `no_session`, since the caller would then write the file under an open
 * session. `filePath` MUST be the normalized path without a trailing slash, the only one a live
 * document is named after (`collab-access-open`). With `agent`, the session's editors see the
 * reads and the edit as that agent's.
 *
 * Known gap until the per-file lock of LIVE_SESSION.md: a session opening between the check and
 * the caller's file write misses the write, and its checkpoints conflict with it.
 */
export async function writeThroughCollabSession<T, E extends Error>(
  auth: Authenticator,
  dustFs: DustFileSystem,
  {
    filePath,
    change,
    agent,
  }: {
    filePath: string;
    change: (
      source: string
    ) => Promise<Result<{ source: string; value: T }, E>>;
    agent?: CollabAgent;
  }
): Promise<Result<CollabSessionWrite<T>, CollabSessionWriteError | E>> {
  for (let attempt = 0; attempt < MAX_SESSION_WRITE_ATTEMPTS; attempt++) {
    const live = await readCollabSource(auth, filePath, agent);
    if (live.isErr()) {
      return new Err(
        new CollabSessionWriteError(live.error.code, live.error.message)
      );
    }
    if (!live.value.open) {
      return new Ok({ kind: "no_session" });
    }
    const writable = dustFs.checkWriteAccess(filePath);
    if (writable.isErr()) {
      return new Err(
        new CollabSessionWriteError("read_only", writable.error.message)
      );
    }
    const changed = await change(live.value.source);
    if (changed.isErr()) {
      return changed;
    }

    const pushed = await writeCollabSource(auth, {
      canonicalPath: filePath,
      base: live.value.source,
      source: changed.value.source,
      agent,
    });
    if (pushed.isErr()) {
      return new Err(
        new CollabSessionWriteError(pushed.error.code, pushed.error.message)
      );
    }
    switch (pushed.value) {
      case "written":
        return new Ok({ kind: "written", value: changed.value.value });
      case "closed":
        return new Ok({ kind: "no_session" });
      case "changed":
      case "busy":
        continue;
      case "unsaved":
        return new Err(
          new CollabSessionWriteError("unavailable", UNSAVED_MESSAGE)
        );
      default:
        assertNever(pushed.value);
    }
  }

  return new Err(
    new CollabSessionWriteError(
      "conflict",
      "The file kept changing in its live session. Read it again and retry."
    )
  );
}

export type CollabSessionEdit =
  | CollabSessionWrite<{ replacements: number }>
  | { kind: "edit_refused"; code: CollabEditRefusalCode; message: string };

/**
 * @cc [owner:PopDaph,label:product;concurrency;security] collab-session-edit
 * While a session holds `filePath`, `dustFs` MUST be able to write it, else `read_only`, and
 * `beforeEdit` MUST pass before `edit` is sent; the session then applies `edit` to its source at
 * its turn, so changes made meanwhile do not refuse it. An edit MUST be sent again only when the
 * session answered that it applied nothing (`busy`), up to `MAX_SESSION_WRITE_ATTEMPTS`, then fail
 * with `unavailable`; any other failure MUST NOT be retried, since the edit may have applied. An
 * edit whose text does not match the session's source MUST answer `edit_refused` with its reason.
 * Without a session, or once it closed, it MUST write nothing and answer `no_session`, and failing
 * to learn whether a session is open MUST be an error, as for `writeThroughCollabSession`.
 */
export async function editThroughCollabSession<E extends Error>(
  auth: Authenticator,
  dustFs: DustFileSystem,
  {
    filePath,
    edit,
    agent,
    beforeEdit,
  }: {
    filePath: string;
    edit: CollabSourceEdit;
    agent?: CollabAgent;
    beforeEdit: () => Promise<Result<void, E>>;
  }
): Promise<Result<CollabSessionEdit, CollabSessionWriteError | E>> {
  // Without a session, the read answers at once, before any access check: most edits find none.
  const live = await readCollabSource(auth, filePath, agent);
  if (live.isErr()) {
    return new Err(
      new CollabSessionWriteError(live.error.code, live.error.message)
    );
  }
  if (!live.value.open) {
    return new Ok({ kind: "no_session" });
  }
  const writable = dustFs.checkWriteAccess(filePath);
  if (writable.isErr()) {
    return new Err(
      new CollabSessionWriteError("read_only", writable.error.message)
    );
  }
  const ready = await beforeEdit();
  if (ready.isErr()) {
    return ready;
  }

  for (let attempt = 0; attempt < MAX_SESSION_WRITE_ATTEMPTS; attempt++) {
    const edited = await editCollabSource(auth, {
      canonicalPath: filePath,
      edit,
      agent,
    });
    if (edited.isErr()) {
      return new Err(
        new CollabSessionWriteError(edited.error.code, edited.error.message)
      );
    }
    const answer = edited.value;
    switch (answer.result) {
      case "written":
        return new Ok({
          kind: "written",
          value: { replacements: answer.replacements },
        });
      case "edit_refused":
        return new Ok({
          kind: "edit_refused",
          code: answer.code,
          message: answer.message,
        });
      case "closed":
        return new Ok({ kind: "no_session" });
      case "busy":
        continue;
      case "unsaved":
        return new Err(
          new CollabSessionWriteError("unavailable", UNSAVED_MESSAGE)
        );
      default:
        assertNever(answer);
    }
  }

  return new Err(
    new CollabSessionWriteError(
      "unavailable",
      "This file's live session is too busy to take the change. Try again in a moment."
    )
  );
}

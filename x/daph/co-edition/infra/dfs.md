# DFS

[DFS](../../../../dfs/design-docs/INDEX.md) is the FoundationDB-backed filesystem meant to replace GCS
for files and gcsfuse in sandboxes. It is not deployed yet.

## What it would change for co-edition

- **Stable file ids**: a file keeps its id across renames and moves. Sessions can key on it, so a
  rename keeps the session, and a file deleted then recreated is a new file.
- **One way in**: every write goes through the DFS server, sandboxes included. Today files are
  written through several paths, one of them a direct GCS mount in the sandbox, so we can only detect
  outside writes.
- **Blocking outside writes is not there yet.** Grants are not a lock: an ALLOW on the file itself
  overrides a DENY, and moves are authorized on the parent folders
  ([API.md](../../../../dfs/design-docs/API.md#authorization-and-common-limits)). A refused sandbox
  write would also only surface at the next `fsync`.
- **The live state stays in GCS for now**: one object per document fits our needs, and DFS has no
  conditional write yet.

## Asks

- **A version check on writes**: "write only if `content_version` is N". The write operation has no
  such field today ([API.md](../../../../dfs/design-docs/API.md#write-operation)). It is what makes a
  checkpoint safe.
- **Idempotent `Apply` across requests**: today "the request has no idempotency key"
  ([API.md](../../../../dfs/design-docs/API.md#apply)). The receipts merged in #35296 cover retries
  within one call; `Apply` integration is a follow-up.
- **A session lock**: exclusive write access to a file for one session, released if the holder
  crashes, with defined behavior for moves of its parent folders.
- **Change notifications** per folder, or we keep polling `Stat`.
- **A clear error for agents** when a sandbox write is refused, pointing to `edit_document`.

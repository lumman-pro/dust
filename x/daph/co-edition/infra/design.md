# Design

What a user, an agent or an operator can rely on:

1. **One history per document.** Only the current owner can store to it; a pod that lost a document
   stores and acknowledges nothing more. Serving is exclusive on a best-effort basis: an old owner
   can keep its sockets for a few seconds after a takeover.
2. **Acknowledged means stored.** An edit is saved when a `stored` message covers it; a comment or
   an agent write when its receipt is stored.
3. **Moves lose nothing.** A browser keeps every edit no `stored` message covers and resends it to
   the next owner. If the epoch changed, it offers the edits for recovery instead.
4. **Outside writes are kept.** When a session finds the `.md` changed by someone else, it keeps its
   own content and the version it found.

Not covered: edits not yet written to the tab's journal when the tab dies; intermediate versions
overwritten between two checks of the file; blocking outside writes (only with DFS, if at all).

## Terms

- **Document key**: today's session name, the workspace sId and the file's canonical path
  (`front/types/collab.ts`). With DFS, the file's id.
- **Epoch**: an id for one Yjs history. It changes only when the state is rebuilt from the `.md`.
- **Snapshot**: a Yjs snapshot, which says exactly which edits a state covers (insertions and
  deletions).
- **Pod incarnation**: a random id a collab process picks when it starts.
- **Owner token**: a number that grows by one each time a pod takes a document.
- **Hint**: a Redis key with a TTL, used for routing and liveness only.
- **Ticket**: the single-use token a browser gets from front before connecting
  (`front/lib/api/collab/tickets.ts`).
- **Receipt**: the stored result of a command, found again by its operation id.
- **Intent**: a planned write to a file, stored before the write.
- **Revision**: the GCS object generation (`front/lib/api/files/revisions.ts`).

## Values

| Value | Why |
|---|---|
| Store 1 s after the last edit, and at most 10 s after the first unstored one | Short "saved" after a pause; today it is 5 s and 30 s |
| At most one write per second per state object | GCS's limit per object |
| Checkpoint every 5 min while edited, and on close | Bounds how old the `.md` is |
| Close 5 min after the last client left | Today's grace period, so a reload rejoins the same session |
| Hints: TTL 15 s, refreshed every 3 s | A crashed owner is replaced within about 15 s |
| Outside write check every 30 s | Bounds how long a session ignores a write by someone else |
| Drain 150 s within a 180 s termination grace | Today's preStop: the load balancer takes 72 to 75 s to stop sending connections |
| Drain 10 documents at a time | Spreads takeovers on the other pods |
| Takeovers: at most 20 per second per pod | A Redis restart does not stampede GCS |
| Receipts kept 7 days | Longer than any agent or browser retry |
| Sweeper every 5 min | Picks up abandoned documents and expired records |
| `.md` up to 512 KiB | Today's file write limit |
| Yjs state up to 2 MiB, 1 MiB at open | Keeps a full rewrite per store cheap |
| State object up to 4 MiB | Yjs state, threads (256 KiB), receipts (10,000), pending mentions (100) |
| Messages up to 4 MiB | A reconnect sends all missing edits at once |

## The state object

One GCS object per recently opened document, in a `collab-state` bucket per region, at
`<workspace sId>/<document key hash>`, with the default 7 day soft delete (see
[options.md](options.md#gcs-costs)). It holds:

- the lifecycle status, the epoch, the owner (incarnation and token), a write sequence;
- the Yjs state and its snapshot;
- comment threads, receipts, pending mention notifications;
- the `.md` records: the revision the next `.md` write must match, the revision holding our last
  checkpoint, and at most one pending intent with its exact bytes.

**Every write is conditional on the revision the pod last wrote or read**, and carries its full
identity (owner token, previous and new sequence, hash). The protocol appendix lists how each outcome
is handled.

**Lifecycle**: `initializing` (created by the first owner), `active` (holds the Yjs state),
`closed` (checkpointed, Yjs state dropped, receipts kept), `refused` (the editor cannot open the file),
then deleted by the sweeper. See the appendix.

## Ownership

- **Hints** live on the shared front Redis: which pods are alive (with their version and whether they
  drain), which pod owns which document. Updates and deletes compare the owner token, so a stale pod
  cannot overwrite or remove the current owner's hint. A missing hint means "ask the object", never
  "nobody owns it".
- **Taking a document**: write the object with the next owner token, then set the hint. If another pod
  still believed it was the owner, its next write fails and it drops the document.
- **Staying owner**: a pod drops a document when its write is refused, or when the hint names another
  owner. A pod that was paused longer than the hint TTL rereads each of its objects before serving
  again. If Redis is unreachable, open documents keep working; the GCS condition still protects them.
- **One queue per document** in the pod, across all its connections and internal calls: every message
  waits for the previous one to be applied (Hocuspocus only orders messages per connection). Stores,
  commands, checkpoints and release also go through it.

## Edits

- The owner stores the full state 1 s after the last edit, and at most 10 s after the first unstored
  one.
- After a store succeeds, the owner sends `stored { epoch, seq, snapshot }` in the existing
  `save_state` message. It is sent again to anyone who connects.
- Hocuspocus's own sync acknowledgements only mean "applied in memory" and are not used for "saved"
  (today's status icon uses them).

## Browsers

- **Journal per tab** in IndexedDB, keyed by workspace, user, document, epoch and tab: a base state
  plus every update applied since, local and remote, so the tab's version can always be rebuilt. One
  journal per tab, rather than `y-indexeddb`'s shared store, so a tab never prunes another tab's
  unsaved edits. The tab asks for persistent storage (`navigator.storage.persist()`); if the journal
  is lost, the tab says so.
- **Saving…** shows until every local edit, journaled or not, is covered by a `stored` message.
- **Connecting**: a tab with a journal sends its epoch with the ticket; the server refuses a different
  epoch before applying anything. A tab without one connects without an epoch, stays read-only until
  the first `stored` message gives it one, then starts its journal.
- **Epoch changed**: no uncovered edits, start over. Uncovered edits: show the old version to copy,
  keep it until dismissed. Never merged into the new history.
- **Closed or crashed tabs**: on the next load, one tab of the same user in the same workspace takes
  over their journals.
- **Logout**: open tabs stop journaling, then the user's journals are deleted.
- **Refused update** (over a limit): the tab stops sending, keeps its journal, and offers the document
  for download.
- **Protocol version**: the client sends it with the ticket. Servers accept the current and previous
  versions during a rollout.

## Comments and agent writes

- Every command has an **operation id**, kept across retries: a UUIDv7 made by the client for a
  comment, the agent action's id for an agent write. Its age comes from the server: the first time the
  owner sees the id for a comment, the agent action's `createdAt` for an agent write. A retry returns
  the stored receipt instead of running again. Receipts are kept 7 days and survive an epoch change. A
  reused id with another author, document or kind is refused.
- **Stored before shown**: the owner applies the command to a copy of the current document, stores
  the result with the receipt, then applies that exact update to the live document. Commands for a
  document run one at a time; those that arrive while a store is running share the next write.
- **Mentions** are stored with the command and sent after, with the operation id as the workflow id,
  so a second send is a no-op. A document closes only once its mentions are sent.
- **Receipts first, then the path**: a caller looks up the receipt in the state object before choosing
  between the session and a direct file write, so a command retried after its session closed is not
  applied twice. A command first run as a direct write (no session) has no receipt, as today.

## The `.md` file

- **Between sessions** the file is the source of truth.
- **Checkpoints**: every `.md` write is preceded by an intent in the state object (destination,
  expected revision, exact bytes). Only one intent is pending at a time, and a new owner settles it
  before doing any other file work, by retrying the same conditional write. So a write from a pod that
  lost the document lands at most once, as the planned checkpoint, and nothing is written over it.
- **Outside writes**: the owner checks the file's revision every 30 s and before each checkpoint. A
  version it did not write is copied, read at that exact revision, to `name (conflict …).md`; once the
  copy is confirmed, the session's next checkpoint replaces the file with its own content.
- **Deleted file**: the session becomes read-only and its content is saved as
  `name (recovered …).md`. Saving it needs no access to the old path.

## Routing

- **Browsers** connect to `/api/collab/d/<document key hash>`. The receiving pod looks up the owner
  hint:
  - itself, not draining: serves;
  - another pod: forwards the raw connection to that pod's internal port, signed with
    `COLLAB_INTERNAL_SECRET` for that document and that pod incarnation. The target never forwards
    again; if it is no longer the owner, it closes and the browser reconnects;
  - none: picks a pod by rendezvous hashing among pods that are on the current version, not draining
    and under their limits, then the next one in that order if it refuses.
- **The owner redeems the ticket**, never a forwarding pod, and refuses a connection for a document
  other than the one in its URL.
- **Internal calls** from front (agent writes, `files__cat`, the file API) carry the end user, as today,
  and go to any pod, which forwards them to the owner. The state object's status decides: `initializing`
  or `active`, take the document if nobody owns it; `closed`, absent or `refused`, the caller uses the
  file directly. A refused or timed-out call is an error, never "no session". This lands in M1.

## Limits

- A session opens only for a file the editor accepts, under 512 KiB, with an initial state under 1 MiB.
- Queued bytes per connection are counted before Hocuspocus sees them; slow clients are closed.
- An update that would push the Yjs state over 2 MiB is refused before it is applied. If the history
  is large while the text is small, the owner starts a new epoch from a checkpoint once every connected
  tab is fully acknowledged.
- Receipts, threads and mentions have their own caps; a full receipt table refuses new commands until
  old ones expire.
- Over the 512 KiB Markdown limit, edits are still stored but the checkpoint waits; the editor asks to
  shorten the document or download it.
- Per workspace, a cap on documents owned by one pod, so one workspace or a looping agent cannot fill
  it.

## Deploys and failures

- **Deploy** (rolling): a stopping pod marks itself draining, stops accepting connections and
  commands, finishes its queues, stores, releases its documents 10 at a time, then disconnects their
  browsers, all within the 150 s drain. Browsers reconnect to a pod on the new version. A pod that
  cannot store a document before the deadline exits with an error, and the next owner settles it.
- **Crash**: the owner's hint expires after 15 s and another pod takes the document. Browsers resend
  what they hold.
- **Rebalancing** (M3) uses the same handoff, with limits on how often a document moves.
- **Workspace deletion and relocation** delete or move the workspace's prefix in `collab-state`.

## Observability

Per pod, never per document: open documents, edit-to-`stored` latency, store outcomes (committed,
refused by another owner, throttled, uncertain), takeovers, forwarded connections, outside writes and
conflict copies, pending mentions, GCS operations. From browsers: **epoch changes with unsaved
edits**, the number that says whether the design works.

## Tests

Run against independent processes with a real Redis and GCS bucket:

- Owner killed, paused past its TTL, or cut off from Redis while browsers type: nothing acknowledged
  is lost, nothing is duplicated, the old owner stores nothing after the takeover.
- A store whose response is lost; a 412 on the SDK's retry of our own write; a takeover right after.
- A command retried after a lost response, a crash, or the session closing: applied once. A burst of
  agent edits on one document.
- A checkpoint that times out then lands late; a file written or deleted by someone else.
- A tab closed with unsaved edits, then another user logging in on the same browser: not picked up.
- Journal pruning while the tab keeps editing; an epoch change with unsaved edits.
- A large offline session replayed on reconnect; a document reaching the size limit.
- Every pod restarted while browsers type; Redis restarted; a rollback after a full drain.
- A forged forwarding signature: refused.

## Protocol

The exact rules M1 implements.

### Lifecycle

| Status | Created or reached by | Allows |
|---|---|---|
| `initializing` | First owner, create-only (`ifGenerationMatch: 0`); a losing creator reads the winner | Building the state from the `.md` |
| `active` | First owner, after building the state and checking the limits | Connections, edits, commands, checkpoints |
| `refused` | First owner, when the editor cannot open the file (with the file revision it examined) | Direct file access; rechecked when the file revision changes |
| `closed` | Owner, 5 min after the last client, once the final checkpoint and mentions are done | Direct file access; reopening starts a new epoch |
| deleted | Sweeper, conditional on the revision it read | Only `closed` or `refused` records whose receipts expired, with no pending intent or mention |

Closing is one queued step: refuse new connections and commands, store, checkpoint, drop the Yjs state,
write `closed`. Reopening a `closed` record writes `initializing` with a new epoch.

The sweeper runs in the collab pods and acts like any owner: to finish an abandoned `active` document
(mentions to send, a checkpoint to settle) it takes the document first.

### Writing the state object

One scheduler per document orders every write (stores, commands, intents, takeover, close, sweeper),
at least one second apart, by priority: release and drain, then intent settlement, then commands, then
stores. Each write sends immutable bytes with its identity and `ifGenerationMatch` on the last revision
the pod wrote or read.

| Outcome | Meaning | Action |
|---|---|---|
| Success | Stored | Record the new revision; acknowledge the covered snapshot and receipts |
| 429 or 503 | Throttled | Back off; retry the same bytes and condition |
| Timeout, connection error, 500 | Unknown | Freeze new writes for this document; retry the same bytes and condition |
| 412 | Someone wrote, possibly our own earlier attempt retried by the SDK | Read the object: our identity means stored; an owner token above ours means we lost the document; otherwise read again |

After losing a document, a pod never retries against the new revision and never acknowledges the
pending cut. If its write had in fact landed before the takeover, the new owner read it, so the edits
and receipts are there; browsers learn it from the new owner's `stored`.

### Settling a file intent

For the pending intent, read the destination:

- at a revision whose bytes hash to the intent's: done, record that revision;
- still at the expected revision: retry the same conditional write;
- absent, for a create-only copy: retry the same write to the same name;
- anything else: an outside write (copy it, then move the expected revision).

A timeout never ends an intent: only one of the reads above does.

### Journal compaction

When a `stored` arrives, one IndexedDB transaction replaces the base with the state it acknowledges
and deletes the updates that snapshot covers. Updates not covered stay, and the new base contains
everything they depend on. Acknowledgements older than the base are ignored. A tab takes over another
tab's journal by copying it into its own in one transaction and keeping the source until its own
`stored` covers it, so two tabs taking over the same journal apply its updates twice, which Yjs
tolerates.

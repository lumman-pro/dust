# Collab server infrastructure

## The problem

front-collab is one Node process per region. It holds every open document in memory and rebuilds
it from the `.md` file on each load. That has three consequences:

- **Capacity** is one process. We do not know yet how many documents are open at peak, or when one
  process runs out. The server logs its open document count at shutdown, which gives a first
  datapoint; M0 measures the rest.
- **Every deploy makes documents read-only for about 3 minutes**, and a crash takes every open
  document offline. We deploy every day.
- **A browser cannot keep its copy across a reconnect.** Rebuilding from the `.md` gives the text new
  Yjs identities, so merging the browser's copy back would duplicate it. So the editor is read-only
  while offline, and on reconnect the browser throws its copy away, with any edit still on its way
  to the server.

Already done (October 2026): the cluster autoscaler no longer moves the pod (dust-infra#1173; in one
week it caused 17 restarts across both regions, against 6 deploys per region), and browsers
reconnect within 5 s of the server coming back and log how long they were offline (#35355).

We want several pods, then autoscaling, with documents moving between them without losing or
duplicating anything.

## The decision

- **One owner per document.** Any pod accepts a connection and forwards it to the owner.
  Hocuspocus recommends splitting documents across instances for CPU and memory, and Figma runs one
  process per document.
- **Persist the Yjs state, not only the `.md`.** A new owner loads the same identities, so browsers
  keep their copy across reconnects and resend what the server is missing. This is the change that
  makes moves lossless.
- **One GCS object per recently opened document holds that state**, and every write to it is
  conditional on its revision. That gives each document one history that a pod which lost the
  document cannot write to. No database. If M0 shows GCS cannot meet the targets, small tables in the
  front Postgres are the fallback (see [options.md](options.md)).
- **Redis holds hints only**: which pods are alive, which pod owns a document. Losing them costs
  reconnects, not data.
- **The `.md` file stays the source of truth between sessions.** The owner checkpoints it, and keeps
  both versions when someone else wrote it meanwhile.
- **DFS later.** When files move to DFS, outside writes may be blocked instead of detected, if DFS
  gets a way to lock a file for a session (see [dfs.md](dfs.md)).

The design is in [design.md](design.md), with the exact rules in its
[protocol appendix](design.md#protocol). It supersedes the replica, lease, per-file lock and storage
parts of [LIVE_SESSION.md](../LIVE_SESSION.md), marked there.

## Plan

| Step | What | Gives |
|---|---|---|
| M1a | Yjs state stored with every save and reused at startup, browsers that keep their copy and stay editable while offline. Still one pod | Typing through a deploy or a crash |
| M0 | Metrics (open documents, memory, CPU per pod), shutdown that reports failures, a test harness that kills and pauses pods, the GCS benchmark | Numbers to size M2 and M3; GCS validated or the fallback chosen |
| M1 | Persisted state, ownership, browser journals, acknowledgements, commands, checkpoints, limits, draining, internal calls that never mistake a refused connection for "no session". Still one pod | No lost acknowledged or journaled edits on reconnect, deploy or crash |
| M2 | Forwarding, rolling deploys, several pods | Capacity, deploys without downtime |
| M3 | Rebalancing, autoscaling | Elastic capacity |
| Later | Files on DFS | Stable file identity, possibly blocked outside writes |

M1a and M1 are each worth shipping alone. M2 and M3 are sized from M0's numbers.

### M1a: typing through a deploy

The smallest step that removes the read-only minutes, before the rest of M1:

- **Saves**: each time the server saves a document's `.md` (every 5 to 30 s while people type, and
  at shutdown), it also writes the document's Yjs state to its state object, with the document's
  epoch and the `.md` revision that state continues from. The write is conditional, as every write
  in the design. A save that fails still writes the state, so those edits survive a restart.
- **Startup**: when a document loads and its state object names the `.md` revision the file still
  has, the server loads that state and keeps its epoch. Otherwise it rebuilds from the `.md` with a
  new epoch, as today.
- **Browser**: a lost connection keeps its document and stays editable. It reconnects with its
  epoch; the same epoch means the server has the same history, and Yjs sends each side what the
  other is missing, including what was typed after the last save. A different epoch means the file
  changed meanwhile: the browser applies the design's rule (show the old version to copy, never merge
  it). A server that sends no epoch (before M1a is deployed) gets today's behavior.
- **Offline for long**: after about a minute offline, the editor warns that the edits are only on
  this computer, since closing the tab loses them until the journal exists.
- **Order**: the server first, which is harmless alone (browsers ignore the epoch), then the browser.

Writing the state with every save also covers a crash: the restarted server loads the last saved
state, and the browsers send what came after it.

Not covered until M1:

- a tab closed while offline (no journal yet);
- comments and agent writes while offline (refused, as today);
- an agent writing the file while the server is down: front writes the `.md` directly when it finds
  no session, so the epoch changes and offline edits are only offered as a copy.

The state is written as often as the `.md` is today, so it needs no benchmark first. Rollback
stays as today: the `.md` is saved before the state, so the old server only misses edits whose save
failed, which it would miss today too.

Open question: the state objects go in a `collab-state` bucket per region as designed (a dust-infra
change first), or under a `collab-state/` prefix of the existing files bucket until M1.

Each step changes contracts, so their owners sign off. M1a:

- `collab-document-lifecycle` (tdraier), `front-api/lib/collab/hocuspocus.ts`: a load reuses the
  stored Yjs state when the file has not changed;
- `collab-shutdown-save` (PopDaph), same file: each save, shutdown included, also writes the Yjs
  state after the `.md`;
- `collab-connection-reconnect` (PopDaph), `front/hooks/useCollabConnection.ts`: the browser keeps
  its document across reconnects with the same epoch;
- `collab-editor-editing` (PopDaph), `front/components/editor/document/useDocumentEditor.ts`: the
  editor stays editable while offline.

M1:

- `collab-shutdown-save` again: shutdown drains instead of saving everything at once;
- `collab-client-read` and `collab-client-write` (tdraier), `front/lib/api/collab/client.ts`: a
  refused connection is an error, not "no session".

## Risks

- **Rollback** (from M1; M1a rolls back as today): once the state object holds edits newer than
  the `.md`, the current server (which reads only the `.md`) would lose them. Rolling back means
  draining with a final checkpoint of every document first. It is blocked while a checkpoint fails
  or a document is over the Markdown limit.
  The new client works with the old server (it falls back to today's behavior when no `stored`
  message comes).
- **GCS**: cost and latency, see [options.md](options.md#gcs-costs).
- **Redis**: a Redis outage stops new connections (tickets already need it) but open documents keep
  working, since the GCS condition protects the history. A Redis restart turns reconnects into
  takeovers, which are rate limited per pod.

# Collab server infrastructure

## Problem

front-collab is one Node process per region. It holds every open document in memory and rebuilds
it from the `.md` file on each load.

- **Every deploy makes documents read-only for up to about 2 minutes**, and we deploy daily. A
  crash does the same.
- **A browser cannot keep its copy across a reconnect.** Rebuilding from the `.md` gives the text
  new Yjs ids, so merging the browser's copy back would duplicate it. The editor goes read-only
  while offline and drops its copy on reconnect, with any edit still in flight.
- **Capacity is one process.** We do not know yet when it runs out.

Already done: the cluster autoscaler no longer moves the pod (dust-infra#1173), browsers reconnect
within 5 s and log how long they were offline (#35355), and agent edits apply in the document's
turn instead of failing when someone types (#35452).

## Decision

- **Store the Yjs state, not only the `.md`**, so a restart or a move keeps the same ids and
  browsers merge instead of starting over.
- **In a dedicated Redis instance per region**, saved with each `.md` save, separate from front's
  Redis so its memory and evictions never touch front's caches. No new database.
- **The `.md` stays the source of truth**, written every few seconds as today. Losing Redis costs
  what is not in the `.md` yet, offered to copy: usually a few seconds, more for a tab offline for
  long or a document whose saves keep failing.
- **One owner per document** once there are several pods, recorded in Redis.
- **Outside writes are detected, not blocked**: when a session saves and finds a version it did
  not write, both are kept, as today. DFS may let us block them later.

## Plan

### 1. Typing through a deploy (one pod)

In progress: the Redis instance (dust-infra#1189) and the server part (#35568), by tdraier; the
epoch check in `beforeSync` is still to do.

Server:

- With each `.md` save (every 5 to 30 s while people type, and at shutdown), also save the Yjs
  state and the session's comment threads (they live outside Yjs) to Redis, with its epoch (an id
  for this Yjs history, changed only when the state is rebuilt from the `.md`) and the `.md`
  revision it continues from. 2 MiB cap, expires a day after the last save or load. A failed `.md`
  save still saves the state, so those edits survive a restart. A state over the cap is not stored
  (and the previous one is deleted), so that document rebuilds with a new epoch after a restart.
  This needs a storage with file revisions; live sessions are refused on the others (#35586).
- On load, reuse the state if the file still has that revision, or if the file's content is what
  the state writes (a crash between the two saves); otherwise rebuild from the `.md` with a new
  epoch, as today.

Browser:

- On a lost connection, keep the document and stay editable.
- Reconnect with the epoch, sent with authentication. The server compares it with the loaded
  document in `beforeSync`, before any Yjs update is exchanged. Same epoch: Yjs sends each side
  what the other is missing. Different epoch: the file changed meanwhile, or the stored state was
  lost, so the server refuses the old document and the browser shows it to copy, never merged. A
  connection with no epoch (a fresh tab, or today's browsers) carries no old document and syncs as
  today.
- After about a minute offline, warn that the edits are only on this computer.

Server first (harmless alone: browsers without an epoch get today's behavior), then browser.
Rollback as today.

Not covered yet: a tab closed while offline, comments and agent writes while offline, an agent
writing the file while the server is down (the epoch changes, so offline edits are offered as a
copy).

| Not chosen for the state | Why not |
|---|---|
| A new database | More to operate per region, for state that fits in Redis. |
| The existing Postgres | No new service, but collab traffic would land on front's database. Worth it if we need the state to survive a Redis loss. |
| A durable copy in GCS | Deferred while losing Redis is acceptable: the `.md` keeps the text but not the Yjs history, so browsers offline at that moment get a copy instead of a merge. Worth it if Redis incidents hurt, Redis memory gets too high, or we want to write the `.md` less often. |

### 2. Measure

Open documents, memory and CPU per pod, Redis memory, and how long users stay offline during a
deploy. Sizes step 4.

### 3. No lost edits (one pod)

- **Journal per tab** in IndexedDB, so edits survive a tab closed while offline. Try `y-indexeddb`
  with one store per tab before writing our own.
- **"Saved" from the server**: a browser shows "Saving…" until the server confirms it stored its
  edits.
- **Commands with receipts**: comments and agent writes carry an operation id (the agent action's
  id for an agent write); a retry finds the stored result instead of applying twice. Agent edits
  already go through the document's turn (#35452). Receipts live in Redis, so a retry after Redis
  lost them can apply twice.
- **Limits**: size caps per document and per connection, so one document or client cannot fill
  the pod.

| Not chosen for no lost edits | Why not |
|---|---|
| One IndexedDB store shared by all tabs, cleared from one tab's "saved" | A tab could delete another tab's unsaved edits. One store per tab avoids it. |
| Hocuspocus's own sync acknowledgement as "saved" | It means "applied in memory", not "stored". The server has to say when it stored the edits. |
| Receipts stored apart from the edit | A receipt kept while its edit was lost would block the retry. A receipt saved with the edit, or an edit safe to apply twice, avoids it. |

### 4. Several pods

Only if step 2 shows one pod is not enough. Initial proposal, to review when we start this step.

- **One owner per document**, recorded in Redis with an owner token. A pod writes a document's
  state only if the token is still its own (a short Lua script), so a pod that lost the document
  writes nothing. The `.md` needs a fence of its own (see open questions).
- **Forwarding**: a browser may land on any pod, through today's load balancer. That pod looks up
  the document's owner in Redis: itself, it serves; another pod, it forwards the WebSocket to that
  pod's internal address; none, it picks one with a stable hash of the document name among the
  live pods. Our own code in the pods, no new infra component. front's internal calls (agent reads
  and writes) go to the owner too: a pod that does not own the document must not answer "no
  session", or the caller would write the file under a live session.
- **Rolling deploys**: a stopping pod hands its documents to the others before it exits, so users
  do not notice the deploy.

| Not chosen for several pods | Why not |
|---|---|
| Hocuspocus Redis extension | Spreads connections, but every pod with the document open holds a full copy and applies every update. Our saves, the per-document queue (#35452) and the threads assume one process per document. |
| Sticky sessions (client IP or cookie) | Pins a browser to a pod, not a document: two people on the same document can land on different pods, and agent calls are not routed. |
| Routing on the document at the load balancer or a hash proxy | A real alternative to forwarding in the pods, to compare when we start. Needs the document in the WebSocket URL (today it is sent after connecting), the same routing for agent calls, and the same fencing. |
| y/hub (Redis streams) | A different architecture, stateless servers and workers merging the edits, so our session layer would be rewritten. Beta, AGPL or commercial license. |

### 5. Autoscaling

The pod count follows the load, and documents rebalance between pods with the same handoff.

### Later: DFS

Stable file ids (a rename keeps the session) and maybe blocking outside writes.

## Risks

- **Redis memory**: only recently open documents, under 2 MiB each, expiring after a day, on its
  own instance.
- **A Redis incident**: loaded documents keep their state in memory and keep saving the `.md`, and
  later writes fill Redis again. Only a document that loads while its state is missing or Redis is
  unreachable (an error or the 5 s timeout) rebuilds, losing what is not in the `.md` yet, offered
  to copy.
- **`.md` writes every few seconds** keep triggering indexing and conflicting with whole-file writes
  (the file API).

## Open questions

- When to run several pods (step 4): after the measures of step 2.
- How to fence a pod that lost a document (step 4). A Redis token is not enough on its own: a
  paused pod can still write the `.md` before the new owner does, today's conflict handling would
  keep a copy and overwrite, and a Redis failover can bring back an old token. The fence has to be
  enforced by the file store (or a durable state object written conditionally), and a pod that
  lost a document must not use the ordinary conflict handling.

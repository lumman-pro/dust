# Options

## How others do it

- **Hocuspocus** suggests independent instances with documents split between them for CPU and memory
  ([guide](https://tiptap.dev/docs/hocuspocus/guides/scalability)). Its Redis extension syncs
  instances through Redis, persists nothing, and makes every instance handle every message
  ([extension](https://tiptap.dev/docs/hocuspocus/server/extensions/redis)).
- **y/hub**, the Yjs author's backend ([repo](https://github.com/yjs/yhub)): a Redis stream per
  document, stateless servers, workers compacting into object storage and Postgres. Redis is a cache,
  not the durable store. Beta, AGPL or commercial license.
- **Figma** runs one process per document
  ([how it works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)) and later added
  a journal of changes between checkpoints
  ([reliability](https://www.figma.com/blog/making-multiplayer-more-reliable/)).
- All of them persist the CRDT state itself. We rebuild from the `.md`, which is why moves lose edits.

## Architectures

| | Why not |
|---|---|
| Hocuspocus Redis extension | Every pod processes every message, so no CPU or memory gain, and our comments, saves and agent writes assume one process per document. |
| y/hub style, Redis streams | Rewrites our session logic around streams, and our Redis is not a durable store. |
| Fixed shards by hash | Still needs persisted state and fencing to move a document; resizing moves many documents at once. |
| A new database | More to operate per region and per cell, for state that fits in object storage. |
| **One owner per document, state in GCS** | Chosen. Keeps our session logic; GCS conditional writes give one history per document; no database. |

## GCS costs

Regional Standard storage, $0.005 per 1,000 writes:

- **Continuous typing example**: 1,000 documents typed in without a pause, one store every 10 s each:
  about 100 writes a second, about $1.3k a month.
- **Upper bound**: typing with pauses just over 1 s, or frequent commands, approaches one write per
  second per document: about $13k a month for the same 1,000 documents. Real use is bursty and most
  open documents are idle; M0 measures it.
- **Soft delete** (kept, 7 days): every overwritten copy stays billable for 7 days. A 10k character
  document is about 20 KiB of Yjs state fresh and grows with its editing history (up to about 160 KiB
  in our measurements). At 160 KiB, the continuous typing example retains about 10 TB, about $200 a
  month; the upper bound, about ten times that. It lets us restore a state object deleted or
  overwritten by mistake.
- **Latency**: "saved" arrives about 1 s after a pause, within 10 s during continuous typing. Commands
  share writes but each write still takes a GCS round trip.

## The M0 benchmark

Validates GCS, with the fallback ready if it fails:

- **Workload**: 100, 1,000 and 5,000 documents, typed in continuously and in bursts; bursts of comments
  and agent writes on one document; full checkpoint and close cycles; takeovers; a deploy draining
  every document.
- **Measured**: edit-to-`stored` latency, command latency under bursts, throttling, operations and cost
  per 1,000 active documents (stores, intents, takeovers, reads, retries), retained bytes, bandwidth,
  CPU to encode states, recovery time after a pod is killed.
- **Targets** (to agree before running): "saved" within 2 s of a pause, an agent edit acknowledged
  within 2 s, cost within budget.

## Fallback: small tables in the front Postgres

Only if GCS misses the targets. Same guarantees, different storage, so a separate implementation:

- a narrow owner row (workspace, document key, owner token, sequence) checked and updated in the same
  transaction as every write, kept apart from large columns;
- `collab_updates`: small batches of edits, each accepted only if its owner check passed in the same
  transaction;
- snapshots as immutable GCS objects: upload, then commit a row with the sequence it covers, then
  delete only the updates it covers;
- threads, receipts and mentions as rows, in the same transaction as the change they record;
- `workspaceId` first in every key, collab's own small pool, one round trip per pod per second for all
  its documents, with a result per document.

Its cost is steady small writes, WAL, locks and vacuum on the busiest database, measured with the same
benchmark against front's own latency.

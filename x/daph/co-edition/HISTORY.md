# Co-edition versioning: proposed design

A potential design for document history, built on the provisional
[DFS architecture](../../../dfs/design-docs/INDEX.md).

## Overview

Each co-edited doc keeps every version as a plain Markdown copy in a hidden DFS folder that only
front can access, keyed by the doc's object ID so history survives renames.

A snapshot is taken when a doc is opened and when its editing session ends, when an agent takes
over from people mid-session (at most every Y minutes), and just before a restore. It is always a
copy of a version already saved, so a failure can cost history one version but never the doc.

Anyone who can read the doc can browse its history, and anyone who can write to it can restore a
version.

## DFS in a nutshell

The parts of DFS this design relies on:

- **One tenant per workspace, with one root folder.** Front creates `users/<email>/` under it,
  then `pods/pod-<sId>/` and `conversations/conv-<sId>/` inside each user folder.
- **Every file and folder has a permanent object ID.** Renaming or moving an object only changes
  its parent and name, never its ID. Front stores IDs, never paths. A path is only ever resolved
  from a folder ID.
- **Content is overwritten in place.** A file's bytes are stored in 64 KiB blocks under its ID.
  A write replaces them and increments `content_version`.
- **Access comes from grants.** A grant gives read or write access on a folder or file, and
  applies to everything below it. Users and agents only get grants on the context folders they
  work in. Without a grant, a folder does not appear in listings, search or sandbox mounts.
- **Every call goes through a session.** A session represents a user, an agent or front, and its
  grants decide what it can see. A sandbox gets one session and sees DFS as a mounted folder.
- **`Apply` is one transaction.** It runs a list of creates, writes, renames and removes on any
  objects of the tenant, all or nothing, within a 1 MiB request.

## Storage

Snapshots live in a `.history/` folder at the tenant root, next to `users/`, keyed by the doc's
object ID:

```text
<tenant root>
  users/
    arthur%40dust.tt/
      conversations/
        conv-<sId>/
          poem.md                 ← the live doc (object ID 0190…)
  .history/                       ← no grants for users or agents
    0190…/                        ← one folder per doc
      2026-10-13T10-00-00Z.md
      2026-10-13T14-30-00Z.md
```

- **Hidden by construction.** No user or agent session has a grant on `.history/`, so it never
  shows up in sandboxes, search or listings, and agents cannot edit or delete history. Only
  front's own session, with a grant on `.history/`, reads and writes it.
- **Follows the doc.** The folder is named after the doc's object ID, so renaming or moving the
  doc keeps its history.
- **Metadata.** Each snapshot file carries xattrs: its reasons (session start, session end,
  before agent edit, before restore), everyone (people and agents) who edited the doc since the
  previous snapshot, the doc's `content_version` at that moment, and the time the snapshot was
  taken.
- **References.** As for user folders, front stores the ID of `.history/` once and resolves each
  doc's folder from it. A doc's history folder is created with its first snapshot.

## When a snapshot is taken

Snapshots follow the editing sessions the collab server already has. A session starts when a doc
is loaded into memory, for a person opening it or an agent editing it, and ends 5 minutes after
the last person or agent left, when the doc is unloaded.

- **When a session starts.** A copy of the doc as loaded.
- **When a session ends.** A copy of the last save. Closing and reopening within 5 minutes stays
  in the same session.
- **When an agent takes over mid-session.** When a save's changes come from an agent and the
  previous save's came from people, a copy of that previous save, labelled "before agent edit".
- **Just before a restore.** A restore replaces the whole doc, and Cmd+Z cannot revert it. Saving
  and snapshotting the current content first keeps it recoverable: restoring the "Before restore"
  snapshot undoes the restore.

When the content is the same as the latest snapshot, no new snapshot is taken.

### Throttle

- **At most one "before agent edit" snapshot per doc every Y minutes.** A person and an agent
  taking turns quickly would otherwise add a snapshot every few seconds.

## How it fits in the collab server

The collab server is built on two libraries:

- **Yjs** holds the live content in memory, merges everyone's edits and tags each change with
  who made it.
- **Hocuspocus** is the server around Yjs. It manages the browsers' connections, decides when to
  save, loads and unloads docs, and calls hooks at each of those moments.

A snapshot is a copy of a saved version: the file as loaded, or the last save the collab server
keeps in memory. Snapshots come from Hocuspocus's existing hooks, never from Yjs:

- **Agent takeover: the onStoreDocument hook.** At each save it knows who made this save's
  changes and who made the previous one. On a switch from people to an agent, it snapshots the
  previous save before replacing it in memory.
- **Session end: the beforeUnloadDocument hook.** Called once the last save is done. It must
  catch every error: a failing hook cancels the unload.
- **Who edited: the onChange hook.** It notes everyone who edited since the last snapshot.
- **Before a restore: the restore endpoint.** The one place outside the hooks, since no hook fires
  before a restore. It asks Hocuspocus to save right away, takes the snapshot, then applies the
  old content.

The agent edit endpoint does not change.

## How many are kept

Every snapshot, for now. Nothing is ever deleted, so the space per doc grows with the number of
sessions, and nothing needs a background job. Snapshots only come from the triggers above, never
from each save, and an unchanged doc adds none, which keeps the count low. We can add a cap later
if some docs grow too much (see the open questions).

## Atomicity

The doc and its history are saved in two steps, doc first:

1. **Save the doc.** The collab server writes the new content to the doc, alone in its own
   `Apply`.
2. **Snapshot it.** Only once that save succeeded, a second `Apply` creates the snapshot, a copy
   of the content just saved.

If step 2 fails or never runs, the doc is safe and history misses that one version. A snapshot of
a version that was never saved cannot exist, and a problem in history never blocks saving the
doc.

### Lost responses

`Apply` has no idempotency key: when a response is lost, front cannot tell whether the request
committed, and must not replay it blindly.

- **Snapshot step.** Front picks the snapshot's object ID before sending, since DFS `create`
  takes a caller-chosen ID. After a lost response, it looks that ID up. If the snapshot exists,
  the step committed. If not, front resends the same request with the same ID.
- **Save step.** Front reads the doc back. If it holds the content just sent, the save committed
  and the snapshot step follows. If not, front saves again.

## Restore

A restore never copies or moves the snapshot file over the doc. Front reads the snapshot's
content and applies it to the doc as an ordinary edit, the way agent edits reach it:

1. **Check access.** With the user's own DFS session, front checks the user can write to the doc.
   It then reads the chosen snapshot with its own session.
2. **Keep the current version.** The collab server saves the current content if it changed, then
   snapshots it as "Before restore", following the save-first rule. The snapshot also records who
   restored and which version, so the History panel shows "Before restore · Arthur restored the
   10:00 version". No snapshot is taken after the restore: its content is already in history.
3. **Apply the old content.**
   - **The doc is open in a live session.** Front calls the collab server's internal edit
     endpoint with the snapshot's Markdown. The server converts it and replaces the shared
     document's content in one change, so everyone connected sees it at once. Its next save
     writes the file.
   - **Nobody has the doc open.** Front saves the snapshot's content to the doc itself.

## Doc deletion

When a doc is deleted through front, delete its history folder in the same call. A file deleted
from a sandbox leaves its history behind. A rare sweep job can clean that up: list `.history/`,
look up each folder's doc ID, and remove the folders whose doc no longer exists. We can also
accept the leftovers at first, since they're small Markdown files.

## The settings to pick

- **Agent takeover throttle.** At most one "before agent edit" snapshot per doc every 10 minutes.

## Open questions for the co-edition team

- **History follows the doc's current permissions.** So when a doc is moved to a shared pod, or
  its pod gets new members, those people can browse versions from before they had access. Google
  Docs behaves the same way. Are we OK with this?
- **No way to erase a version.** If someone pastes a secret and then deletes it, it stays in
  history for good, readable by everyone with access. Should editors be able to
  delete a single version or clear a doc's history?
- **History outlives deletion.** `.history/` sits at the tenant root, outside the doc's context
  folder, so conversation retention, conversation deletion, and user or workspace deletion all
  miss it. Deleted content would live on in history. Should each of those flows also delete the
  doc's history, or should history move under the doc's own context folder
  (`conv-<sId>/.history/<objectId>/`), where it goes away with the conversation?
- **Agents and history.** Should agents be able to read a doc's history?
- **Comments.** Restoring a version brings back the comments as they were then: threads resolved
  or deleted since come back, and newer threads disappear from the doc (they remain in "Before
  restore"). Are we OK with that?
- **A cap, later.** Keeping every version is simplest, but a busy doc's history keeps growing.
  If we add a cap, should we delete the oldest snapshots, or thin them out over time (keep every
  version from the last days, then one per day, then one per week)?

## Open questions for the DFS team

- **A new top-level folder.** The DFS design has front create only `users/` under the tenant
  root. `.history/` would be a second top-level namespace. Is this OK?
- **Front's session.** Front would need a session whose grant covers `.history/` and nothing users
  can reach, distinct from the user and agent sessions.

## What was left aside

- How to handle files over 1 MiB.

## What was considered

- **History inside DFS.** Crab soup for everyone.
- **History in Postgres.** It's a second system with no shared transaction with DFS, and
  permissions would have to be re-implemented.
- **Snapshots in a hidden folder next to the doc.** DFS can't hide files. Agents would see it in
  sandboxes, search would return it, and anyone with write access could edit history.
- **History stored in Yjs.** It would grow forever, and it disappears whenever the live state is
  rebuilt from the file.
- **Snapshots driven by Yjs events or Yjs snapshots.** Yjs events fire per keystroke and know
  nothing about saves or sessions. Yjs snapshots need deleted text kept forever and are lost when
  the doc is unloaded. See "How it fits in the collab server".
- **A snapshot call in the agent edit endpoint.** Hocuspocus's load, save and unload hooks already
  cover agent edits: a session of its own when nobody has the doc open, a takeover snapshot
  otherwise.
- **A "snapshot next save" flag consumed after each save.** Triggers landing in the same batch
  overwrite each other's reason, and a save already in progress could consume a flag set after it
  started, labelling content that misses the latest edits.

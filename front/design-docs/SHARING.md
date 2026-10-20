# Conversation sharing on dfs://

TL;DR: we want the dfs grants to decide who can access a conversation. As a result conversations
need to become private to their creator by default, with a "Share" button in the conversation
header that reads and updates the grants, and users who hit a conversation they can't access get
a clear message telling them to ask for it.

Builds on top of the dfs design docs [API.md](../../dfs/design-docs/API.md),
[URI.md](../../dfs/design-docs/URI.md) and [DOUBLE_WRITE.md](../../dfs/design-docs/DOUBLE_WRITE.md).
Open decisions are at the end; the doc assumes we take the recommended option for each of them.

## Motivation

We're moving content to dfs, which will be the single source of truth for access: front, sandboxes,
search and browsing all rely on the same grants; dfs is authoritative and front a consumer.

Dfs will add search ([SEARCH.md](../../dfs/design-docs/SEARCH.md)) and browsing (`List`,
`/shared`) over everything a user can read. Today any workspace member with a conversation's link
can open it. That's fine only because there's no way to discover a conversation you weren't given
the URL to. With search and browsing, "readable by the workspace" becomes "searchable by the
workspace", and you shouldn't be able to discover other people's conversations. So access has to
be explicit: private by default, opened by a grant.

From a purely tactical POV we could devise a system that makes the change seamless for a while
(update the grants in dfs in a way that allows sharing URLs directly); but my take on that is
that we will need to bite the bullet at some point so there is no need for a temporary patch.

## Scope

- In: standalone conversations, the share popover.
- Out for v1: Frames (they keep their tables), sharing outside the workspace, per-conversation
  grants in pods (pod conversations follow pod membership), access requests (see
  [Maybe one day](#maybe-one-day)).

## Model

- Dfs grants on the conversation folder are the authority. Front stores no copy.
- Front is the only writer, since `UpdateGrants` needs the tenant key. It checks the actor's own
  permission through dfs first.
- Spaces (`requestedSpaceIds`) no longer gate access: sharing warns instead, see
  [Spaces](#spaces).
- `conversation_participant` no longer grants access. It stays for the sidebar, unread state and
  notifications, and will be used to backfill.

### Permissions

| Level       | Dfs  | Allows                                                         |
| ----------- | ---- | -------------------------------------------------------------- |
| View        | `r`  | Read messages and files. Read-only.                            |
| Participate | `rw` | Post, react, mention, run agents, write files, change sharing. |

- We lose a level of granularity (no participating without managing), but it keeps the model
  simple. Anyone with `rw` can share further and remove others.
- The owner is the creator (`isConversationCreator`). The folder lives under their user folder, so
  their access is inherited and the popover, which only edits local grants, can't remove it.
  Nobody can remove the owner.
- Leaving removes your grant and participant row. The owner can't leave, only delete.

### Grant layout

```text
<tenant-root>/
  users/
    U/                                DENY rw, ALLOW u:U rw            (existing)
      .conversations/
        conv-C/                       no local grant: only U
        conv-S/                       ALLOW u:V r, ALLOW u:W rw        (shared with V and W)
          .conversations/
            conv-D/                   sub-conversation of S, if nested (TBD)
      pods/
        P/                            DENY rw, pod read and write grants
          .conversations/             ALLOW g:<pod member groups> rw
            conv-E/                   no local grant: pod members
```

- Changing a level detaches the old grant and attaches the new one in one `UpdateGrants`.
- Anything shared with you through an ALLOW shows up in your search results.

**Pod conversations** inherit the pod folder. All pod members participate in conversations while
pod files split read and write, so the pod's `.conversations/` folder gets ALLOW `rw` for the pod
member groups (part of pod folder provisioning, the TODO in `getOrCreatePodFolder`). No local
grants on pod conversations: the popover shows the pod members, and getting access means being
added to the pod, like `pending_project_membership` mentions today.

**Sub-conversations** (`run_agent`, `depth > 0`) have no participants. TBD whether we nest their
folder under the parent's so they inherit its grants (the parent is reachable through the sub's
first message, `agenticOriginMessageId`), or handle them in the backfill by tracing back the user
and adding grants. Nesting is a very trapdoory and opinionated solution: it bakes the parent/sub
relationship into the folder layout and ties the sub's access to the parent's grants, and undoing
it means moving folders.

## Spaces

Grants are the only check: `requestedSpaceIds` no longer gates access, in front or in dfs. Dfs
grants can't express "must read every requested space", and checking it in front only would leave
the files readable through dfs anyway.

Instead, the popover warns when you add someone who can't read some of the conversation's
requested spaces: they'll see data from those spaces. Sharing it anyway is the sharer's call.

This is a change for standalone conversations, where today a conversation using a restricted space
is never visible to people outside that space. Simplifying this is a goal of dfs in the end, so
it's only a concern for the transition. And that ship has sailed with Pods: a pod conversation is
visible to every pod member, whatever spaces its agents read from (`requestedSpaceIds` is forced
to the pod's space).

In any case, backfilling grants from participants isn't a trapdoor: it only grants people who can
access the conversation today, and grants can be tightened later if we change our mind.

## Read path

- Front checks access with a dfs session holding the user's subjects (`getDfsSessionSubjects`),
  cached per user and subject set.
- `baseFetchWithAuthorization` loads the rows, batch `Stat`s their folders (up to 4,096), drops
  the ones without `r`. The resource exposes `read` or `write`.
- No caching of `Stat` across requests: removing a grant applies on the next request.
- Fail closed: a dfs error is an error, never "not found" or "allowed".
- Enforced per workspace behind a FF.

`canAccess` results:

| Result                    | When                  | UI                         |
| ------------------------- | --------------------- | -------------------------- |
| `conversation_not_found`  | No such conversation. | "Conversation not found".  |
| `conversation_not_shared` | No grant.             | No-access message (below). |

The no-access message is something like "You don't have access to this conversation. Ask the
person who shared the link to add you." Only workspace members reach it, and it shows no title,
owner or participants.

Technically this allows resource enumeration: telling "not found" apart from "no access" lets a
member check whether a conversation ID exists. Not an issue: it's intra-workspace, no data
leaks at all, and it's the model Google Drive and other mainstream platforms apply.

| Actor                             | Dfs session                                                           |
| --------------------------------- | --------------------------------------------------------------------- |
| User                              | `u:` and `g:` subjects. Owns what they create.                        |
| Agent loop, Temporal, `run_agent` | `superuser`, after front authorized the user.                         |
| Trigger                           | `superuser`. The conversation goes under the trigger editor's folder. |
| Slack, Teams                      | The mapped user's subjects.                                           |
| Poke                              | `superuser`, audited.                                                 |
| API key without a user            | `g:` subjects only. Ownership is open.                                |

## Share popover and API

A "Share" button in `ConversationTitle`, built like `ShareFramePopover`:

- People with access: the owner, user grants, and pod members for pod conversations.
- Add people: workspace members, as View or Participate, with the [spaces](#spaces) warning when
  it applies.
- Copy link.

Read-only for viewers (`r`).

```text
GET /api/w/:wId/assistant/conversations/:cId/sharing
-> {
     canManage: boolean
     owner: User
     members: { user: User, permission: "read" | "write" }[]
   }

PATCH /api/w/:wId/assistant/conversations/:cId/sharing
{
  changes: {
    userId: string
    permission: "read" | "write" | "none"
  }[]
}
```

`GET` is `ListGrants` plus the owner and pod from front. `PATCH` checks the caller has `rw` on the
conversation, validates subjects (active members) and sends one `UpdateGrants`. Adding
someone upserts their participant row (`subscribed`) and notifies them. Removing someone deletes
the row. Audit event: `conversation.sharing_updated`.

This removes `metadata.urlAccessMode`, the "Restrict URL access" menu item,
`privateConversationUrlsByDefault` and its toggle. Approving a mention invite becomes one more way
to grant `u:<userId> rw`.

## Migration

1. Provision folders for every conversation (owned by its creator) and the pod folder grants.
2. Backfill `u:<userId> rw` for participants who can access the conversation today (`canAccess`),
   so that participants who lost a space don't get access back.
3. New conversations get a folder at creation, and approved mention invites write grants.
4. Enforce per workspace, shipping the popover at the same time.
5. Remove `urlAccessMode`, `privateConversationUrlsByDefault` and their UI.

Step 2 narrows access: non-participants who used the link lose access and get the no-access
message. This matches
[DOUBLE_WRITE.md](../../dfs/design-docs/DOUBLE_WRITE.md#authorization-contract): preserve or
narrow, never enlarge. Keeping link access would mean making everything readable, so searchable,
by everyone (see [Motivation](#motivation)).

## Open decisions

1. **Pod conversations.** Rec: pod membership only. Alt: local grants for outsiders.
2. **Migration.** Rec: narrow link access to participants. Alt: a temporary patch keeping link
   access (see [Motivation](#motivation)).
3. **API-created conversations.** Which folder and owner without a user?
4. **Sub-conversations.** TBD: nest the folder under the parent's, or handle them in the backfill
   by tracing back the user and adding grants.
5. **Session cache.** Rec: in memory, per process. Creating a session per request means an FDB
   write and a session record living an hour each, and misses the server's 30s auth cache.
   Alt: Redis, shared across pods, but session keys are bearer credentials.
6. **Ownership transfer.** Move the folder under another user?

## Maybe one day

### Access requests

Not planned. Links get shared outside Dust (Slack for instance), so asking for access can already
happen there, in the thread where the link was posted, with the person who shared it. Request flows
like Google Drive's tend to not be consistently used for a similar reason: the request goes to the
owner rather than the sharer, without much context, through a slower channel that is often
overflooded (emails).

If we ever build it:

- An `access_requests` table in front's Postgres (dfs has no workflow state, and the requester has
  no rights on the object), modeled on `membership_upgrade_requests`: requester, conversation,
  requested level, optional message, `pending | approved | denied | canceled`, resolver. At most
  one pending request per user and conversation.
- A "Request access" button on the no-access page, a Novu notification to the people with `rw`,
  and a pending requests section in the popover.
- Approving checks that the approver has `rw`, attaches the grant, then marks the request
  approved. For pod conversations, approving adds the requester to the pod.

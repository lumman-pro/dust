# Conversation sharing on dfs://

TL;DR: we want the dfs grants to decide who can access a conversation. As a result conversations
need to become private to their creator by default, with a "Share" button in the conversation
header that reads and updates the grants, and users who hit a conversation they can't access
can request access.

Builds on top of [API.md](API.md), [URI.md](URI.md) and [DOUBLE_WRITE.md](DOUBLE_WRITE.md). Open
decisions are at the end; the doc assumes we take the recommended option for each of them.

## Motivation

We're moving content to dfs, which will be the single source of truth for access: front, sandboxes,
search and browsing all rely on the same grants; dfs is authoritative and front a consumer.

Dfs will add search ([SEARCH.md](SEARCH.md)) and browsing (`List`, `/shared`) over everything a
user can read. Today any workspace member with a conversation's link can open it. That's fine only
because there's no way to discover a conversation you weren't given the URL to. With search and
browsing, "readable by the workspace" becomes "searchable by the workspace", and you shouldn't be
able to discover other people's conversations. So access has to be explicit: private by default,
opened by a grant.

From a purely tactical POV we could devise a system that makes the change seamless for a while
(update the grants in dfs in a way that allows sharing URLs directly); but my take on that is
that we will need to bite the bullet at some point so there is no need for a temporary patch.

## Scope

- In: standalone conversations, the share popover. Access requests are still a proposal, TBD.
- Out for v1: Frames (they keep their tables), sharing outside the workspace, per-conversation
  grants in pods (pod conversations follow pod membership).

## Model

- Dfs grants on the conversation folder are the authority. Front stores no copy.
- Front is the only writer, since `UpdateGrants` needs the tenant key. It checks the actor's own
  permission through dfs first.
- Front still enforces the data ceiling (`requestedSpaceIds`), see [Data ceiling](#data-ceiling).
- `conversation_participant` no longer grants access. It stays for the sidebar, unread state and
  notifications, will be used to backfill, and indexes user grants: every user grant has a
  participant row.

### Permissions

| Level       | Dfs                                             | Allows                                         |
| ----------- | ----------------------------------------------- | ---------------------------------------------- |
| View        | `r`                                             | Read messages and files.                       |
| Participate | `rw`                                            | Post, react, mention, run agents, write files. |
| Manage      | `rw` as owner or through an explicit `u:` grant | Change sharing, resolve requests.              |

- The owner is the creator (`isConversationCreator`). The folder lives under their user folder, so
  their access is inherited and the popover, which only edits local grants, can't remove it.
- `rw` through a pod's groups lets you participate, not manage.
- You can't grant above your own level. Nobody can remove the owner.
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
            conv-D/                   sub-conversation of S, inherits
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
grants on pod conversations: the popover shows the pod members, and a request goes to pod editors
and adds the requester to the pod, like `pending_project_membership` mentions today.

**Sub-conversations** (`run_agent`, `depth > 0`) have no participants and no stored parent. We
nest their folder under the parent's so they inherit. This needs the parent stored at creation.

## Data ceiling

`requestedSpaceIds` requires reading every listed space. Dfs grants are OR-only and can't express
that. A grant to someone who can't read one of these spaces would expose the conversation's files
through dfs (`/shared`, search), even if front blocks the page. So front:

1. **Read:** requires dfs `r` and `canReadRequestedSpaces`.
2. **Grant:** only grants users who pass the ceiling. The popover says why someone can't be added.
3. **Reconcile:** when the ceiling grows or someone loses a space, a Temporal job removes the
   grants that now exceed it. Participant rows bound the scan. Today's code already evicts
   participants when the ceiling grows.

Pod conversations keep their ceiling: read on the pod.

## Read path

- Front checks access with a dfs session holding the user's subjects (`getDfsSessionSubjects`),
  cached per user and subject set.
- `baseFetchWithAuthorization` loads the rows, batch `Stat`s their folders (up to 4,096), drops
  the ones without `r`, then applies the ceiling. The resource exposes `read` or `write`.
- No caching of `Stat` across requests: removing a grant applies on the next request.
- Fail closed: a dfs error is an error, never "not found" or "allowed".
- Shadow mode first (log diffs with today's check), then enforce per workspace behind a FF.

`canAccess` results:

| Result                            | When                          | UI                                   |
| --------------------------------- | ----------------------------- | ------------------------------------ |
| `conversation_not_found`          | No such conversation.         | "Conversation not found".            |
| `conversation_access_restricted`  | Fails the ceiling.            | Today's restricted page, no request. |
| `conversation_access_requestable` | Passes the ceiling, no grant. | "You need access", with request.     |

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
- Add people: workspace members, as View or Participate. Those failing the ceiling show as
  unavailable.
- Pending requests, for managers: Approve as View or Participate, or Deny.
- Copy link.

Read-only for non-managers.

```text
GET /api/w/:wId/assistant/conversations/:cId/sharing
-> {
     canManage: boolean
     owner: User
     members: { user: User, permission: "read" | "write" }[]
     pendingRequests?: AccessRequest[]           // Managers only.
   }

PATCH /api/w/:wId/assistant/conversations/:cId/sharing
{
  changes: {
    userId: string
    permission: "read" | "write" | "none"
  }[]
}
```

`GET` is `ListGrants` plus the owner and pod from front. `PATCH` checks the caller manages the
conversation, validates subjects (active member, ceiling) and sends one `UpdateGrants`. Adding
someone upserts their participant row (`subscribed`), notifies them and approves their pending
request. Removing someone deletes the row.

This removes `metadata.urlAccessMode`, the "Restrict URL access" menu item,
`privateConversationUrlsByDefault` and its toggle. Approving a mention invite becomes one more way
to grant `u:<userId> rw`.

## Access requests

Proposal, TBD.

Stored in front's Postgres. Dfs has no notion of workflow state, the requester has no rights on
the object, and xattrs are readable and writable by whoever has access.

`access_requests`, following `membership_upgrade_requests`:

```text
access_requests {
  id, sId, workspaceId, createdAt, updatedAt
  conversationId?: FK conversation       // Exactly one of conversationId and fileId is set.
  fileId?: FK file                       // Reserved for Frames.
  requesterUserId: FK user
  requestedPermission: "read" | "write"
  message?: string                       // At most 1,024 characters.
  status: "pending" | "approved" | "denied" | "canceled"
  resolvedByUserId?: FK user             // SET NULL on delete.
  resolvedAt?: Date
  grantedPermission?: "read" | "write"   // Can be lower than requested.
}
```

Indexes: partial unique `(workspaceId, conversationId, requesterUserId) WHERE status = 'pending'`
(same for `fileId`), `(workspaceId, conversationId, status)`, `(workspaceId, requesterUserId,
status)`. Requests are deleted with their conversation or file.

- **Request:** "You need access" with a "Request access" button, an optional message and a level.
  Idempotent, and shares the existing per-user limit (30 per day). Shows "pending" on revisit,
  with cancel. Only workspace members reach this page, and it shows no title, owner or
  participants.
- **Notify:** the managers, through a new Novu workflow (in-app and email, `transactionId` per
  request and manager). The link opens the popover on its pending requests.
- **Approve:** check the approver manages the conversation and the requester passes the ceiling,
  call `UpdateGrants`, then `pending → approved` (first resolver wins), upsert the participant and
  notify the requester. The grant goes first and re-attaching it is a no-op, so retries are safe.
  A pending request whose requester already has access is closed on read.
- **Deny:** silent. They can ask again within the rate limit.
- **Pod conversations:** pod editors resolve, and approving adds the requester to the pod.

Audit events: `conversation.access_requested`, `conversation.access_request_resolved`,
`conversation.sharing_updated`.

## Migration

1. Provision folders for every conversation (owned by its creator) and the pod folder grants.
2. Backfill `u:<userId> rw` for participants.
3. New conversations get a folder at creation, and approved mention invites write grants.
4. Shadow mode.
5. Enforce per workspace, shipping the popover and requests together.
6. Remove `urlAccessMode`, `privateConversationUrlsByDefault` and their UI.

Step 2 narrows access: non-participants who used the link lose access and go through requests.
This matches [DOUBLE_WRITE.md](DOUBLE_WRITE.md#authorization-contract): preserve or narrow, never
enlarge. Keeping link access would mean making everything readable, so searchable, by everyone
(see [Motivation](#motivation)).

## Open decisions

1. **Who manages.** Rec: owner and explicit `u:` rw. Alt: any `rw` (including through pod groups),
   or owner only.
2. **Pod conversations.** Rec: pod membership only. Alt: local grants for outsiders, which needs a
   ceiling for pod data.
3. **Data ceiling.** Rec: refuse grants above it, reconcile async. Alt: grant anyway and gate in
   front only, leaving restricted files readable through dfs.
4. **Migration.** Rec: narrow link access to participants. Alt: a temporary patch keeping link
   access (see [Motivation](#motivation)).
5. **Frames.** Rec: after conversations.
6. **Denied requests.** Rec: silent. Alt: notify, or a cooldown per conversation.
7. **API-created conversations.** Which folder and owner without a user?
8. **Sub-conversations.** Rec: store the parent and nest the folder. Alt: own folder, parent's
   owner.
9. **Session cache.** Memory or Redis? Session keys are bearer credentials.
10. **Ownership transfer.** Move the folder under another user?

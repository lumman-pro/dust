# Conversation sharing on dfs://

This document proposes making dfs grants the source of truth for who can access a conversation.
Standalone conversations become private to their creator by default. A share popover in the
conversation header reads and updates the grants, and users who open a conversation they cannot
access can request access.

It builds on the grant model of [API.md](API.md), the folder layout of [URI.md](URI.md) and the
authorization contract of [DOUBLE_WRITE.md](DOUBLE_WRITE.md). Decisions still open are listed at
the end; the rest of the document assumes the recommended option for each.

## Motivation

**One source of truth for content access.** Access rules are spread across front today: space
checks (`requestedSpaceIds`), the private URL setting and participant rows for conversations,
`shareable_files` and `sharing_grants` for Frames, and pod membership. Dfs already enforces grants
on every file operation, including from sandboxes. A second set of rules in front can disagree
with dfs, and every new surface has to reimplement it. With dfs as the authority, front,
sandboxes, search and browsing answer "who can see this" the same way.

**Search and browsing make conversations discoverable.** Dfs will provide search
([SEARCH.md](SEARCH.md)) and browsing (`List`, `/shared`) over everything a user can read. Today, a
standalone conversation can be opened by any workspace member who has its link. This is
acceptable only because nothing lets a user find a conversation they were not given: the URL acts
as the access control. With search and browsing, everything a user can read becomes discoverable,
so "readable by the whole workspace" would mean "searchable by the whole workspace". Users must
not be able to discover other people's conversations, so access has to be explicit: private by
default, and opened by a grant.

## Goals

- Dfs grants on a conversation's folder decide who can view it and who can participate in it.
  Front keeps no copy of them.
- A standalone conversation is only accessible to its creator until it is shared.
- Sharing is managed from a "Share" button in the conversation header, like Frames.
- A user who opens a conversation they cannot access can request access, and the conversation's
  managers can approve or deny the request.

Out of scope for the first version:

- Frames. Their sharing keeps its current tables; [Frames](#frames) reserves the subjects they
  would use.
- Sharing a conversation with people outside the workspace.
- Per-conversation grants inside pods: pod conversations follow pod membership.

## Today

- `ConversationResource.canAccess` decides access. A pod conversation requires read on the pod.
  A standalone one requires read on every space in `requestedSpaceIds`, plus a participant row
  when the workspace enables `privateConversationUrlsByDefault` and the conversation's
  `metadata.urlAccessMode` is `participants_only`. Otherwise anyone in the workspace with the
  link can open it.
- `conversation_participant` rows have no permission level. The only way to add another user is
  the mention flow: mentioning a non-participant asks the author "Invite X to this
  conversation?".
- A denied conversation renders "Conversation not found" or "You don't have access to this page",
  with no way to request access.
- Conversation folders exist (`getOrCreateConversationFolder`) but front does not call dfs on the
  conversation paths yet.

## Authority

| Concern | Authority |
| --- | --- |
| Who a conversation is shared with, and at which level | Dfs grants on the conversation folder |
| Data ceiling (`requestedSpaceIds`) | Front, at read time and when writing grants |
| Who can manage sharing | Front rule over dfs grants (see [Permissions](#permissions)) |
| Access requests | Front Postgres (`access_requests`) |
| Sidebar, unread state, notifications | `conversation_participant`, as a projection |

Front is the only writer of grants: `UpdateGrants` requires the tenant key. Before every change,
front checks the actor's own permission through dfs, then writes the grants. Grant changes are
read inside each dfs transaction, so a revocation applies to the next RPC.

`conversation_participant` stops granting access. It keeps listing a user's conversations,
tracking read state and driving notifications. Every explicit user grant has a participant row:
it is the index front uses to find a user's grants when reconciling (see
[Data ceiling](#data-ceiling)).

## Permissions

| Level | Dfs mode on the conversation folder | Allows |
| --- | --- | --- |
| View | `r` | Read messages and files. |
| Participate | `rw` | View, plus post and edit messages, react, mention, run agents, upload and write files. |
| Manage | `rw` as owner or through an explicit `u:` grant | Participate, plus change sharing and resolve access requests. |

- **Owner.** The creator of the conversation (`isConversationCreator`). Its folder is created
  under the creator's user folder, so the owner's access is inherited from `users/<userId>` and
  the share popover, which only edits the conversation folder's own grants, cannot remove it.
- **Managers.** The owner and users with an explicit `ALLOW u:<userId> rw` on the conversation
  folder. Write access inherited through a group (the workspace, a pod) allows participating, not
  managing.
- **Levels are bounded.** A manager can grant `r` or `rw`; nobody can grant more than their own
  level. Managers can remove any local grant; nobody can remove the owner.
- **Leaving.** A non-owner leaving removes their own grant and participant row. The owner cannot
  leave; they can delete the conversation.

Mutations of a conversation require Participate. Reading state (`lastReadAt`) and notification
preferences only require View.

## Grant layout

```text
<tenant-root>/
  users/
    U/                                DENY rw, ALLOW u:U rw            (existing)
      .conversations/
        conv-C/                       no local grant: only U
        conv-S/                       ALLOW u:V r                      (shared with V)
                                      ALLOW u:W rw                     (W manages too)
        conv-G/                       ALLOW g:<global group> rw        (whole workspace)
          .conversations/
            conv-D/                   sub-conversation of G, inherits
      pods/
        P/                            DENY rw, pod read and write grants
          .conversations/             ALLOW g:<pod member groups> rw
            conv-E/                   no local grant: pod members
```

- **Workspace sharing** is an ALLOW for the workspace's global group, which every member belongs
  to. "Workspace can view" is `r` and "workspace can participate" is `rw`.
- **Changing a level** detaches the old grant and attaches the new one in the same
  `UpdateGrants` request, as the API requires.
- **Discovery.** Every conversation shared with a user through an ALLOW appears in their `/shared`
  listing and their search results. A workspace-wide grant makes the conversation discoverable by
  every member.

### Pod conversations

A pod conversation's folder lives under the pod folder and inherits its grants. Every pod member
can participate in pod conversations, while pod files distinguish read and write, so the pod's
`.conversations/` folder carries an ALLOW `rw` for the pod's member groups. These pod grants
belong to pod folder provisioning (the TODO in `getOrCreatePodFolder`).

Pod conversation folders get no local grants. The share popover of a pod conversation shows the
pod's members and links to the pod's membership. An access request on a pod conversation goes to
the pod's editors, and approving it adds the requester to the pod, as the mention flow does today
with `pending_project_membership`.

### Sub-conversations

`run_agent` sub-conversations (`depth > 0`) have no participants, and the conversation model
stores no link to the parent conversation. Their folder is created under the parent's folder
(`conv-G/.conversations/conv-D`), so they inherit the parent's grants and get no local grants.
This requires passing the parent conversation when creating a sub-conversation, and storing it.

## Data ceiling

`requestedSpaceIds` requires a user to read every listed space. Dfs grants are a union of ALLOW
grants and cannot express this conjunction. A grant to a user who cannot read one of these spaces
would expose the conversation's files through dfs, such as their sandbox's `/shared`, even if
front blocks the conversation page.

Front therefore applies the ceiling in four places:

1. **Read.** Front requires dfs `r` and `canReadRequestedSpaces`. This blocks the UI and API
   immediately.
2. **Granting.** Front only writes a user grant if the user passes the ceiling. The share popover
   explains why a user cannot be added ("X can't access <space>").
3. **Workspace sharing.** It is only available when every requested space is readable by the
   global group. Otherwise the option is disabled.
4. **Reconciliation.** When the ceiling grows (`updateConversationRequirements`) or a user loses
   read on a space (group membership or space permission change), a Temporal job removes the
   grants that now exceed it: the workspace grant if the ceiling became restrictive, and the user
   grants of participants who fail it. Today's code already evicts participants when the ceiling
   grows. The participant rows bound this job to the affected users' conversations.

Between a ceiling change and reconciliation, the UI is protected by (1) and direct dfs access
lags by the job's delay. Pod conversations keep their current ceiling: read on the pod.

## Read path

- **Sessions.** Front authorizes with a dfs session holding the user's subjects
  (`getDfsSessionSubjects`). Sessions are cached per workspace, user and subject set, and
  refreshed before expiry. A change in the user's groups changes the subject set and creates a
  new session.
- **Fetching.** `baseFetchWithAuthorization` loads the conversation rows, then runs one batched
  `Stat` on their folders (up to 4,096 per call). Rows without `r` are dropped, then the ceiling
  applies. The fetched resource exposes the caller's level (`read` or `write`) for mutation
  checks.
- **Not cached.** Front does not cache `Stat` results across requests: a removed grant must take
  effect on the next request.
- **Denial.** `canAccess` distinguishes:

  | Result | Meaning | UI |
  | --- | --- | --- |
  | `conversation_not_found` | No such conversation in the workspace. | "Conversation not found". |
  | `conversation_access_restricted` | The user fails the ceiling. | Today's restricted page, no request. |
  | `conversation_access_requestable` | Passes the ceiling, no grant. | "You need access", with request. |

- **Availability.** Dfs is on the path of every conversation read. Front fails closed: a dfs error
  is an error, never "not found" or "allowed".
- **Shadow mode.** Before enforcing, front computes both decisions and records the differences,
  then enforces per workspace behind a feature flag.

## Actors

| Actor | Dfs session | Notes |
| --- | --- | --- |
| Signed-in user | `u:` and `g:` subjects | Owner of the conversations they create. |
| Agent loop, Temporal workers, `run_agent` | `superuser` | Act for a conversation after front authorized the triggering user. |
| Trigger | `superuser` | The conversation is created under the trigger editor's folder. |
| Slack and Teams | Mapped user's subjects | The mapped user owns the conversation. |
| Dust superuser (Poke) | `superuser` | Audited with `conversation.accessed`. |
| Sandbox | The user's subjects | Shared conversations appear under `/shared`. |
| API key without a user | `g:` subjects only | Ownership of API-created conversations is open. |

## Share popover and API

The conversation header (`ConversationTitle`) gets a "Share" button next to the existing chips,
built like `ShareFramePopover`. Its icon reflects the general access. The popover has:

- **General access:** "Only people added", "Anyone in <workspace> can view" or "Anyone in
  <workspace> can participate", disabled when the ceiling is restrictive.
- **People with access:** the owner, explicit user grants with their level, and for pod
  conversations the pod's members.
- **Add people:** search workspace members and pick View or Participate. Members who fail the
  ceiling are shown as unavailable.
- **Pending requests:** for managers, with Approve (View or Participate) and Deny.
- **Copy link.**

Non-managers see the same popover read-only.

```text
GET /api/w/:wId/assistant/conversations/:cId/sharing
-> {
     canManage: boolean
     generalAccess: "restricted" | "workspace_read" | "workspace_write"
     workspaceSharingAvailable: boolean
     owner: User
     members: { user: User, permission: "read" | "write" }[]
     pendingRequests?: AccessRequest[]           // Managers only.
   }

PATCH /api/w/:wId/assistant/conversations/:cId/sharing
{
  changes: {
    subject: { type: "user", userId: string } | { type: "workspace" }
    permission: "read" | "write" | "none"
  }[]
}
```

`GET` combines `ListGrants` on the conversation folder with front's view of the owner and pod.
`PATCH` checks that the caller manages the conversation, validates each subject (active member,
ceiling), and translates the changes into one `UpdateGrants` request. Adding a user upserts their
participant row as `subscribed` and notifies them; removing a user deletes it. It also resolves
the user's pending request (see [Access requests](#access-requests)).

This replaces `metadata.urlAccessMode`, the "Make URL accessible / Restrict URL access" menu item,
the workspace setting `privateConversationUrlsByDefault` and its governance toggle. Approving a
mention invite becomes one more way to grant `u:<userId> rw`.

## Access requests

Requests live in front's Postgres, not in dfs:

- They are workflow state (status, message, resolver, notifications), which dfs has no model for.
- The requester has no right on the object, so they cannot write anything there.
- Xattrs are readable and writable by anyone with access to the object.

### Model

`access_requests`, a `WorkspaceAwareModel` following `membership_upgrade_requests`:

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
  grantedPermission?: "read" | "write"   // Set when approved; may be lower than requested.
}
```

Indexes:

- Partial unique `(workspaceId, conversationId, requesterUserId) WHERE status = 'pending'`, and
  the same for `fileId`: at most one pending request per user and object.
- `(workspaceId, conversationId, status)`, to list a conversation's pending requests.
- `(workspaceId, requesterUserId, status)`, to show a user their own pending request.

Requests are deleted with their conversation or file.

### Flows

- **Request.** A user who gets `conversation_access_requestable` sees "You need access" and a
  "Request access" button, with an optional message and level. Creating a request is idempotent:
  an existing pending request is returned. Requests share the existing per-user limit
  (`access_requests:<userSId>`, 30 per day). On a later visit, the page shows that the request is
  pending, and the user can cancel it.
- **Notify.** The managers are notified by a new Novu workflow with an in-app and an email step,
  deduplicated per request and manager (`transactionId`). Notifications only carry links: the link
  opens the conversation with the share popover on its pending requests.
- **Approve.** Front checks that the approver manages the conversation (through dfs) and that the
  requester passes the ceiling. It then attaches the grant with `UpdateGrants`, marks the request
  approved with a conditional update from `pending` (the first resolver wins), upserts the
  participant row and notifies the requester. The grant is written first and attaching it again is
  a no-op, so a retry is safe. A pending request whose requester already has the requested level
  is closed as approved when read.
- **Deny.** The request is marked denied and the requester is not notified. They can request
  again, within the rate limit.
- **Direct share.** Sharing with a user through the popover approves their pending request.
- **Pod conversations.** Pod editors resolve the request, and approving adds the requester to the
  pod.

### Disclosure

The "You need access" page is only reachable by workspace members. It reveals that the
conversation exists, which the link already implies, but not its title, owner or participants.

### Audit events

- `conversation.access_requested`
- `conversation.access_request_resolved`, with the status and granted level.
- `conversation.sharing_updated`, with the changed subjects and levels.

## Migration

1. **Folders.** Provision folders for every conversation, owned by its creator, and the pod
   folder grants.
2. **Grants.** Backfill `ALLOW u:<userId> rw` for every participant other than the owner.
   Conversations explicitly set to `workspace_members` get the workspace grant when the ceiling
   allows it.
3. **Write path.** New conversations get their folder at creation, and approved mention invites
   write grants.
4. **Shadow mode.** Record the differences between today's decision and the dfs decision.
5. **Enforce** per workspace, shipping the share popover and access requests at the same time.
6. **Clean up** `urlAccessMode`, `privateConversationUrlsByDefault` and their UI.

Step 2 narrows access: workspace members who could open a conversation through its link without
being participants lose access and go through the request flow. This follows the rule of
[DOUBLE_WRITE.md](DOUBLE_WRITE.md#authorization-contract): preserve or narrow, never enlarge.
Preserving link access would require a workspace grant on every conversation, which would make
every conversation searchable and browsable by every member (see [Motivation](#motivation)).

## Frames

Frames keep `shareable_files` and `sharing_grants` for now. Moving them to dfs would use these
subjects, asserted by front when it creates the viewer's session:

| Frame scope | Subject |
| --- | --- |
| Workspace members | `g:<global group>` |
| Invited member | `u:<userId>` |
| Invited external email, after code verification | `e:<email>` |
| Invited domain, after code verification | `d:<domain>` |
| Anyone with the link | `l:<shareLinkId>`, asserted for anonymous visitors holding the token |

A Frame also reads the files of its `authorized_file_access` allowlist, which would need the same
grants. Requests on Frames would use `access_requests.fileId`.

## Open decisions

The document assumes the recommended option of each decision.

1. **Who manages sharing.** Recommended: the owner and explicit user grantees with `rw`.
   Alternatives: anyone with `rw`, including through the workspace grant; the owner only.
2. **Pod conversations.** Recommended: pod membership only, with requests resolved by adding the
   requester to the pod. Alternative: local grants for people outside the pod, which requires a
   ceiling for pod data.
3. **Data ceiling.** Recommended: refuse grants above the ceiling and reconcile asynchronously.
   Alternative: grant anyway and only gate in front, which leaves restricted files readable
   through dfs.
4. **Migration.** Recommended: narrow link access to participants and explicit
   `workspace_members` conversations. Alternative: a workspace grant on every conversation whose
   ceiling allows it, which makes all of them discoverable.
5. **Frames.** Recommended: after conversations, with the subjects above reserved now.
6. **Workspace sharing with a single restricted space.** Recommended: unavailable. Alternative:
   grant that space's groups instead of the global group, which is exactly "workspace members who
   can read the space".
7. **Workspace policy.** Whether admins can disable workspace-wide conversation sharing, reusing
   `sharingPolicy` or with a new setting.
8. **Denied requests.** Recommended: silent, with the rate limit as the only throttle.
   Alternatives: notify the requester; a cooldown per conversation.
9. **API-created conversations.** Which folder and owner a conversation created by an API key
   without a user gets.
10. **Sub-conversations.** Recommended: store the parent conversation and nest the folder under
    it. Alternative: give them their own folder with the parent's owner.
11. **Session cache.** Process memory or Redis, given that a session key is a bearer credential.
12. **Ownership transfer.** Whether the owner can hand a conversation over, which moves its folder
    under another user folder.

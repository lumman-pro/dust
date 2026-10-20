// @vitest-environment node
import type { DfsFolderContext } from "@app/lib/api/dfs/folders";
import {
  DFS_CONVERSATION_FOLDER_MIME_TYPE,
  DFS_DISPLAY_NAME_XATTR,
  DFS_POD_ID_XATTR,
  DFS_POD_FOLDER_MIME_TYPE,
  getOrCreateConversationFolder,
  getOrCreatePodFolder,
  getOrCreateUserFolder,
} from "@app/lib/api/dfs/folders";
import { Authenticator } from "@app/lib/auth";
import { DfsClient } from "@app/lib/dfs/client";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { podFolderUri } from "@app/lib/dfs/folders";
import { formatDfsUri } from "@app/lib/dfs/uri";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { DfsUserFolderResource } from "@app/lib/resources/dfs_user_folder_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { FakeDfsTransport } from "@app/tests/utils/dfs/FakeDfsTransport";
import { InMemoryDfs } from "@app/tests/utils/dfs/InMemoryDfs";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { MembershipFactory } from "@app/tests/utils/MembershipFactory";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { UserFactory } from "@app/tests/utils/UserFactory";
import type { DfsObjectId } from "@app/types/dfs";
import { Ok } from "@app/types/shared/result";
import { describe, expect, it } from "vitest";

function setup() {
  const dfs = new InMemoryDfs();
  const transport = new FakeDfsTransport({ UpdateGrants: new Ok({}) });
  const context: DfsFolderContext = {
    fs: new DfsFileSystem(dfs),
    tenantClient: new DfsClient(transport, "t".repeat(64)),
    rootId: dfs.rootId,
  };
  return { dfs, transport, context };
}

async function metadataOf(
  context: DfsFolderContext,
  folderId: DfsObjectId | null | undefined
) {
  if (!folderId) {
    return undefined;
  }
  const folder = await context.fs.stat(formatDfsUri(folderId), {
    includeMetadata: true,
  });
  return folder.isOk() ? folder.value?.attr.metadata : undefined;
}

async function createConversation(
  auth: Authenticator,
  { spaceModelId }: { spaceModelId?: number } = {}
) {
  const conversation = await ConversationFactory.create(auth, {
    agentConfigurationId: "dust",
    messagesCreatedAt: [],
    spaceId: spaceModelId,
  });
  const resource = await ConversationResource.fetchById(auth, conversation.sId);
  if (!resource) {
    throw new Error("Conversation not found.");
  }
  return resource;
}

describe("getOrCreateUserFolder", () => {
  it("creates the folder, restricts it to the user and stores it", async () => {
    const { authenticator, user } = await createResourceTest({});
    const { dfs, transport, context } = setup();

    const res = await getOrCreateUserFolder(authenticator, context, user);

    expect(res.isOk()).toBe(true);
    expect(dfs.paths()).toEqual(["/users", `/users/${user.sId}`]);
    const stored = await DfsUserFolderResource.fetchByUser(authenticator, user);
    expect(res.isOk() && res.value).toBe(stored?.dfsObjectId);
    expect(transport.calls.map((c) => c.request)).toEqual([
      {
        objectId: { value: Buffer.from(stored?.dfsObjectId ?? "", "hex") },
        changes: [
          { grant: { deny: { mode: 6 } }, remove: false },
          {
            grant: { allow: { subject: `u:${user.sId}`, mode: 6 } },
            remove: false,
          },
        ],
      },
    ]);
  });

  it("returns the stored folder without calling dfs", async () => {
    const { authenticator, user } = await createResourceTest({});
    const { dfs, transport, context } = setup();
    const first = await getOrCreateUserFolder(authenticator, context, user);
    const applyCalls = dfs.applyCalls.length;
    const grantCalls = transport.calls.length;

    const second = await getOrCreateUserFolder(authenticator, context, user);

    expect(second.isOk() && first.isOk() && second.value).toBe(
      first.isOk() && first.value
    );
    expect(dfs.applyCalls).toHaveLength(applyCalls);
    expect(transport.calls).toHaveLength(grantCalls);
  });

  it("reuses a folder that exists in dfs but is not stored, without changing its grants", async () => {
    const { authenticator, user } = await createResourceTest({});
    const { dfs, transport, context } = setup();
    const users = dfs.createDirectory(dfs.rootId, "users");
    const existing = dfs.createDirectory(users, user.sId);

    const res = await getOrCreateUserFolder(authenticator, context, user);

    expect(res.isOk() && res.value).toBe(existing);
    expect(transport.calls).toHaveLength(0);
  });
});

describe("getOrCreatePodFolder", () => {
  it("creates the pod folder, named after the pod, under the given user's folder", async () => {
    const { authenticator, workspace, user } = await createResourceTest({});
    const { dfs, context } = setup();
    const pod = await SpaceFactory.project(workspace, undefined, {
      name: "Q3/Q4 plan",
    });

    const res = await getOrCreatePodFolder(authenticator, context, pod, {
      user,
    });

    expect(res.isOk()).toBe(true);
    expect(dfs.paths()).toContain(`/users/${user.sId}/pods/Q3%2FQ4 plan`);
    const stored = await SpaceResource.fetchById(authenticator, pod.sId);
    expect(res.isOk() && res.value).toBe(stored?.dfsObjectId);
    const metadata = await metadataOf(context, stored?.dfsObjectId);
    expect(metadata?.mimeType).toBe(DFS_POD_FOLDER_MIME_TYPE);
    expect(
      Buffer.from(metadata?.xattrs[DFS_DISPLAY_NAME_XATTR] ?? []).toString()
    ).toBe("Q3/Q4 plan");
    expect(
      Buffer.from(metadata?.xattrs[DFS_POD_ID_XATTR] ?? []).toString()
    ).toBe(pod.sId);
  });

  it("reuses an existing folder of the same pod", async () => {
    const { authenticator, workspace, user } = await createResourceTest({});
    const { dfs, context } = setup();
    const pod = await SpaceFactory.project(workspace);
    const userFolderId = await getOrCreateUserFolder(
      authenticator,
      context,
      user
    );
    if (userFolderId.isErr()) {
      throw userFolderId.error;
    }
    // E.g. created by a call that failed before storing its ID.
    const existing = await context.fs.mkdir(
      podFolderUri(userFolderId.value, pod.name),
      { xattrs: { [DFS_POD_ID_XATTR]: Buffer.from(pod.sId) } }
    );

    const res = await getOrCreatePodFolder(authenticator, context, pod, {
      user,
    });

    expect(res.isOk() && existing.isOk() && res.value).toBe(
      existing.isOk() && existing.value.attr.id
    );
    expect(dfs.paths().filter((path) => path.includes("/pods/"))).toEqual([
      `/users/${user.sId}/pods/${pod.name}`,
    ]);
  });

  it("fails instead of reusing the folder of another pod with the same name", async () => {
    const { authenticator, workspace, user } = await createResourceTest({});
    const { dfs, context } = setup();
    const pod = await SpaceFactory.project(workspace);
    const userFolderId = await getOrCreateUserFolder(
      authenticator,
      context,
      user
    );
    if (userFolderId.isErr()) {
      throw userFolderId.error;
    }
    // E.g. the folder of a deleted pod that had the same name.
    const pods = dfs.createDirectory(userFolderId.value, "pods");
    const other = dfs.createDirectory(pods, pod.name);

    const res = await getOrCreatePodFolder(authenticator, context, pod, {
      user,
    });

    expect(res.isErr() && res.error.code).toBe("already_exists");
    expect(dfs.paths().filter((path) => path.includes("/pods/"))).toEqual([
      `/users/${user.sId}/pods/${pod.name}`,
    ]);
    expect(other).toBeDefined();
  });

  it("uses the first editor of the pod when no user is given", async () => {
    const { authenticator, workspace } = await createResourceTest({});
    const { dfs, context } = setup();
    const editor = await UserFactory.basic();
    await MembershipFactory.associate(workspace, editor, { role: "user" });
    const pod = await SpaceFactory.project(workspace, editor.id);

    const res = await getOrCreatePodFolder(authenticator, context, pod);

    expect(res.isOk()).toBe(true);
    expect(dfs.paths()).toContain(`/users/${editor.sId}/pods/${pod.name}`);
  });

  it("returns the folder stored by a concurrent call", async () => {
    const { authenticator, workspace, user } = await createResourceTest({});
    const { context } = setup();
    const other = await UserFactory.basic();
    const pod = await SpaceFactory.project(workspace);
    // Two snapshots fetched before either call stored a folder.
    const [first] = await SpaceResource.fetchByModelIds(authenticator, [
      pod.id,
    ]);
    const [second] = await SpaceResource.fetchByModelIds(authenticator, [
      pod.id,
    ]);

    const stored = await getOrCreatePodFolder(authenticator, context, first, {
      user,
    });
    const res = await getOrCreatePodFolder(authenticator, context, second, {
      user: other,
    });

    expect(stored.isOk()).toBe(true);
    expect(res.isOk() && stored.isOk() && res.value).toBe(
      stored.isOk() && stored.value
    );
  });

  it("refuses a space that is not a pod", async () => {
    const { authenticator, workspace } = await createResourceTest({});
    const { context } = setup();
    const space = await SpaceFactory.regular(workspace);

    const res = await getOrCreatePodFolder(authenticator, context, space);

    expect(res.isErr() && res.error.code).toBe("invalid_input");
  });
});

describe("getOrCreateConversationFolder", () => {
  it("creates a conversation outside pods under its first participant's folder", async () => {
    const { authenticator, user } = await createResourceTest({});
    const { dfs, context } = setup();
    const conversation = await createConversation(authenticator);
    await ConversationResource.upsertParticipation(authenticator, {
      conversation,
      action: "posted",
      user: user.toJSON(),
    });

    const res = await getOrCreateConversationFolder(
      authenticator,
      context,
      conversation
    );

    expect(res.isOk()).toBe(true);
    expect(dfs.paths()).toContain(
      `/users/${user.sId}/.conversations/conv-${conversation.sId}`
    );
    const stored = await ConversationResource.fetchById(
      authenticator,
      conversation.sId
    );
    expect(res.isOk() && res.value).toBe(stored?.dfsObjectId);
    expect((await metadataOf(context, stored?.dfsObjectId))?.mimeType).toBe(
      DFS_CONVERSATION_FOLDER_MIME_TYPE
    );
  });

  it("creates a conversation of a pod under the pod's folder", async () => {
    const { workspace, user } = await createResourceTest({});
    const { dfs, context } = setup();
    const pod = await SpaceFactory.project(workspace, user.id);
    // Refreshed so that it includes the new pod's groups.
    const auth = await Authenticator.fromUserIdAndWorkspaceId(
      user.sId,
      workspace.sId
    );
    const conversation = await createConversation(auth, {
      spaceModelId: pod.id,
    });

    const res = await getOrCreateConversationFolder(
      auth,
      context,
      conversation,
      { user }
    );

    expect(res.isOk()).toBe(true);
    expect(dfs.paths()).toContain(
      `/users/${user.sId}/pods/${pod.name}/.conversations/conv-${conversation.sId}`
    );
  });
});

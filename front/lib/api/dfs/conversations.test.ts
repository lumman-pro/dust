// @vitest-environment node
import { reflectConversationCreationOnDfs } from "@app/lib/api/dfs/conversations";
import { withDfsFolderContext } from "@app/lib/api/dfs/folder_context";
import { DfsClient } from "@app/lib/dfs/client";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { FakeDfsTransport } from "@app/tests/utils/dfs/FakeDfsTransport";
import { InMemoryDfs } from "@app/tests/utils/dfs/InMemoryDfs";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { Ok } from "@app/types/shared/result";
import { describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/dfs/folder_context", () => ({
  withDfsFolderContext: vi.fn(),
}));

function setup() {
  const dfs = new InMemoryDfs();
  const fs = new DfsFileSystem(dfs);
  const tenantClient = new DfsClient(
    new FakeDfsTransport({ UpdateGrants: new Ok({}) }),
    "t".repeat(64)
  );
  vi.mocked(withDfsFolderContext).mockImplementation(async (_auth, _o, fn) =>
    fn({
      fs,
      getSuperuserFs: async () => new Ok(fs),
      tenantClient,
      rootId: dfs.rootId,
    })
  );
  return { dfs };
}

async function createConversation(
  auth: Parameters<typeof ConversationFactory.create>[0]
) {
  const created = await ConversationFactory.create(auth, {
    agentConfigurationId: "dust",
    messagesCreatedAt: [],
  });
  const conversation = await ConversationResource.fetchById(auth, created.sId);
  if (!conversation) {
    throw new Error("Conversation not found.");
  }
  return conversation;
}

describe("reflectConversationCreationOnDfs", () => {
  it("creates the folder of a new conversation under its creator's folder", async () => {
    const { authenticator, user } = await createResourceTest({});
    await FeatureFlagFactory.basic(authenticator, "dust_file_system");
    const { dfs } = setup();
    const conversation = await createConversation(authenticator);

    await reflectConversationCreationOnDfs(authenticator, conversation);

    expect(dfs.paths()).toContain(
      `/users/${user.sId}/.conversations/conv-${conversation.sId}`
    );
    const stored = await ConversationResource.fetchById(
      authenticator,
      conversation.sId
    );
    expect(stored?.dfsObjectId).toBeTruthy();
  });

  it("does not throw when creating the folder throws", async () => {
    const { authenticator } = await createResourceTest({});
    await FeatureFlagFactory.basic(authenticator, "dust_file_system");
    setup();
    const conversation = await createConversation(authenticator);
    vi.mocked(withDfsFolderContext).mockRejectedValue(
      new Error("unique constraint")
    );

    await expect(
      reflectConversationCreationOnDfs(authenticator, conversation)
    ).resolves.toBeUndefined();
  });

  it("does nothing without the dust_file_system feature flag", async () => {
    const { authenticator } = await createResourceTest({});
    setup();
    const conversation = await createConversation(authenticator);

    await reflectConversationCreationOnDfs(authenticator, conversation);

    expect(withDfsFolderContext).not.toHaveBeenCalled();
  });
});

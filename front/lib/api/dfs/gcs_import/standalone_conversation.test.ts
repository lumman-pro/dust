// @vitest-environment node
import { importGcsStandaloneConversationFile } from "@app/lib/api/dfs/gcs_import/standalone_conversation";
import { Authenticator } from "@app/lib/auth";
import { formatDfsUri } from "@app/lib/dfs/uri";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { MembershipResource } from "@app/lib/resources/membership_resource";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { GcsImportFactory } from "@app/tests/utils/GcsImportFactory";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { MembershipFactory } from "@app/tests/utils/MembershipFactory";
import { FakeGcsStorageServer } from "@app/tests/utils/mocks/gcs_storage";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { UserFactory } from "@app/tests/utils/UserFactory";
import { DfsError } from "@app/types/dfs";
import { Err } from "@app/types/shared/result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.unmock("@app/lib/file_storage");

describe("importGcsStandaloneConversationFile", () => {
  const server = new FakeGcsStorageServer();

  beforeAll(async () => {
    vi.stubEnv("STORAGE_EMULATOR_HOST", await server.start());
  });

  beforeEach(() => server.reset());

  afterAll(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });

  it("imports under the creator's folder and skips completed copies", async () => {
    const { auth, source, conversation, user } =
      await GcsImportFactory.standaloneConversation();
    const participant = await GcsImportFactory.participant(auth, conversation);
    const { context, dfs, fs, transport } = GcsImportFactory.context();
    server.enqueueObject(source, "report");

    const importedRes = await importGcsStandaloneConversationFile(
      auth,
      source,
      context
    );
    expect(importedRes.isOk()).toBe(true);
    if (importedRes.isErr()) {
      return;
    }

    expect(dfs.paths()).toContain(
      `/users/${user.sId}/.conversations/conv-${conversation.sId}/nested/report.txt`
    );
    const bytesRes = await fs.readBuffer(formatDfsUri(importedRes.value));
    expect(bytesRes.isOk() && bytesRes.value.toString()).toBe("report");
    const stored = await ConversationResource.fetchById(auth, conversation.sId);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1].request).toEqual({
      objectId: { value: Buffer.from(stored?.dfsObjectId ?? "", "hex") },
      changes: expect.arrayContaining([
        {
          grant: { allow: { subject: `u:${participant.sId}`, mode: 6 } },
          remove: false,
        },
      ]),
    });

    const writes = dfs.applyCalls.length;
    server.enqueueObject(source, "report");
    expect(
      await importGcsStandaloneConversationFile(auth, source, context)
    ).toEqual(importedRes);
    expect(dfs.applyCalls).toHaveLength(writes);
    expect(transport.calls).toHaveLength(2);
  });

  it("reuses a moved folder and leaves subsequent sharing changes alone", async () => {
    const { auth, source, conversation, user } =
      await GcsImportFactory.standaloneConversation();
    const participant = await GcsImportFactory.participant(auth, conversation);
    const { context, dfs, fs, transport } = GcsImportFactory.context();
    server.enqueueObject(source, "report");
    expect(
      (await importGcsStandaloneConversationFile(auth, source, context)).isOk()
    ).toBe(true);
    const stored = await ConversationResource.fetchById(auth, conversation.sId);
    expect(stored?.dfsObjectId).toBeTruthy();
    if (!stored?.dfsObjectId) {
      return;
    }

    await context.folders.tenantClient.updateGrants({
      objectId: stored.dfsObjectId,
      changes: [
        {
          grant: { type: "allow", subject: `u:${participant.sId}`, mode: 6 },
          remove: true,
        },
      ],
    });
    expect(
      (
        await fs.move(
          formatDfsUri(dfs.rootId, {
            path: [
              "users",
              user.sId,
              ".conversations",
              `conv-${conversation.sId}`,
            ],
          }),
          formatDfsUri(dfs.rootId, { path: ["moved-conversation"] })
        )
      ).isOk()
    ).toBe(true);
    const anotherFile = GcsNotificationFactory.replicationSource({
      ...source,
      objectName: source.objectName.replace("report.txt", "100%2F.md"),
    });
    const grants = transport.calls.length;
    server.enqueueObject(anotherFile, "note");

    expect(
      (
        await importGcsStandaloneConversationFile(auth, anotherFile, context)
      ).isOk()
    ).toBe(true);
    expect(dfs.paths()).toContain("/moved-conversation/nested/100%2F.md");
    expect(transport.calls).toHaveLength(grants);
  });

  it("returns a folder grant error without copying any bytes", async () => {
    const { auth, source, conversation } =
      await GcsImportFactory.standaloneConversation();
    await GcsImportFactory.participant(auth, conversation);
    const { context, dfs } = GcsImportFactory.context();
    const updateGrants = context.folders.tenantClient.updateGrants.bind(
      context.folders.tenantClient
    );
    const error = new DfsError("unavailable");
    vi.spyOn(context.folders.tenantClient, "updateGrants")
      .mockImplementationOnce(updateGrants)
      .mockResolvedValueOnce(new Err(error));
    server.enqueueObject(source, "report");

    expect(
      await importGcsStandaloneConversationFile(auth, source, context)
    ).toEqual(new Err(error));
    expect(dfs.paths().some((path) => path.endsWith("report.txt"))).toBe(false);
  });

  it("requires the creator even when a link viewer can read the conversation", async () => {
    const { source, workspace, conversation } =
      await GcsImportFactory.standaloneConversation();
    const viewer = await UserFactory.basic();
    await MembershipFactory.associate(workspace, viewer, { role: "user" });
    const viewerAuth = await Authenticator.fromUserIdAndWorkspaceId(
      viewer.sId,
      workspace.sId
    );
    expect(
      await ConversationResource.canAccess(viewerAuth, conversation.sId)
    ).toBe("allowed");
    const { context, dfs, transport } = GcsImportFactory.context();

    expect(
      (
        await importGcsStandaloneConversationFile(viewerAuth, source, context)
      ).isErr()
    ).toBe(true);
    expect(server.requests).toHaveLength(0);
    expect(dfs.applyCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects a creator whose membership was revoked after authentication", async () => {
    const { auth, source, user, workspace } =
      await GcsImportFactory.standaloneConversation();
    await MembershipResource.revokeMembership({ user, workspace });
    const { context, dfs } = GcsImportFactory.context();

    expect(
      (await importGcsStandaloneConversationFile(auth, source, context)).isErr()
    ).toBe(true);
    expect(server.requests).toHaveLength(0);
    expect(dfs.applyCalls).toHaveLength(0);
  });

  it("rejects a creator who cannot read a requested space", async () => {
    const { auth, source, conversation, workspace } =
      await GcsImportFactory.standaloneConversation();
    const space = await SpaceFactory.regular(workspace);
    await ConversationFactory.setRequestedSpaceIdsForTest(
      conversation.id,
      workspace.id,
      [space.id]
    );
    const { context, dfs, transport } = GcsImportFactory.context();

    expect(
      (await importGcsStandaloneConversationFile(auth, source, context)).isErr()
    ).toBe(true);
    expect(server.requests).toHaveLength(0);
    expect(dfs.applyCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it.each([{ withCreator: false }, { depth: 1 }])(
    "rejects conversations without supported ownership: %j",
    async (options) => {
      const { auth, source } =
        await GcsImportFactory.standaloneConversation(options);
      const { context, dfs } = GcsImportFactory.context();
      expect(
        (
          await importGcsStandaloneConversationFile(auth, source, context)
        ).isErr()
      ).toBe(true);
      expect(server.requests).toHaveLength(0);
      expect(dfs.applyCalls).toHaveLength(0);
    }
  );

  it("rejects pod conversations and foreign-workspace sources before any I/O", async () => {
    const { auth, source } = await GcsImportFactory.podConversation();
    const other = await GcsImportFactory.standaloneConversation();
    const { context, dfs } = GcsImportFactory.context();
    expect(
      (await importGcsStandaloneConversationFile(auth, source, context)).isErr()
    ).toBe(true);
    expect(
      (
        await importGcsStandaloneConversationFile(other.auth, source, context)
      ).isErr()
    ).toBe(true);
    expect(server.requests).toHaveLength(0);
    expect(dfs.applyCalls).toHaveLength(0);
  });

  it("does not create a folder for a missing GCS object", async () => {
    const { auth, source } = await GcsImportFactory.standaloneConversation();
    const { context, dfs, transport } = GcsImportFactory.context();
    server.responses.push({ statusCode: 404 });
    expect(
      (await importGcsStandaloneConversationFile(auth, source, context)).isErr()
    ).toBe(true);
    expect(dfs.applyCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });
});

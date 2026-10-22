import { postUserMessage } from "@app/lib/api/assistant/conversation";
import { showCollabAgentActivity } from "@app/lib/api/collab/client";
import {
  DocumentConversationBusyError,
  dispatchCommentMentions,
  getCommentMentionStart,
  postCommentMention,
} from "@app/lib/api/documents/comment_mentions";
import type { NewCommentMessage } from "@app/lib/api/documents/comment_signatures";
import { Authenticator } from "@app/lib/auth";
import { notifyNewProjectConversation } from "@app/lib/notifications/triggers/project-new-conversation";
import { AgentResource } from "@app/lib/resources/agent_resource";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { launchDocumentCommentMentionWorkflow } from "@app/temporal/mentions_queue/client";
import { makeDocumentCommentMentionWorkflowId } from "@app/temporal/mentions_queue/helpers";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import {
  mockFullAgentMessage,
  mockUserMessage,
} from "@app/tests/utils/conversation_test_factories";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { GLOBAL_AGENTS_SID } from "@app/types/assistant/assistant";
import { Err, Ok } from "@app/types/shared/result";
import type { WorkspaceType } from "@app/types/user";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The message pipeline (agents, notifications) has its own tests; here only what is posted matters.
vi.mock(
  import("@app/lib/api/assistant/conversation"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    postUserMessage: vi.fn(),
  })
);

vi.mock(import("@app/lib/api/collab/client"), async (importOriginal) => ({
  ...(await importOriginal()),
  showCollabAgentActivity: vi.fn(),
}));

vi.mock(
  import("@app/lib/notifications/triggers/project-new-conversation"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    notifyNewProjectConversation: vi.fn(),
  })
);

vi.mock(
  import("@app/temporal/mentions_queue/client"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    launchDocumentCommentMentionWorkflow: vi.fn(),
  })
);

const AT = "2026-10-05T12:00:00.000Z";

const comment = (
  body: string,
  quote: string | null = "Ship on Thursday."
): NewCommentMessage => ({
  commentId: "c1",
  quote,
  message: {
    author: { kind: "user", id: "usr_tom", name: "Tom" },
    createdAt: AT,
    body,
  },
});

const DUST = `:mention[dust]{sId=${GLOBAL_AGENTS_SID.DUST}}`;
const YUKA = ":mention_user[Yuka]{sId=usr_yuka}";

const MENTIONING = comment(`Can ${DUST} check this with ${YUKA}?`);

const posted = (rank: number) =>
  new Ok({
    userMessage: { ...mockUserMessage("Posted."), rank },
    agentMessages: [],
  });

describe("postCommentMention", () => {
  let auth: Authenticator;
  let workspace: WorkspaceType;
  const postMock = vi.mocked(postUserMessage);
  const notified = vi.mocked(notifyNewProjectConversation);

  beforeEach(async () => {
    const setup = await createResourceTest({ role: "admin" });
    auth = setup.authenticator;
    workspace = setup.workspace;
    postMock.mockReset();
    postMock.mockResolvedValue(posted(2));
    notified.mockReset();
    vi.mocked(showCollabAgentActivity).mockReset();
    vi.mocked(showCollabAgentActivity).mockResolvedValue(new Ok(undefined));
  });

  const podMemberAuth = async () => {
    const pod = await SpaceFactory.project(
      workspace,
      auth.getNonNullableUser().id
    );
    const memberAuth = await Authenticator.fromUserIdAndWorkspaceId(
      auth.getNonNullableUser().sId,
      workspace.sId
    );
    return { pod, memberAuth };
  };

  it("posts a mentioning comment to the file's conversation", async () => {
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: GLOBAL_AGENTS_SID.DUST,
      messagesCreatedAt: [],
    });
    const documentPath = `conversation-${conversation.sId}/plan.md`;

    const result = await postCommentMention(auth, {
      documentPath,
      newMessage: comment(MENTIONING.message.body, "Ship  on\nThursday."),
    });

    expect(result.isOk()).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(1);
    const [, { conversationResource, content, mentions, context }] =
      postMock.mock.calls[0];
    expect(conversationResource.sId).toBe(conversation.sId);
    expect(context.origin).toBe("document_comment");
    expect(mentions).toEqual([{ configurationId: GLOBAL_AGENTS_SID.DUST }]);
    expect(content).toBe(
      `:document_comment[Ship on Thursday.]{id="c1" path="${documentPath}"}\n\n${MENTIONING.message.body}`
    );
  });

  it("leaves the quote out without one", async () => {
    const { pod, memberAuth } = await podMemberAuth();
    const documentPath = `pod-${pod.sId}/notes.md`;

    await postCommentMention(memberAuth, {
      documentPath,
      newMessage: comment(`Over to ${DUST}.`, null),
    });

    expect(postMock.mock.calls[0][1].content).toBe(
      `:document_comment[]{id="c1" path="${documentPath}"}\n\nOver to ${DUST}.`
    );
  });

  it("creates one conversation per pod document, reuses it and notifies the pod once", async () => {
    const { pod, memberAuth } = await podMemberAuth();
    const documentPath = `pod-${pod.sId}/notes.md`;
    postMock.mockResolvedValueOnce(posted(0));

    await postCommentMention(memberAuth, {
      documentPath,
      newMessage: MENTIONING,
    });
    await postCommentMention(memberAuth, {
      documentPath,
      newMessage: MENTIONING,
    });

    const linked = await ConversationResource.fetchLatestForDocument(
      memberAuth,
      { space: pod, documentPath }
    );
    expect(linked).not.toBeNull();
    expect(linked?.spaceId).toBe(pod.id);
    expect(postMock).toHaveBeenCalledTimes(2);
    for (const [, { conversationResource }] of postMock.mock.calls) {
      expect(conversationResource.sId).toBe(linked?.sId);
    }
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified.mock.calls[0][1].conversation.sId).toBe(linked?.sId);
  });

  it("does not notify the pod of a new conversation nothing was posted in", async () => {
    const { pod, memberAuth } = await podMemberAuth();
    postMock.mockResolvedValue(
      new Err({
        status_code: 403,
        api_error: { type: "workspace_auth_error", message: "Nope." },
      })
    );

    const result = await postCommentMention(memberAuth, {
      documentPath: `pod-${pod.sId}/notes.md`,
      newMessage: MENTIONING,
    });

    expect(result.isOk()).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(notified).not.toHaveBeenCalled();
  });

  it("notifies the pod on the first message posted after a failed one", async () => {
    const { pod, memberAuth } = await podMemberAuth();
    const documentPath = `pod-${pod.sId}/notes.md`;
    postMock
      .mockResolvedValueOnce(
        new Err({
          status_code: 403,
          api_error: { type: "workspace_auth_error", message: "Nope." },
        })
      )
      .mockResolvedValueOnce(posted(0));

    await postCommentMention(memberAuth, {
      documentPath,
      newMessage: MENTIONING,
    });
    expect(notified).not.toHaveBeenCalled();

    await postCommentMention(memberAuth, {
      documentPath,
      newMessage: MENTIONING,
    });
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("runs only the first agent mentioned, without the users mentioned", async () => {
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: GLOBAL_AGENTS_SID.DUST,
      messagesCreatedAt: [],
    });
    const claude = `:mention[claude]{sId=${GLOBAL_AGENTS_SID.CLAUDE_5_SONNET}}`;

    await postCommentMention(auth, {
      documentPath: `conversation-${conversation.sId}/plan.md`,
      newMessage: comment(`${DUST} ${YUKA} ${claude} ${DUST} ${YUKA}`),
    });

    expect(postMock.mock.calls[0][1].mentions).toEqual([
      { configurationId: GLOBAL_AGENTS_SID.DUST },
    ]);
  });

  it("posts nothing, nor creates a conversation, for a comment mentioning only users", async () => {
    const { pod, memberAuth } = await podMemberAuth();
    const documentPath = `pod-${pod.sId}/notes.md`;

    const result = await postCommentMention(memberAuth, {
      documentPath,
      newMessage: comment(`Over to ${YUKA}.`),
    });

    expect(result.isOk()).toBe(true);
    expect(postMock).not.toHaveBeenCalled();
    expect(
      await ConversationResource.fetchLatestForDocument(memberAuth, {
        space: pod,
        documentPath,
      })
    ).toBeNull();
  });

  it("posts only when the conversation is idle, and waits while it is busy", async () => {
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: GLOBAL_AGENTS_SID.DUST,
      messagesCreatedAt: [],
    });
    postMock.mockResolvedValue(
      new Err({
        status_code: 409,
        api_error: {
          type: "invalid_request_error",
          message: "An agent or a compaction is running in this conversation.",
        },
      })
    );

    const result = await postCommentMention(auth, {
      documentPath: `conversation-${conversation.sId}/plan.md`,
      newMessage: MENTIONING,
    });

    expect(postMock.mock.calls[0][1].onlyWhenIdle).toBe(true);
    expect(result.isErr() && result.error).toBeInstanceOf(
      DocumentConversationBusyError
    );
    const [, { agent, activity }] = vi.mocked(showCollabAgentActivity).mock
      .calls[0];
    expect(agent).toMatchObject({
      agentId: GLOBAL_AGENTS_SID.DUST,
      commentId: "c1",
    });
    expect(activity).toBe("waiting");
  });

  it("stays busy when the waiting agent cannot be found", async () => {
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: GLOBAL_AGENTS_SID.DUST,
      messagesCreatedAt: [],
    });
    postMock.mockResolvedValue(
      new Err({
        status_code: 409,
        api_error: {
          type: "invalid_request_error",
          message: "An agent or a compaction is running in this conversation.",
        },
      })
    );
    vi.spyOn(AgentResource, "fetchById").mockRejectedValueOnce(
      new Error("Connection terminated")
    );

    const result = await postCommentMention(auth, {
      documentPath: `conversation-${conversation.sId}/plan.md`,
      newMessage: MENTIONING,
    });

    expect(result.isErr() && result.error).toBeInstanceOf(
      DocumentConversationBusyError
    );
    expect(showCollabAgentActivity).not.toHaveBeenCalled();
  });

  it("drops, without retrying, a comment whose post fails, showing nothing", async () => {
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: GLOBAL_AGENTS_SID.DUST,
      messagesCreatedAt: [],
    });
    postMock.mockResolvedValue(
      new Err({
        status_code: 403,
        api_error: { type: "workspace_auth_error", message: "Nope." },
      })
    );

    const documentPath = `conversation-${conversation.sId}/plan.md`;

    const result = await postCommentMention(auth, {
      documentPath,
      newMessage: MENTIONING,
    });

    expect(result.isOk()).toBe(true);
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(showCollabAgentActivity).not.toHaveBeenCalled();
  });

  it("shows the agent thinking again once posted", async () => {
    const configuration = await AgentConfigurationFactory.createTestAgent(
      auth,
      { name: "Writer" }
    );
    postMock.mockImplementation(
      async (_auth, { content, context }) =>
        new Ok({
          userMessage: { ...mockUserMessage(content), context },
          agentMessages: [mockFullAgentMessage({ configuration })],
        })
    );
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: GLOBAL_AGENTS_SID.DUST,
      messagesCreatedAt: [],
    });

    await postCommentMention(auth, {
      documentPath: `conversation-${conversation.sId}/plan.md`,
      newMessage: MENTIONING,
    });

    const shown = vi.mocked(showCollabAgentActivity);
    expect(shown).toHaveBeenCalledTimes(1);
    const [, { agent, activity }] = shown.mock.calls[0];
    expect(agent).toMatchObject({
      agentId: configuration.sId,
      name: "Writer",
      commentId: "c1",
    });
    expect(activity).toBe("thinking");
  });
});

describe("getCommentMentionStart", () => {
  let auth: Authenticator;
  let workspace: WorkspaceType;

  beforeEach(async () => {
    const setup = await createResourceTest({ role: "admin" });
    auth = setup.authenticator;
    workspace = setup.workspace;
  });

  const conversationPath = async (messagesCreatedAt: Date[]) => {
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: GLOBAL_AGENTS_SID.DUST,
      messagesCreatedAt,
    });
    return `conversation-${conversation.sId}/plan.md`;
  };

  it("gives the agent thinking in an idle conversation", async () => {
    const start = await getCommentMentionStart(auth, {
      documentPath: await conversationPath([]),
      newMessage: MENTIONING,
    });

    expect(start?.activity).toBe("thinking");
    expect(start?.agent).toMatchObject({
      agentId: GLOBAL_AGENTS_SID.DUST,
      name: "Dust",
      userId: auth.getNonNullableUser().sId,
      commentId: "c1",
    });
  });

  it("gives the agent waiting while another agent runs", async () => {
    const start = await getCommentMentionStart(auth, {
      documentPath: await conversationPath([new Date()]),
      newMessage: MENTIONING,
    });

    expect(start?.activity).toBe("waiting");
  });

  it("gives the agent thinking in a pod document, creating no conversation", async () => {
    const pod = await SpaceFactory.project(
      workspace,
      auth.getNonNullableUser().id
    );
    const documentPath = `pod-${pod.sId}/notes.md`;

    const start = await getCommentMentionStart(auth, {
      documentPath,
      newMessage: MENTIONING,
    });

    expect(start?.activity).toBe("thinking");
    expect(
      await ConversationResource.fetchLatestForDocument(auth, {
        space: pod,
        documentPath,
      })
    ).toBeNull();
  });

  it("gives none for a file without a conversation, or a comment mentioning no agent", async () => {
    const personal = await getCommentMentionStart(auth, {
      documentPath: `user-${auth.getNonNullableUser().sId}/notes.md`,
      newMessage: MENTIONING,
    });
    const usersOnly = await getCommentMentionStart(auth, {
      documentPath: await conversationPath([]),
      newMessage: comment(`Can ${YUKA} check?`),
    });

    expect(personal).toBeNull();
    expect(usersOnly).toBeNull();
  });
});

describe("dispatchCommentMentions", () => {
  let auth: Authenticator;
  const launched = vi.mocked(launchDocumentCommentMentionWorkflow);

  beforeEach(async () => {
    const setup = await createResourceTest({ role: "admin" });
    auth = setup.authenticator;
    launched.mockReset();
    launched.mockResolvedValue(new Ok(undefined));
    vi.mocked(showCollabAgentActivity).mockReset();
    vi.mocked(showCollabAgentActivity).mockResolvedValue(new Ok(undefined));
  });

  it("hands each mentioning message to a job keyed by the normalized document path", async () => {
    await dispatchCommentMentions(auth, {
      scopedPath: "pod-abc//notes.md",
      newMessages: [MENTIONING, comment("Looks good.")],
    });

    expect(launched).toHaveBeenCalledTimes(1);
    expect(launched.mock.calls[0][0]).toMatchObject({
      documentPath: "pod-abc/notes.md",
      newMessage: MENTIONING,
    });
  });

  it("hands nothing over for comments without mentions", async () => {
    await dispatchCommentMentions(auth, {
      scopedPath: "pod-abc/notes.md",
      newMessages: [comment("Looks good.")],
    });

    expect(launched).not.toHaveBeenCalled();
  });

  it("does not throw when handing over fails", async () => {
    launched.mockResolvedValue(new Err(new Error("Temporal is down.")));

    await expect(
      dispatchCommentMentions(auth, {
        scopedPath: "pod-abc/notes.md",
        newMessages: [MENTIONING],
      })
    ).resolves.toBeUndefined();
  });
});

describe("makeDocumentCommentMentionWorkflowId", () => {
  const id = (documentPath: string, newMessage: NewCommentMessage) =>
    makeDocumentCommentMentionWorkflowId({
      workspaceId: "w1",
      documentPath,
      newMessage,
    });

  it("is the same for the same message, so it is posted once", () => {
    expect(id("pod-abc/notes.md", MENTIONING)).toBe(
      id("pod-abc/notes.md", { ...MENTIONING, quote: "Another quote." })
    );
  });

  it("differs per document and per message", () => {
    const base = id("pod-abc/notes.md", MENTIONING);
    expect(id("pod-abc/other.md", MENTIONING)).not.toBe(base);
    expect(id("pod-abc/notes.md", comment("Edited."))).not.toBe(base);
  });
});

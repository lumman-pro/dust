import { publishEvent } from "@app/lib/api/assistant/streaming/events";
import { getMessageChannelId } from "@app/lib/api/assistant/streaming/helpers";
import { publishSandboxFunctionInvocationEvent } from "@app/lib/api/sandbox_functions/events";
import type { SandboxFunctionBlockingEvent } from "@app/lib/api/sandbox_functions/publish_blocking_event";
import {
  getSandboxFunctionBlockingEventChannel,
  publishSandboxFunctionBlockingEvent,
} from "@app/lib/api/sandbox_functions/publish_blocking_event";
import { notifyManualActionRequired } from "@app/lib/notifications/triggers/manual-action-required";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { SandboxFunctionInvocationResource } from "@app/lib/resources/sandbox_function_invocation_resource";
import { createPersistedSandboxFunctionInvocationTokenTestContext } from "@app/tests/utils/SandboxTokenFactory";
import { Ok } from "@app/types/shared/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/sandbox_functions/events", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@app/lib/api/sandbox_functions/events")
    >();
  return {
    ...actual,
    publishSandboxFunctionInvocationEvent: vi.fn(),
  };
});

vi.mock("@app/lib/api/assistant/streaming/events", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@app/lib/api/assistant/streaming/events")
    >();
  return {
    ...actual,
    publishEvent: vi.fn(),
  };
});

vi.mock(
  "@app/lib/notifications/triggers/manual-action-required",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@app/lib/notifications/triggers/manual-action-required")
      >();
    return {
      ...actual,
      notifyManualActionRequired: vi.fn(),
    };
  }
);

describe("publishSandboxFunctionBlockingEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("publishes blocking events to the invocation SSE without conversationCaller", async () => {
    const { auth, invocation, sandboxFunction } =
      await createPersistedSandboxFunctionInvocationTokenTestContext();

    const event = {
      type: "tool_approve_execution" as const,
      actionId: "sfa_test",
      created: Date.now(),
      inputs: {},
      metadata: {
        toolName: "tool",
        mcpServerName: "server",
        agentName: sandboxFunction.slug,
        icon: "ActionRobotIcon" as const,
      },
      sandboxFunctionId: sandboxFunction.sId,
      invocationId: invocation.sId,
    } as SandboxFunctionBlockingEvent;

    await publishSandboxFunctionBlockingEvent(auth, event, { invocation });

    expect(publishSandboxFunctionInvocationEvent).toHaveBeenCalledWith(event, {
      invocationId: invocation.sId,
    });
    expect(publishEvent).not.toHaveBeenCalled();
    expect(await getSandboxFunctionBlockingEventChannel(invocation)).toBe(
      `sandbox-function-invocation-${invocation.sId}`
    );
  });

  it("publishes blocking events to the conversation message channel with conversationCaller", async () => {
    const { auth, sandboxFunction, conversation, agentMessage, agentConfig } =
      await createPersistedSandboxFunctionInvocationTokenTestContext();

    const conversationCaller = {
      conversationId: conversation.sId,
      agentMessageId: agentMessage.sId,
      configurationId: agentConfig.sId,
      parentActionId: "act_1",
    };
    const invocation = await SandboxFunctionInvocationResource.makeNew(auth, {
      sandboxFunction,
      input: undefined,
      context: { conversationCaller },
    });

    const markSpy = vi
      .spyOn(ConversationResource, "markAsActionRequired")
      .mockResolvedValue(new Ok([1]));

    const event = {
      type: "tool_approve_execution" as const,
      actionId: "sfa_test",
      created: Date.now(),
      inputs: {},
      metadata: {
        toolName: "tool",
        mcpServerName: "server",
        agentName: sandboxFunction.slug,
        icon: "ActionRobotIcon" as const,
      },
      sandboxFunctionId: sandboxFunction.sId,
      invocationId: invocation.sId,
    } as SandboxFunctionBlockingEvent;

    await publishSandboxFunctionBlockingEvent(auth, event, { invocation });

    expect(publishSandboxFunctionInvocationEvent).not.toHaveBeenCalled();
    expect(publishEvent).toHaveBeenCalledWith({
      origin: "user_message_events",
      channel: getMessageChannelId(conversationCaller.agentMessageId),
      event: expect.stringContaining(`"conversationId":"${conversation.sId}"`),
    });
    expect(markSpy).toHaveBeenCalled();
    expect(notifyManualActionRequired).toHaveBeenCalled();
    expect(await getSandboxFunctionBlockingEventChannel(invocation)).toBe(
      getMessageChannelId(conversationCaller.agentMessageId)
    );
  });
});

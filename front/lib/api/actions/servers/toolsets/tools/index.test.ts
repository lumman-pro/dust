import { PERSONAL_SERVER_UNUSABLE_MESSAGE } from "@app/lib/actions/personal_actions";
import { getConversation } from "@app/lib/api/assistant/conversation/fetch";
import type { Authenticator } from "@app/lib/auth";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import type { MCPServerViewResource } from "@app/lib/resources/mcp_server_view_resource";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { makeExtra } from "@app/tests/utils/conversation_test_factories";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { MCPServerViewFactory } from "@app/tests/utils/MCPServerViewFactory";
import { RemoteMCPServerFactory } from "@app/tests/utils/RemoteMCPServerFactory";
import type { AgentConfigurationType } from "@app/types/assistant/agent";
import { isUserMessageType } from "@app/types/assistant/conversation";
import assert from "assert";
import { beforeEach, describe, expect, it } from "vitest";

import { TOOLS } from "./index";

describe("toolsets tools with a personal-credential server", () => {
  let auth: Authenticator;
  let agentConfiguration: AgentConfigurationType;
  let personalView: MCPServerViewResource;

  beforeEach(async () => {
    const setup = await createResourceTest({ role: "admin" });
    auth = setup.authenticator;

    const server = await RemoteMCPServerFactory.create(setup.workspace, {
      name: "personal_server",
    });
    personalView = await MCPServerViewFactory.create(
      setup.workspace,
      server.sId,
      setup.globalSpace
    );
    const updateRes = await personalView.updateOAuthUseCase(
      auth,
      "personal_actions"
    );
    if (updateRes.isErr()) {
      throw updateRes.error;
    }

    agentConfiguration = await AgentConfigurationFactory.createTestAgent(auth);
  });

  async function extraForMessage({ authorless }: { authorless: boolean }) {
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: agentConfiguration.sId,
      messagesCreatedAt: [new Date()],
      authorless,
    });
    const conversationRes = await getConversation(auth, conversation.sId);
    if (conversationRes.isErr()) {
      throw conversationRes.error;
    }
    const userMessage = conversationRes.value.content
      .flat()
      .find(isUserMessageType);
    assert(userMessage, "Expected a user message in the test conversation.");
    const conversationResource = await ConversationResource.fetchById(
      auth,
      conversation.sId
    );
    assert(conversationResource, "Expected the test conversation to exist.");

    return makeExtra(auth, conversationResource, {
      agentConfiguration,
      userMessage,
    });
  }

  function getTool(name: "list" | "enable") {
    const tool = TOOLS.find((tool) => tool.name === name);
    if (!tool) {
      throw new Error(`${name} tool not found`);
    }
    return tool;
  }

  async function listedToolsetIds(authorless: boolean): Promise<string[]> {
    const result = await getTool("list").handler(
      {},
      await extraForMessage({ authorless })
    );
    if (result.isErr()) {
      throw result.error;
    }
    return result.value.flatMap((output) =>
      output.type === "resource" && "id" in output.resource
        ? [String(output.resource.id)]
        : []
    );
  }

  it("lists it when a person wrote the message", async () => {
    expect(await listedToolsetIds(false)).toContain(personalView.sId);
  });

  it("leaves it out of the list for a message nobody wrote", async () => {
    expect(await listedToolsetIds(true)).not.toContain(personalView.sId);
  });

  it("refuses to enable it for a message nobody wrote", async () => {
    const result = await getTool("enable").handler(
      { toolsetId: personalView.sId },
      await extraForMessage({ authorless: true })
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected enabling the toolset to fail.");
    }
    expect(result.error.message).toBe(PERSONAL_SERVER_UNUSABLE_MESSAGE);
  });
});

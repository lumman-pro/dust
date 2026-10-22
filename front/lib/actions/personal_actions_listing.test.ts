import { buildServerSideMCPServerConfiguration } from "@app/lib/actions/configuration/helpers";
import { tryListMCPTools } from "@app/lib/actions/mcp_actions";
import { getCredentialModeDescriptionNote } from "@app/lib/actions/personal_actions";
import { InternalMCPServerInMemoryResource } from "@app/lib/resources/internal_mcp_server_in_memory_resource";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { MCPServerViewFactory } from "@app/tests/utils/MCPServerViewFactory";
import type { MCPOAuthUseCase } from "@app/types/oauth/lib";
import { describe, expect, it } from "vitest";

async function listToolsForOAuthUseCase({
  authorless,
  oAuthUseCase,
}: {
  authorless: boolean;
  oAuthUseCase: MCPOAuthUseCase;
}) {
  const { authenticator, globalSpace, workspace } = await createResourceTest({
    role: "admin",
  });

  const agentConfiguration = await AgentConfigurationFactory.createTestAgent(
    authenticator,
    { name: "Test Agent", description: "Test Agent" }
  );

  // google_calendar is OAuth-backed, so an admin can scope it to personal or
  // workspace credentials.
  const internalServer = await InternalMCPServerInMemoryResource.makeNew(
    authenticator,
    { name: "google_calendar", useCase: oAuthUseCase }
  );
  const view = await MCPServerViewFactory.create(
    workspace,
    internalServer.id,
    globalSpace
  );
  const updateRes = await view.updateOAuthUseCase(authenticator, oAuthUseCase);
  if (updateRes.isErr()) {
    throw new Error("Expected the OAuth use case update to succeed.");
  }

  const conversation = await ConversationFactory.create(authenticator, {
    agentConfigurationId: agentConfiguration.sId,
    messagesCreatedAt: [],
  });
  const { agentMessage } = await ConversationFactory.createAgentMessage(
    authenticator,
    { workspace, conversation, agentConfig: agentConfiguration }
  );
  const { userMessage } = await ConversationFactory.createUserMessage({
    auth: authenticator,
    workspace,
    conversation,
    content: "Hello",
    // The agent message factory sits at rank 0.
    rank: 1,
    authorless,
  });

  return tryListMCPTools(
    authenticator,
    {
      agentConfiguration,
      agentMessage,
      userMessage,
      clientSideActionConfigurations: [],
      conversation,
    },
    {
      jitServers: [
        buildServerSideMCPServerConfiguration({ mcpServerView: view }),
      ],
      skillServers: [],
      systemSkillServers: [],
    }
  );
}

describe("tryListMCPTools personal-actions servers", () => {
  it("lists a personal-actions server when a person wrote the message", async () => {
    const listed = await listToolsForOAuthUseCase({
      authorless: false,
      oAuthUseCase: "personal_actions",
    });
    expect(listed.map(({ serverName }) => serverName)).toContain(
      "google_calendar"
    );
  });

  it("leaves it out for a message nobody wrote", async () => {
    const listed = await listToolsForOAuthUseCase({
      authorless: true,
      oAuthUseCase: "personal_actions",
    });
    expect(listed.map(({ serverName }) => serverName)).not.toContain(
      "google_calendar"
    );
  });

  it("appends a personal-credentials note to tool descriptions for the model", async () => {
    const listed = await listToolsForOAuthUseCase({
      authorless: false,
      oAuthUseCase: "personal_actions",
    });
    const note = getCredentialModeDescriptionNote("personal_actions");
    expect(note).not.toBeNull();
    for (const tool of listed.flatMap(({ tools }) => tools)) {
      expect(tool.description).toContain(note);
    }
  });

  it("appends a workspace-credentials note to tool descriptions for the model", async () => {
    const listed = await listToolsForOAuthUseCase({
      authorless: false,
      oAuthUseCase: "platform_actions",
    });
    const note = getCredentialModeDescriptionNote("platform_actions");
    expect(note).not.toBeNull();
    for (const tool of listed.flatMap(({ tools }) => tools)) {
      expect(tool.description).toContain(note);
    }
  });
});

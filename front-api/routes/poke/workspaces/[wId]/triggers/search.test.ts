import { Authenticator } from "@app/lib/auth";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { createPokeApiMockRequest } from "@app/tests/utils/generic_poke_api_tests";
import { MembershipFactory } from "@app/tests/utils/MembershipFactory";
import { TriggerFactory } from "@app/tests/utils/TriggerFactory";
import { UserFactory } from "@app/tests/utils/UserFactory";
import { honoApp } from "@front-api/app";
import { describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/elasticsearch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@app/lib/api/elasticsearch")>();
  const { Ok } = await import("@app/types/shared/result");
  // No trigger has consumption, so every live trigger ranks at zero credits.
  return {
    ...actual,
    searchConsumptionAnalytics: async () =>
      new Ok({ aggregations: { by_trigger: { buckets: [] } } }),
  };
});

function request(workspaceId: string, body: Record<string, unknown>) {
  return honoApp.request(
    `/api/poke/workspaces/${workspaceId}/triggers/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ period: "days", days: 30, limit: 25, ...body }),
    }
  );
}

async function setup() {
  const { workspace, auth } = await createPokeApiMockRequest({
    method: "POST",
    role: "admin",
    isSuperUser: true,
  });
  const otherEditor = await UserFactory.withEmail("Jane.Doe@example.com");
  await MembershipFactory.associate(workspace, otherEditor, { role: "admin" });
  const otherEditorAuth = await Authenticator.fromUserIdAndWorkspaceId(
    otherEditor.sId,
    workspace.sId
  );

  const salesAgent = await AgentConfigurationFactory.createTestAgent(auth, {
    name: "Sales Digest",
  });
  const supportAgent = await AgentConfigurationFactory.createTestAgent(auth, {
    name: "Support Bot",
  });

  const byAgentName = await TriggerFactory.webhook(auth, {
    agentConfigurationId: salesAgent.sId,
    name: "Morning report",
  });
  const byEditorEmail = await TriggerFactory.webhook(otherEditorAuth, {
    agentConfigurationId: supportAgent.sId,
    name: "Weekly check",
  });
  const unrelated = await TriggerFactory.webhook(auth, {
    agentConfigurationId: supportAgent.sId,
    name: "Inbox sweep",
  });

  return {
    workspace,
    supportAgent,
    byAgentName,
    byEditorEmail,
    unrelated,
  };
}

describe("POST /api/poke/workspaces/:wId/triggers/search", () => {
  it("matches the agent name case-insensitively", async () => {
    const { workspace, byAgentName } = await setup();

    const response = await request(workspace.sId, { search: "sales DIGEST" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.triggers.map((t: { triggerId: string }) => t.triggerId)
    ).toEqual([byAgentName.sId]);
    expect(body.totalCount).toBe(1);
  });

  it("matches the editor email case-insensitively", async () => {
    const { workspace, byEditorEmail } = await setup();

    const response = await request(workspace.sId, { search: "jane.doe@" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.triggers.map((t: { triggerId: string }) => t.triggerId)
    ).toEqual([byEditorEmail.sId]);
  });

  it("combines search with the agent filter and paginates the matches", async () => {
    const { workspace, supportAgent, byEditorEmail, unrelated } = await setup();

    const response = await request(workspace.sId, {
      search: "support bot",
      filter: { agentIds: [supportAgent.sId] },
      limit: 1,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalCount).toBe(2);
    expect(body.triggers).toHaveLength(1);
    expect([byEditorEmail.sId, unrelated.sId]).toContain(
      body.triggers[0].triggerId
    );
  });
});

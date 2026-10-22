import { Authenticator } from "@app/lib/auth";
import { DfsTenantResource } from "@app/lib/resources/dfs_tenant_resource";
import { createPokeApiMockRequest } from "@app/tests/utils/generic_poke_api_tests";
import { honoApp } from "@front-api/app";
import { describe, expect, it } from "vitest";

function listDfs(workspaceId: string, query = "") {
  return honoApp.request(`/api/poke/workspaces/${workspaceId}/dfs${query}`);
}

describe("GET /api/poke/workspaces/:wId/dfs", () => {
  it("rejects requests without poke access", async () => {
    const { workspace } = await createPokeApiMockRequest({
      isSuperUser: false,
    });

    const response = await listDfs(workspace.sId);

    expect(response.status).toBe(401);
  });

  it("returns an empty listing without creating a tenant when the workspace has none", async () => {
    const { workspace } = await createPokeApiMockRequest({
      isSuperUser: true,
    });

    const response = await listDfs(workspace.sId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hasTenant: false,
      folderId: null,
      entries: [],
    });
    const auth = await Authenticator.internalAdminForWorkspace(workspace.sId);
    expect(await DfsTenantResource.fetchByWorkspace(auth)).toBeNull();
  });

  it("rejects a folder ID that is not a dfs object ID", async () => {
    const { workspace } = await createPokeApiMockRequest({
      isSuperUser: true,
    });

    const response = await listDfs(workspace.sId, "?folderId=not-an-id");

    expect(response.status).toBe(400);
  });
});

import { newDfsObjectId } from "@app/lib/dfs/object_id";
import { createPokeApiMockRequest } from "@app/tests/utils/generic_poke_api_tests";
import { honoApp } from "@front-api/app";
import { describe, expect, it } from "vitest";

function getDfsObject(workspaceId: string, objectId: string, query = "") {
  return honoApp.request(
    `/api/poke/workspaces/${workspaceId}/dfs/${objectId}${query}`
  );
}

describe("GET /api/poke/workspaces/:wId/dfs/:objectId", () => {
  it("rejects requests without poke access", async () => {
    const { workspace } = await createPokeApiMockRequest({
      isSuperUser: false,
    });

    const response = await getDfsObject(workspace.sId, newDfsObjectId());

    expect(response.status).toBe(401);
  });

  it("rejects an object ID that is not a dfs object ID", async () => {
    const { workspace } = await createPokeApiMockRequest({
      isSuperUser: true,
    });

    const response = await getDfsObject(workspace.sId, "not-an-id");

    expect(response.status).toBe(400);
  });

  it("rejects ancestor IDs that are not dfs object IDs", async () => {
    const { workspace } = await createPokeApiMockRequest({
      isSuperUser: true,
    });

    const response = await getDfsObject(
      workspace.sId,
      newDfsObjectId(),
      `?ancestorIds=${newDfsObjectId()},not-an-id`
    );

    expect(response.status).toBe(400);
  });

  it("fails when the workspace has no dfs tenant", async () => {
    const { workspace } = await createPokeApiMockRequest({
      isSuperUser: true,
    });

    const response = await getDfsObject(workspace.sId, newDfsObjectId());

    expect(response.status).toBe(500);
    expect((await response.json()).error.type).toBe("internal_server_error");
  });
});

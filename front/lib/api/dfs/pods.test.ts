// @vitest-environment node
import { syncPodFolderGrants } from "@app/lib/api/dfs/pods";
import { DfsClient } from "@app/lib/dfs/client";
import { newDfsObjectId } from "@app/lib/dfs/object_id";
import type { FakeDfsAnswer } from "@app/tests/utils/dfs/FakeDfsTransport";
import { FakeDfsTransport } from "@app/tests/utils/dfs/FakeDfsTransport";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { Ok } from "@app/types/shared/result";
import { describe, expect, it } from "vitest";

function setup(listGrants: FakeDfsAnswer) {
  const transport = new FakeDfsTransport({
    ListGrants: listGrants,
    UpdateGrants: new Ok({}),
  });
  return { transport, tenantClient: new DfsClient(transport, "t".repeat(64)) };
}

describe("syncPodFolderGrants", () => {
  it("attaches the missing grants and detaches the others in one call", async () => {
    const { workspace } = await createResourceTest({});
    const pod = await SpaceFactory.project(workspace);
    const [kept, missing] = await pod.fetchGrantReferences();
    const folderId = newDfsObjectId();
    const { transport, tenantClient } = setup(
      new Ok({
        grants: [
          { allow: { subject: `g:${kept.groupSId}`, mode: 6 } },
          { allow: { subject: "g:removed", mode: 6 } },
          { deny: { mode: 6 } },
        ],
      })
    );

    const res = await syncPodFolderGrants(tenantClient, folderId, pod);

    expect(res.isOk()).toBe(true);
    expect(transport.calls.map((c) => c.method)).toEqual([
      "ListGrants",
      "UpdateGrants",
    ]);
    expect(transport.calls[1]?.request.changes).toEqual([
      {
        grant: { allow: { subject: `g:${missing.groupSId}`, mode: 6 } },
        remove: false,
      },
      {
        grant: { allow: { subject: "g:removed", mode: 6 } },
        remove: true,
      },
      { grant: { deny: { mode: 6 } }, remove: true },
    ]);
  });

  it("does not update grants that already match", async () => {
    const { workspace } = await createResourceTest({});
    const pod = await SpaceFactory.project(workspace);
    const groups = await pod.fetchGrantReferences();
    const { transport, tenantClient } = setup(
      new Ok({
        grants: groups.map((group) => ({
          allow: { subject: `g:${group.groupSId}`, mode: 6 },
        })),
      })
    );

    const res = await syncPodFolderGrants(tenantClient, newDfsObjectId(), pod);

    expect(res.isOk()).toBe(true);
    expect(transport.calls.map((c) => c.method)).toEqual(["ListGrants"]);
  });
});

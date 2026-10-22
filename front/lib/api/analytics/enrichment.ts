import type { Authenticator } from "@app/lib/auth";
import { SpaceResource } from "@app/lib/resources/space_resource";
import { getFrontReplicaDbConnection } from "@app/lib/resources/storage";
import { TagResource } from "@app/lib/resources/tags_resource";
import { UserResource } from "@app/lib/resources/user_resource";
import type { LightWorkspaceType } from "@app/types/user";
import { QueryTypes } from "sequelize";

interface AgentMetaRow {
  sId: string;
  name: string;
  settings: string;
}

export async function fetchAgentMetadata(
  agentIds: string[],
  workspace: LightWorkspaceType
): Promise<Map<string, { name: string; settings: string }>> {
  if (agentIds.length === 0) {
    return new Map();
  }

  const readReplica = getFrontReplicaDbConnection();
  // oxlint-disable-next-line dust/noRawSql -- Matches existing Activity Report query pattern.
  const agents = await readReplica.query<AgentMetaRow>(
    `
    SELECT ac."sId",
           ac."name",
           CASE
             WHEN ac."status" = 'draft' THEN 'draft'
             WHEN ac."scope" = 'visible' THEN 'published'
             WHEN ac."scope" = 'hidden' THEN 'unpublished'
             ELSE 'unknown'
           END AS "settings"
    FROM "agent_configurations" ac
    WHERE ac."workspaceId" = :wId
      AND ac."sId" IN (:agentIds)
      AND ac."status" = 'active'
    `,
    {
      type: QueryTypes.SELECT,
      replacements: { wId: workspace.id, agentIds },
    }
  );

  return new Map(
    agents.map((a) => [a.sId, { name: a.name, settings: a.settings }])
  );
}

export async function fetchTagNames(
  auth: Authenticator,
  tagIds: string[]
): Promise<Map<string, string>> {
  if (tagIds.length === 0) {
    return new Map();
  }

  const tags = await TagResource.fetchByIds(auth, tagIds);
  return new Map(tags.map((t) => [t.sId, t.name]));
}

/**
 * @cc [owner:fabiencelier,label:security] space-names-fetchable-only
 * MUST only return the name of spaces the caller can fetch (`canFetch(auth)`), so a caller holding
 * no verb on a restricted pod never learns its name. Deleted spaces MUST be included, so conversations
 * of a since-deleted space keep reporting its name.
 */
export async function fetchSpaceNames(
  auth: Authenticator,
  spaceIds: string[]
): Promise<Map<string, string>> {
  if (spaceIds.length === 0) {
    return new Map();
  }

  const spaces = await SpaceResource.fetchByIds(auth, spaceIds, {
    includeDeleted: true,
  });
  return new Map(
    spaces.filter((s) => s.canFetch(auth)).map((s) => [s.sId, s.name])
  );
}

export async function fetchUserEmails(
  userIds: string[]
): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const users = await UserResource.fetchByIds(userIds);
  return new Map(users.map((u) => [u.sId, u.email]));
}

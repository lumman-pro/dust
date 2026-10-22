import { DEFAULT_MCP_ACTION_VERSION } from "@app/lib/actions/constants";
import { remoteMCPServerNameToSId } from "@app/lib/actions/mcp_helper";
import type { DefaultRemoteMCPServerConfig } from "@app/lib/actions/mcp_internal_actions/remote_servers";
import {
  DEFAULT_REMOTE_MCP_SERVERS,
  getDefaultRemoteMCPServerAuthorization,
  getDefaultRemoteMCPServerById,
} from "@app/lib/actions/mcp_internal_actions/remote_servers";
import type { RemoteMCPServerType } from "@app/lib/api/mcp";
import type { Authenticator } from "@app/lib/auth";
import { getFeatureFlags } from "@app/lib/auth";
import { isCreditBasedPlan } from "@app/lib/plans/plan_codes";
import type { WhitelistableFeature } from "@app/types/shared/feature_flags";

/**
 * @cc [owner:smb2268,label:product] feature-flag-overrides-plan-gate
 * A preset with `creditBasedPlansOnly` MUST be available when the workspace's plan satisfies
 * `isCreditBasedPlan` or the workspace has the preset's `featureFlag`, and unavailable otherwise.
 * A preset without `creditBasedPlansOnly` MUST be unavailable when it has a `featureFlag` the
 * workspace lacks.
 */
export function isAvailableToWorkspace(
  config: DefaultRemoteMCPServerConfig,
  {
    featureFlags,
    isCreditBased,
  }: { featureFlags: WhitelistableFeature[]; isCreditBased: boolean }
): boolean {
  const hasFlag =
    config.featureFlag !== undefined &&
    featureFlags.includes(config.featureFlag);

  if (config.creditBasedPlansOnly) {
    // The flag lets a workspace in regardless of its plan.
    return isCreditBased || hasFlag;
  }
  // Without a plan gate, the flag is simply required when set.
  return config.featureFlag === undefined || hasFlag;
}

export class DefaultRemoteMCPServerInMemoryResource {
  readonly id: string;
  private config: DefaultRemoteMCPServerConfig;

  constructor(id: string, config: DefaultRemoteMCPServerConfig) {
    this.id = id;
    this.config = config;
  }

  private static fetchById(
    auth: Authenticator,
    configId: number
  ): DefaultRemoteMCPServerInMemoryResource | null {
    const config = getDefaultRemoteMCPServerById(configId);
    if (!config) {
      return null;
    }

    const sId = remoteMCPServerNameToSId({
      remoteMCPServerId: config.id,
      workspaceId: auth.getNonNullableWorkspace().id,
    });

    return new this(sId, config);
  }

  static async listAvailableDefaultRemoteMCPServers(
    auth: Authenticator
  ): Promise<DefaultRemoteMCPServerInMemoryResource[]> {
    const resources: DefaultRemoteMCPServerInMemoryResource[] = [];
    const featureFlags = await getFeatureFlags(auth);
    const isCreditBased = isCreditBasedPlan(auth.getNonNullablePlan());

    for (const config of DEFAULT_REMOTE_MCP_SERVERS) {
      if (!isAvailableToWorkspace(config, { featureFlags, isCreditBased })) {
        continue;
      }

      const resource = this.fetchById(auth, config.id);
      if (resource) {
        resources.push(resource);
      }
    }

    return resources;
  }

  toJSON(): RemoteMCPServerType {
    return {
      sId: this.id,
      name: this.config.name,
      version: DEFAULT_MCP_ACTION_VERSION,
      description: this.config.description,
      icon: this.config.icon,
      authorization: getDefaultRemoteMCPServerAuthorization(this.config),
      tools: [], // There are no predefined tools for default remote servers
      documentationUrl: this.config.documentationUrl || null,
      availability: "manual" as const,
      allowMultipleInstances: true,
    };
  }
}

import type { CacheDataAPI } from "@viz/app/lib/data-apis/cache-data-api";
import type { RPCDataAPI } from "@viz/app/lib/data-apis/rpc-data-api";
import type { VisualizationDataAPI } from "@viz/app/lib/visualization-api";
import type { WriteFileParams } from "@viz/app/types";

/**
 * @cc [owner:flvndvd,label:security] shared-frame-file-access
 * A shared Frame viewed by an authenticated member MUST read and write files through RPC, which
 * enforces the member's file permissions, and MAY fall back to the read-only snapshot, without
 * revision metadata, for a file RPC cannot serve. An external viewer MUST only call functions
 * over RPC and MUST read files from the snapshot. Frame code MUST come from the snapshot.
 */
export class HybridDataAPI implements VisualizationDataAPI {
  constructor(
    private readonly cache: CacheDataAPI,
    private readonly rpc: RPCDataAPI,
    private readonly isAuthenticatedMember: boolean
  ) {}

  async callFunction(functionId: string, input?: unknown) {
    return this.rpc.callFunction(functionId, input);
  }

  async getUserIdentity() {
    if (!this.isAuthenticatedMember) {
      return this.cache.getUserIdentity();
    }

    return this.rpc.getUserIdentity();
  }

  async fetchFile(fileId: string) {
    if (!this.isAuthenticatedMember) {
      return this.cache.fetchFile(fileId);
    }

    const file = await this.rpc.fetchFile(fileId);
    return file ?? this.cache.fetchFile(fileId);
  }

  async writeFile(params: WriteFileParams) {
    if (!this.isAuthenticatedMember) {
      return this.cache.writeFile(params);
    }

    return this.rpc.writeFile(params);
  }

  async fetchCode(): Promise<string | null> {
    return this.cache.fetchCode();
  }
}

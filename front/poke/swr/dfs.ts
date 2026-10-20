import type {
  PokeDfsEntry,
  PokeDfsObject,
  PokeListDfs,
} from "@app/lib/api/poke/dfs";
import { emptyArray, useFetcher, useSWRWithDefaults } from "@app/lib/swr/swr";
import type { DfsObjectId } from "@app/types/dfs";
import type { LightWorkspaceType } from "@app/types/user";
import type { Fetcher } from "swr";

interface UsePokeDfsChildrenProps {
  owner: LightWorkspaceType;
  // Omitted for the tenant root.
  parentId?: DfsObjectId;
}

export function usePokeDfsChildren({
  owner,
  parentId,
}: UsePokeDfsChildrenProps) {
  const { fetcher } = useFetcher();
  const dfsFetcher: Fetcher<PokeListDfs> = fetcher;
  const query = parentId ? `?parentId=${parentId}` : "";
  const { data, error } = useSWRWithDefaults(
    `/api/poke/workspaces/${owner.sId}/dfs${query}`,
    dfsFetcher
  );

  return {
    entries: data?.entries ?? emptyArray<PokeDfsEntry>(),
    hasTenant: data?.hasTenant ?? true,
    directoryId: data?.directoryId ?? null,
    isLoading: !error && !data,
    isError: error,
  };
}

export function usePokeDfsObject({
  owner,
  objectId,
  ancestorIds,
}: {
  owner: LightWorkspaceType;
  objectId: DfsObjectId;
  // From the tenant root down to the object's parent.
  ancestorIds: DfsObjectId[];
}) {
  const { fetcher } = useFetcher();
  const objectFetcher: Fetcher<PokeDfsObject> = fetcher;
  const query = new URLSearchParams({ ancestorIds: ancestorIds.join(",") });
  const { data, error } = useSWRWithDefaults(
    `/api/poke/workspaces/${owner.sId}/dfs/${objectId}?${query.toString()}`,
    objectFetcher
  );

  return {
    object: data ?? null,
    isLoading: !error && !data,
    isError: error,
  };
}

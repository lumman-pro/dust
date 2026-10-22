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
  // The folder to list; omitted for the tenant root.
  folderId?: DfsObjectId;
}

export function usePokeDfsChildren({
  owner,
  folderId,
}: UsePokeDfsChildrenProps) {
  const { fetcher } = useFetcher();
  const dfsFetcher: Fetcher<PokeListDfs> = fetcher;
  const query = folderId ? `?folderId=${folderId}` : "";
  const { data, error } = useSWRWithDefaults(
    `/api/poke/workspaces/${owner.sId}/dfs${query}`,
    dfsFetcher
  );

  return {
    entries: data?.entries ?? emptyArray<PokeDfsEntry>(),
    hasTenant: data?.hasTenant ?? true,
    folderId: data?.folderId ?? null,
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

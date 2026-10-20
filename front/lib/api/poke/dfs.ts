import { getDfsTenantClient } from "@app/lib/api/dfs/clients";
import { withDfsSuperuserFileSystem } from "@app/lib/api/dfs/folder_context";
import type { Authenticator } from "@app/lib/auth";
import { formatDfsUri } from "@app/lib/dfs/uri";
import { DfsTenantResource } from "@app/lib/resources/dfs_tenant_resource";
import type { DfsGrant, DfsObjectId, DfsObjectKind } from "@app/types/dfs";
import { DfsError, isDfsObjectId } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

export interface PokeDfsEntry {
  name: string;
  id: DfsObjectId;
  kind: DfsObjectKind;
  size: number;
}

export interface PokeListDfs {
  hasTenant: boolean;
  // The listed folder, i.e. the tenant root when no parent is given. Null without a tenant.
  directoryId: DfsObjectId | null;
  entries: PokeDfsEntry[];
}

/**
 * The folders and files directly under `parentId` (default: the tenant root) in the authenticated
 * workspace's dfs tenant, folders first, then by name. Listed with a superuser session: only names
 * and attributes are read, never file contents. A workspace without a tenant gets an empty listing,
 * and no tenant is created.
 */
export async function listPokeDfsChildren(
  auth: Authenticator,
  { parentId }: { parentId?: DfsObjectId } = {}
): Promise<Result<PokeListDfs, Error>> {
  const tenant = await DfsTenantResource.fetchByWorkspace(auth);
  if (!tenant) {
    return new Ok({ hasTenant: false, directoryId: null, entries: [] });
  }
  const tenantClient = await getDfsTenantClient(auth);
  if (tenantClient.isErr()) {
    return tenantClient;
  }
  const directoryId = parentId ?? tenant.rootId;
  return withDfsSuperuserFileSystem(auth, tenantClient.value, async (fs) => {
    const listed = await fs.list(formatDfsUri(directoryId));
    if (listed.isErr()) {
      return listed;
    }
    const entries: PokeDfsEntry[] = [];
    for (const { name, object } of listed.value) {
      if (object && isDfsObjectId(object.attr.id)) {
        entries.push({
          name,
          id: object.attr.id,
          kind: object.attr.kind,
          size: object.attr.size,
        });
      }
    }
    entries.sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name)
    );
    return new Ok({ hasTenant: true, directoryId, entries });
  });
}

// What a session holding only `subject` can do on the object, and the object (the object itself
// or an ancestor) whose ALLOW last added permissions for it.
export interface PokeDfsEffectiveGrant {
  subject: string;
  mode: number;
  fromId: DfsObjectId;
}

export interface PokeDfsObject extends PokeDfsEntry {
  mimeType?: string;
  // Values decoded as UTF-8.
  xattrs: Record<string, string>;
  createdMs: number;
  mtimeMs?: number;
  effectiveGrants: PokeDfsEffectiveGrant[];
}

/**
 * The effective permissions of each subject on the last object of `chain` (from the tenant root
 * down to the object, with the grants attached to each), following the evaluation of
 * `dfs/design-docs/API.md`: at each object, its DENY grants remove inherited permissions for every
 * subject, then its ALLOW grants add permissions to their subject. Subjects left with no
 * permission are omitted.
 */
function computeEffectiveGrants(
  chain: { id: DfsObjectId; grants: DfsGrant[] }[]
): PokeDfsEffectiveGrant[] {
  const effective = new Map<string, PokeDfsEffectiveGrant>();
  for (const { id, grants } of chain) {
    const denyMode = grants.reduce(
      (mode, grant) => (grant.type === "deny" ? mode | grant.mode : mode),
      0
    );
    for (const grant of effective.values()) {
      grant.mode &= ~denyMode & 0o6;
    }
    for (const grant of grants) {
      if (grant.type !== "allow") {
        continue;
      }
      const current = effective.get(grant.subject);
      effective.set(grant.subject, {
        subject: grant.subject,
        mode: (current?.mode ?? 0) | grant.mode,
        fromId: id,
      });
    }
  }
  return [...effective.values()].filter((grant) => grant.mode !== 0);
}

/**
 * The attributes, metadata and effective grants of the object `objectId` in the authenticated
 * workspace's dfs tenant. `ancestorIds` are its ancestors, from the tenant root down to its parent.
 * Attributes are read with a superuser session and grants with the tenant key; file contents are
 * never read.
 */
export async function getPokeDfsObject(
  auth: Authenticator,
  objectId: DfsObjectId,
  { ancestorIds }: { ancestorIds: DfsObjectId[] }
): Promise<Result<PokeDfsObject, Error>> {
  const tenantClient = await getDfsTenantClient(auth);
  if (tenantClient.isErr()) {
    return tenantClient;
  }
  const chainIds = [...ancestorIds, objectId];
  return withDfsSuperuserFileSystem(auth, tenantClient.value, async (fs) => {
    const [object, ...grants] = await Promise.all([
      fs.stat(formatDfsUri(objectId), { includeMetadata: true }),
      ...chainIds.map((id) =>
        tenantClient.value.listAllGrants({ objectId: id })
      ),
    ]);
    if (object.isErr()) {
      return object;
    }
    if (!object.value) {
      return new Err(new DfsError("not_found", `Not found: ${objectId}.`));
    }
    const chain: { id: DfsObjectId; grants: DfsGrant[] }[] = [];
    for (const [i, res] of grants.entries()) {
      if (res.isErr()) {
        return res;
      }
      chain.push({ id: chainIds[i], grants: res.value });
    }
    const { attr } = object.value;
    const decoder = new TextDecoder();
    return new Ok({
      name: attr.name,
      id: objectId,
      kind: attr.kind,
      size: attr.size,
      mimeType: attr.metadata?.mimeType,
      xattrs: Object.fromEntries(
        Object.entries(attr.metadata?.xattrs ?? {}).map(([key, value]) => [
          key,
          decoder.decode(value),
        ])
      ),
      createdMs: attr.metadata?.createdMs ?? 0,
      mtimeMs: attr.mtimeMs,
      effectiveGrants: computeEffectiveGrants(chain),
    });
  });
}

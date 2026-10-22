import type { DfsClient } from "@app/lib/dfs/client";
import type { DfsGrantUpdate, DfsObjectId } from "@app/types/dfs";
import { DfsError } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

// See `UpdateGrants` in `dfs/design-docs/API.md`.
const MAX_GRANT_UPDATES = 512;

/** The modes of the ALLOW grants attached to `objectId`, by subject. */
async function listAllowModesBySubject(
  tenantClient: Pick<DfsClient, "listAllGrants">,
  objectId: DfsObjectId
): Promise<Result<Map<string, number[]>, DfsError>> {
  const grants = await tenantClient.listAllGrants({ objectId });
  if (grants.isErr()) {
    return grants;
  }
  const modes = new Map<string, number[]>();
  for (const grant of grants.value) {
    if (grant.type !== "allow") {
      continue;
    }
    const subjectModes = modes.get(grant.subject);
    if (subjectModes) {
      subjectModes.push(grant.mode);
    } else {
      modes.set(grant.subject, [grant.mode]);
    }
  }
  return new Ok(modes);
}

/**
 * The modes of the ALLOW grants attached to `objectId`, combined by subject. `tenantClient` MUST be
 * authenticated with the tenant key of the object's tenant.
 */
export async function listAllowModes(
  tenantClient: Pick<DfsClient, "listAllGrants">,
  { objectId }: { objectId: DfsObjectId }
): Promise<Result<Map<string, number>, DfsError>> {
  const modes = await listAllowModesBySubject(tenantClient, objectId);
  if (modes.isErr()) {
    return modes;
  }
  return new Ok(
    new Map(
      [...modes.value].map(([subject, subjectModes]) => [
        subject,
        subjectModes.reduce((combined, mode) => combined | mode, 0),
      ])
    )
  );
}

/**
 * Gives each subject of `changes` exactly one ALLOW with `mode` on `objectId`, or none when `mode`
 * is null, and returns the subjects whose grants changed. `tenantClient` MUST be authenticated with
 * the tenant key of the object's tenant. The grants are read then updated in two calls: concurrent
 * calls on the same subject can interleave.
 */
/**
 * @cc [owner:aubin-tchoi,label:security] set-subject-grants-exact
 * After a successful call, each subject of `changes` MUST hold exactly one ALLOW on `objectId`,
 * with `mode`, or none when `mode` is null. Grants of other subjects and DENY grants MUST be left
 * unchanged. The changes MUST be applied in a single `UpdateGrants` call, or none when nothing
 * differs, keeping an existing ALLOW that already has `mode` rather than removing and adding it
 * again. A subject listed twice, or more updates than `UpdateGrants` accepts, MUST yield
 * `invalid_input` without changing any grant.
 */
export async function setSubjectGrants(
  tenantClient: Pick<DfsClient, "listAllGrants" | "updateGrants">,
  {
    objectId,
    changes,
  }: {
    objectId: DfsObjectId;
    changes: { subject: string; mode: number | null }[];
  }
): Promise<Result<{ changedSubjects: string[] }, DfsError>> {
  if (new Set(changes.map((c) => c.subject)).size !== changes.length) {
    return new Err(
      new DfsError("invalid_input", "A subject can only be set once.")
    );
  }
  const existingModes = await listAllowModesBySubject(tenantClient, objectId);
  if (existingModes.isErr()) {
    return existingModes;
  }
  const updates: DfsGrantUpdate[] = [];
  const changedSubjects: string[] = [];
  for (const { subject, mode } of changes) {
    const modes = existingModes.value.get(subject) ?? [];
    const removed = modes.filter((existing) => existing !== mode);
    const added = mode !== null && !modes.includes(mode) ? mode : null;
    if (removed.length === 0 && added === null) {
      continue;
    }
    updates.push(
      ...removed.map((existing): DfsGrantUpdate => ({
        grant: { type: "allow", subject, mode: existing },
        remove: true,
      }))
    );
    if (added !== null) {
      updates.push({
        grant: { type: "allow", subject, mode: added },
        remove: false,
      });
    }
    changedSubjects.push(subject);
  }
  if (updates.length > MAX_GRANT_UPDATES) {
    return new Err(
      new DfsError(
        "invalid_input",
        `Too many grant updates: ${updates.length}.`
      )
    );
  }
  if (updates.length > 0) {
    const updated = await tenantClient.updateGrants({
      objectId,
      changes: updates,
    });
    if (updated.isErr()) {
      return updated;
    }
  }
  return new Ok({ changedSubjects });
}

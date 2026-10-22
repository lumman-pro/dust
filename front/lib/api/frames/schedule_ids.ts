import { createHash } from "node:crypto";

import { stableStringify } from "@app/types/shared/utils/stable_stringify";

const FRAME_SCHEDULE_ID_HASH_LENGTH = 8;
export const MAX_FRAME_SCHEDULE_ID_LENGTH = 64;

/**
 * @cc [owner:smb2268,label:product] schedule-id-is-derived-from-its-declaration
 * A schedule's id MUST be computed from its function name, cron, timezone and input, all four
 * hashed, and never declared in the manifest or stored on its own. Identical declarations MUST
 * yield the same id and a change to any of the four a different one, so reconciliation treats an
 * edited schedule as a new schedule and `(frameId, scheduleId)` identifies a schedule Frame-wide.
 * The id MUST be at most `MAX_FRAME_SCHEDULE_ID_LENGTH` characters.
 */
/**
 * @cc [owner:smb2268,label:architecture] schedule-id-derivation-is-server-only
 * This module uses Node builtins and MUST NOT be imported from code reachable by the front-spa
 * bundle (`front/types`, `front/components`, `front/hooks`, `front/lib/swr`).
 */
export function deriveFrameScheduleId({
  functionName,
  cron,
  timezone,
  input,
}: {
  functionName: string;
  cron: string;
  timezone: string;
  input: unknown;
}): string {
  // The name is hashed too: the readable prefix is truncated, so it alone cannot keep two long
  // function names apart.
  const digest = createHash("sha256")
    .update(
      JSON.stringify([functionName, cron, timezone, stableStringify(input)])
    )
    .digest("hex")
    .slice(0, FRAME_SCHEDULE_ID_HASH_LENGTH);
  const prefixLength =
    MAX_FRAME_SCHEDULE_ID_LENGTH - FRAME_SCHEDULE_ID_HASH_LENGTH - 1;
  return `${functionName.slice(0, prefixLength)}-${digest}`;
}

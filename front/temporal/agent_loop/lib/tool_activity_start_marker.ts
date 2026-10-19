import { runOnRedis } from "@app/lib/api/redis";

// Must outlive the tool activity start-to-close timeout plus any delay before the workflow claims
// the marker after the activity timed out, which can be long when agent loop workers are down or
// backlogged.
const TOOL_ACTIVITY_START_MARKER_TTL_SECONDS = 24 * 60 * 60;

type ToolActivityStartMarker = "started" | "abandoned" | "completed";

export type ToolActivityExecution = {
  workflowId: string;
  runId: string;
  activityId: string;
};

function makeToolActivityStartMarkerKey({
  workflowId,
  runId,
  activityId,
}: ToolActivityExecution): string {
  return `tool_activity_start_marker:${workflowId}:${runId}:${activityId}`;
}

async function setToolActivityStartMarkerIfAbsent(
  execution: ToolActivityExecution,
  marker: ToolActivityStartMarker
): Promise<string | null> {
  const key = makeToolActivityStartMarkerKey(execution);

  return runOnRedis({ origin: "tool_activity_start_marker" }, async (redis) => {
    const result = await redis.set(key, marker, {
      NX: true,
      EX: TOOL_ACTIVITY_START_MARKER_TTL_SECONDS,
    });
    if (result === "OK") {
      return marker;
    }

    return redis.get(key);
  });
}

/**
 * @cc [owner:tdraier,label:error-handling;concurrency] start-unless-abandoned
 * Returns true unless `claimToolActivityNeverStarted` already succeeded for `execution`; once it
 * returns true, `claimToolActivityNeverStarted` returns false for `execution`. Redis failures
 * throw.
 */
export async function claimToolActivityStart(
  execution: ToolActivityExecution
): Promise<boolean> {
  const marker = await setToolActivityStartMarkerIfAbsent(execution, "started");

  return marker !== "abandoned";
}

/**
 * @cc [owner:tdraier,label:error-handling;concurrency] never-started-unless-claimed
 * Returns true unless `claimToolActivityStart` already returned true for `execution`; once it
 * returns true, `claimToolActivityStart` returns false for `execution`. Idempotent; Redis failures
 * throw.
 */
export async function claimToolActivityNeverStarted(
  execution: ToolActivityExecution
): Promise<boolean> {
  const marker = await setToolActivityStartMarkerIfAbsent(
    execution,
    "abandoned"
  );

  return marker === "abandoned";
}

/**
 * @cc [owner:tdraier,label:error-handling;concurrency] completed-only-after-start-claim
 * MUST only be called once `claimToolActivityStart` returned true for `execution`. For
 * `TOOL_ACTIVITY_START_MARKER_TTL_SECONDS` after it succeeds, `isToolActivityCompleted` returns true
 * and `claimToolActivityNeverStarted` keeps returning false for `execution`. Redis failures throw.
 */
export async function markToolActivityCompleted(
  execution: ToolActivityExecution
): Promise<void> {
  const key = makeToolActivityStartMarkerKey(execution);
  const marker: ToolActivityStartMarker = "completed";

  await runOnRedis({ origin: "tool_activity_start_marker" }, (redis) =>
    redis.set(key, marker, { EX: TOOL_ACTIVITY_START_MARKER_TTL_SECONDS })
  );
}

/**
 * @cc [owner:tdraier,label:error-handling;concurrency] completed-iff-marked
 * Returns true if and only if `markToolActivityCompleted` succeeded for `execution` less than
 * `TOOL_ACTIVITY_START_MARKER_TTL_SECONDS` ago. Redis failures throw.
 */
export async function isToolActivityCompleted(
  execution: ToolActivityExecution
): Promise<boolean> {
  const key = makeToolActivityStartMarkerKey(execution);

  const marker = await runOnRedis(
    { origin: "tool_activity_start_marker" },
    (redis) => redis.get(key)
  );

  return marker === "completed";
}

import { describe, expect, it } from "vitest";

import {
  deriveFrameScheduleId,
  MAX_FRAME_SCHEDULE_ID_LENGTH,
} from "@app/lib/api/frames/schedule_ids";
import { MAX_FRAME_FUNCTION_NAME_LENGTH } from "@app/types/api/frame_manifest";

describe("deriveFrameScheduleId", () => {
  const SCHEDULE = {
    cron: "0 9 * * 1-5",
    timezone: "Europe/Paris",
    input: { source: "crm", limit: 50 },
  };
  const SCHEDULE_ID = deriveFrameScheduleId({
    functionName: "add-task",
    ...SCHEDULE,
  });

  it("prefixes the id with the function name", () => {
    expect(SCHEDULE_ID).toMatch(/^add-task-[0-9a-f]{8}$/);
  });

  it("derives the same id for the same declaration and a new one for any change", () => {
    const same = deriveFrameScheduleId({
      functionName: "add-task",
      ...SCHEDULE,
      input: { limit: 50, source: "crm" },
    });
    expect(same).toBe(SCHEDULE_ID);

    for (const changed of [
      { ...SCHEDULE, cron: "0 10 * * 1-5" },
      { ...SCHEDULE, timezone: "UTC" },
      { ...SCHEDULE, input: { source: "billing", limit: 50 } },
    ]) {
      expect(
        deriveFrameScheduleId({ functionName: "add-task", ...changed })
      ).not.toBe(SCHEDULE_ID);
    }
    expect(
      deriveFrameScheduleId({ functionName: "list-tasks", ...SCHEDULE })
    ).not.toBe(SCHEDULE_ID);
  });

  it("keeps derived ids within the id length limit", () => {
    const id = deriveFrameScheduleId({
      functionName: "a".repeat(MAX_FRAME_FUNCTION_NAME_LENGTH),
      ...SCHEDULE,
    });

    expect(id).toHaveLength(MAX_FRAME_SCHEDULE_ID_LENGTH);
    expect(id).toMatch(/-[0-9a-f]{8}$/);
  });

  it("keeps functions apart even when their names agree on the visible prefix", () => {
    const prefix = "a".repeat(MAX_FRAME_SCHEDULE_ID_LENGTH);
    const first = deriveFrameScheduleId({
      functionName: `${prefix}-one`,
      ...SCHEDULE,
    });
    const second = deriveFrameScheduleId({
      functionName: `${prefix}-two`,
      ...SCHEDULE,
    });

    expect(first.slice(0, -9)).toBe(second.slice(0, -9));
    expect(first).not.toBe(second);
  });
});

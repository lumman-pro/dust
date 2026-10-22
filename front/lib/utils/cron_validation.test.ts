import {
  cronFiresAtMostHourly,
  isValidIanaTimezone,
  validateCronExpression,
} from "@app/lib/utils/cron_validation";
import { describe, expect, it } from "vitest";

describe("validateCronExpression", () => {
  it.each(["0 9 * * 1-5", "*/15 * * * *", "0 9 * * MON", "0 0 1 */3 *"])(
    "accepts %j",
    (cron) => {
      expect(
        validateCronExpression({ cron, timezone: "Europe/Paris" }).isOk()
      ).toBe(true);
    }
  );

  it.each([
    "",
    "0 9 * *",
    "0 9 * * * *",
    "@daily",
    "0 9 * * 1#2",
    "0 9 L * *",
    "60 * * * *",
    "0 9 31 2 *",
    "0 9 * * 1-5 ",
  ])("rejects %j", (cron) => {
    expect(validateCronExpression({ cron, timezone: "UTC" }).isErr()).toBe(
      true
    );
  });
});

describe("cronFiresAtMostHourly", () => {
  it.each(["0 * * * *", "30 9 * * 1-5", "0 0 1 */3 *"])(
    "accepts %j",
    (cron) => {
      expect(cronFiresAtMostHourly(cron)).toBe(true);
    }
  );

  it.each(["*/15 * * * *", "0,30 * * * *", "* * * * *", "0-5 * * * *", ""])(
    "rejects %j",
    (cron) => {
      expect(cronFiresAtMostHourly(cron)).toBe(false);
    }
  );
});

describe("isValidIanaTimezone", () => {
  it.each(["UTC", "Etc/UTC", "Europe/Paris", "America/New_York", "US/Pacific"])(
    "accepts %j",
    (timezone) => {
      expect(isValidIanaTimezone(timezone)).toBe(true);
    }
  );

  it.each(["", "Not/AZone", "utc", "europe/paris", "CEST", "+02:00"])(
    "rejects %j",
    (timezone) => {
      expect(isValidIanaTimezone(timezone)).toBe(false);
    }
  );
});

import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { CronExpressionParser } from "cron-parser";

// One standard cron field: lists and ranges of numbers, steps, wildcards or 3-letter names.
// `#` (nth occurrence) and `L` (last) are not supported by Temporal cron schedules.
const CRON_FIELD_REGEXP =
  /^(?:(?:\d+,)+\d+|\d+(?:\/|-)\d+|\d+|\*(?:\/\d+)?|\?|[A-Z]{3}(?:-[A-Z]{3})?)$/;
const CRON_FIELD_COUNT = 5;

/**
 * @cc [owner:smb2268,label:product] cron-is-standard-five-field
 * A cron expression MUST be exactly five space-separated fields using the standard operators
 * `* , - / ?` or 3-letter names, and MUST parse in the given timezone. Macros, seconds or year
 * fields, and the `#` and `L` operators MUST be refused. No minimum interval is enforced here.
 */
export function validateCronExpression({
  cron,
  timezone,
}: {
  cron: string;
  timezone: string;
}): Result<undefined, string> {
  const fields = cron.split(" ");
  if (
    fields.length !== CRON_FIELD_COUNT ||
    !fields.every((field) => CRON_FIELD_REGEXP.test(field))
  ) {
    return new Err(
      "expected 5 fields (min hour dom mon dow) using standard operators (* , - / ?) or " +
        "3-letter names; '#' and 'L' are not supported."
    );
  }

  try {
    CronExpressionParser.parse(cron, { tz: timezone });
  } catch (error) {
    return new Err(normalizeError(error).message);
  }

  return new Ok(undefined);
}

/**
 * @cc [owner:smb2268,label:product] cron-at-most-hourly
 * A cron expression fires at most once per hour exactly when its minute field is a single literal
 * minute. Steps, lists, ranges and `*` in that field MUST be reported as more frequent.
 */
export function cronFiresAtMostHourly(cron: string): boolean {
  return /^\d+$/.test(cron.split(" ")[0] ?? "");
}

// Intl resolves zone names case-insensitively but Temporal (Go `time.LoadLocation`) does not, so
// capitalization is checked too. `Intl.supportedValuesOf` omits `UTC` and link names like `US/Pacific`.
const IANA_TIMEZONE_CASE_REGEXP =
  /^[A-Z][A-Za-z0-9_+-]*(?:\/[A-Z][A-Za-z0-9_+-]*)*$/;

/**
 * @cc [owner:smb2268,label:product] timezone-is-iana-cased
 * A timezone MUST be a tz database name that `Intl` resolves, written with the database's
 * capitalization (`Europe/Paris`, `UTC`). Offsets, abbreviations such as `CEST` and lowercase
 * spellings MUST be refused.
 */
export function isValidIanaTimezone(timezone: string): boolean {
  if (!IANA_TIMEZONE_CASE_REGEXP.test(timezone)) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

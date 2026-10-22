import {
  cronFiresAtMostHourly,
  isValidIanaTimezone,
  validateCronExpression,
} from "@app/lib/utils/cron_validation";

import {
  DEFAULT_SANDBOX_FUNCTION_EXECUTION_MODE,
  DEFAULT_SANDBOX_FUNCTION_STAKE,
  SANDBOX_DATABASE_NAME_REGEX,
  SANDBOX_FUNCTION_EXECUTION_MODES,
  SANDBOX_FUNCTION_SLUG_REGEX,
  SANDBOX_FUNCTION_STAKES,
} from "@app/types/api/sandbox_functions";
import { hasControlCharacters } from "@app/types/file_system";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { stableStringify } from "@app/types/shared/utils/stable_stringify";
import { z } from "zod";
import { fromError } from "zod-validation-error";

export const FRAME_MANIFEST_FILE = "manifest.json";
export const FRAME_MANIFEST_VERSION = 1;
export const FRAME_DEFAULT_UI_ENTRY_POINT = "index.tsx";
/** Upper bound on a Frame's name, which is the basename of its source folder. */
export const MAX_FRAME_NAME_LENGTH = 128;
export const MAX_FRAME_FUNCTION_NAME_LENGTH = 128;
export const MAX_FRAME_FUNCTION_DESCRIPTION_LENGTH = 255;
// Each schema reconcile can take 60 seconds and runs under the 10-minute publication lease.
export const MAX_FRAME_DATABASE_COUNT = 4;
export const FRAME_DATABASE_NAME_REGEX = SANDBOX_DATABASE_NAME_REGEX;

/**
 * @cc [owner:davidebbo,label:product;backend] frame-name-is-the-source-folder
 * A Frames v2 package is named by the folder holding its `manifest.json`, and by nothing else.
 * The name MUST be derived from the Frame's current path wherever it is displayed, never stored
 * alongside it: a stored copy drifts from the folder the file explorer shows the moment the Frame
 * moves, which is the divergence this derivation exists to make impossible.
 *
 * Returns null when the path is not a manifest, or when the manifest has no folder of its own.
 */
export function getFrameV2NameFromManifestPath(
  manifestPath: string
): string | null {
  const segments = manifestPath.split("/");
  if (segments.pop() !== FRAME_MANIFEST_FILE) {
    return null;
  }

  return segments.pop() || null;
}

/**
 * @cc [owner:davidebbo,label:product;backend] frame-name-is-one-path-segment
 * A Frame name MUST be a single non-empty path segment of at most `MAX_FRAME_NAME_LENGTH`
 * characters, and MUST NOT be `.` or `..`. Renaming a Frame moves its source folder, so a name
 * carrying a separator or a relative segment would escape the Frame's parent directory.
 */
export function validateFrameV2Name(name: string): Result<string, string> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return new Err("Frame name cannot be empty.");
  }
  if (trimmed.length > MAX_FRAME_NAME_LENGTH) {
    return new Err(
      `Frame name cannot exceed ${MAX_FRAME_NAME_LENGTH} characters.`
    );
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return new Err("Frame name cannot contain path separators.");
  }
  if (trimmed === "." || trimmed === "..") {
    return new Err("Frame name cannot be '.' or '..'.");
  }

  return new Ok(trimmed);
}

/** Manifest paths are always relative to the Frame source folder. */
export function isSafeFrameRelativePath(path: string): boolean {
  // The file system strips control characters before resolving `.` and `..`, so a segment such
  // as `.\x01.` must be refused here rather than treated as a plain name.
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    hasControlCharacters(path)
  ) {
    return false;
  }

  const segments = path.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".."
  );
}

const FrameRelativePathSchema = z
  .string()
  .min(1)
  .refine(isSafeFrameRelativePath, {
    message:
      "Path must be relative to the Frame folder, using forward slashes and no '.', '..' or empty segments.",
  });

const FrameScheduleSourceManifestSchema = z
  .object({
    cron: z.string(),
    timezone: z.string(),
    // The manifest is parsed from JSON, so the value is JSON by construction; its shape is checked
    // against the function's input schema at publish time.
    input: z.custom<unknown>((value) => value !== undefined, {
      message: "Schedule input is required.",
    }),
  })
  .superRefine((schedule, context) => {
    const timezoneIsValid = isValidIanaTimezone(schedule.timezone);
    if (!timezoneIsValid) {
      context.addIssue({
        code: "custom",
        message: `Schedule timezone '${schedule.timezone}' is not an IANA timezone (e.g. "Europe/Paris").`,
        path: ["timezone"],
      });
    }

    // Parse in UTC when the timezone is invalid so a bad cron is still reported alongside it.
    const cron = validateCronExpression({
      cron: schedule.cron,
      timezone: timezoneIsValid ? schedule.timezone : "UTC",
    });
    if (cron.isErr()) {
      context.addIssue({
        code: "custom",
        message: `Schedule cron '${schedule.cron}' is invalid: ${cron.error}`,
        path: ["cron"],
      });
    }
  });

export const FrameFunctionManifestSchema = z.object({
  name: z
    .string()
    .max(MAX_FRAME_FUNCTION_NAME_LENGTH)
    .regex(SANDBOX_FUNCTION_SLUG_REGEX, {
      message:
        "Function name must be lowercase alphanumeric with single hyphen separators.",
    }),
  description: z.string().max(MAX_FRAME_FUNCTION_DESCRIPTION_LENGTH),
  entryPoint: FrameRelativePathSchema,
  executionMode: z
    .enum(SANDBOX_FUNCTION_EXECUTION_MODES)
    .default(DEFAULT_SANDBOX_FUNCTION_EXECUTION_MODE),
  defaultStake: z
    .enum(SANDBOX_FUNCTION_STAKES)
    .default(DEFAULT_SANDBOX_FUNCTION_STAKE),
  schedules: z.array(FrameScheduleSourceManifestSchema).default([]),
});

type FrameFunctionSourceManifest = z.infer<typeof FrameFunctionManifestSchema>;

/**
 * @cc [owner:smb2268,label:product] schedule-declarations-unique-per-function
 * A function declaring the same cron, timezone and input twice MUST fail to parse; input equality
 * ignores key order. Any other combination of schedules, on one function or across functions, is
 * allowed.
 */
/**
 * @cc [owner:smb2268,label:product] schedules-require-durable-functions
 * A function with a non-empty `schedules` list MUST declare the `durable` execution mode.
 */
/**
 * @cc [owner:smb2268,label:product] schedules-fire-at-most-hourly
 * A schedule's cron MUST fire at most once per hour (see cronFiresAtMostHourly); a more frequent
 * cron MUST fail to parse.
 */
function refineFrameScheduleDeclarations(
  functions: FrameFunctionSourceManifest[],
  context: z.RefinementCtx
): void {
  functions.forEach((fn, functionIndex) => {
    const seenDeclarations = new Set<string>();
    fn.schedules.forEach((schedule, scheduleIndex) => {
      const path = ["functions", functionIndex, "schedules", scheduleIndex];
      if (fn.executionMode !== "durable") {
        context.addIssue({
          code: "custom",
          message: `Function '${fn.name}' declares schedules, so it must declare "executionMode": "durable".`,
          path,
        });
      }
      if (!cronFiresAtMostHourly(schedule.cron)) {
        context.addIssue({
          code: "custom",
          message: `Schedule cron '${schedule.cron}' fires more than once per hour; the minute field must be a single value, e.g. "0 * * * *".`,
          path: [...path, "cron"],
        });
      }
      const declaration = JSON.stringify([
        schedule.cron,
        schedule.timezone,
        stableStringify(schedule.input),
      ]);
      if (seenDeclarations.has(declaration)) {
        context.addIssue({
          code: "custom",
          message: `Function '${fn.name}' declares the same schedule twice (cron '${schedule.cron}', timezone '${schedule.timezone}', same input).`,
          path,
        });
      }
      seenDeclarations.add(declaration);
    });
  });
}

export const FrameDatabaseManifestSchema = z.object({
  name: z.string().regex(FRAME_DATABASE_NAME_REGEX, {
    message:
      "Database name must start with a lowercase letter and contain only lowercase letters, digits, and underscores.",
  }),
  schema: FrameRelativePathSchema,
});

export const FrameSourceManifestSchema = z
  .object({
    version: z.literal(FRAME_MANIFEST_VERSION),
    description: z.string(),
    uiEntryPoint: FrameRelativePathSchema.optional(),
    functions: z.array(FrameFunctionManifestSchema).default([]),
    databases: z
      .array(FrameDatabaseManifestSchema)
      .max(MAX_FRAME_DATABASE_COUNT)
      .default([]),
  })
  .superRefine((manifest, context) => {
    const functionNames = new Set<string>();

    manifest.functions.forEach((fn, index) => {
      if (functionNames.has(fn.name)) {
        context.addIssue({
          code: "custom",
          message: `Function name '${fn.name}' must be unique.`,
          path: ["functions", index, "name"],
        });
      }
      functionNames.add(fn.name);
    });

    const databaseNames = new Set<string>();
    manifest.databases.forEach((database, index) => {
      if (databaseNames.has(database.name)) {
        context.addIssue({
          code: "custom",
          message: `Database name '${database.name}' must be unique.`,
          path: ["databases", index, "name"],
        });
      }
      databaseNames.add(database.name);
    });

    refineFrameScheduleDeclarations(manifest.functions, context);
  });

export const FrameManifestSchema = FrameSourceManifestSchema.transform(
  (manifest) => ({
    ...manifest,
    uiEntryPoint: manifest.uiEntryPoint ?? FRAME_DEFAULT_UI_ENTRY_POINT,
  })
);

export type FrameManifest = z.infer<typeof FrameManifestSchema>;
export type FrameFunctionManifest = FrameManifest["functions"][number];
export type FrameScheduleManifest = FrameFunctionManifest["schedules"][number];

export function parseFrameManifest(
  buffer: Buffer
): Result<FrameManifest, string> {
  let json: unknown;
  try {
    json = JSON.parse(buffer.toString("utf-8"));
  } catch (err) {
    return new Err(
      `${FRAME_MANIFEST_FILE} is not valid JSON: ${normalizeError(err).message}`
    );
  }

  const validation = FrameManifestSchema.safeParse(json);
  if (!validation.success) {
    return new Err(fromError(validation.error).toString());
  }

  return new Ok(validation.data);
}

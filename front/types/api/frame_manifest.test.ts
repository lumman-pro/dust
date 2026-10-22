import {
  FRAME_DATABASE_NAME_REGEX,
  FRAME_DEFAULT_UI_ENTRY_POINT,
  FrameManifestSchema,
  getFrameV2NameFromManifestPath,
  isSafeFrameRelativePath,
  MAX_FRAME_DATABASE_COUNT,
  MAX_FRAME_FUNCTION_DESCRIPTION_LENGTH,
  MAX_FRAME_NAME_LENGTH,
  parseFrameManifest,
  validateFrameV2Name,
} from "@app/types/api/frame_manifest";
import {
  DEFAULT_SANDBOX_FUNCTION_EXECUTION_MODE,
  DEFAULT_SANDBOX_FUNCTION_STAKE,
} from "@app/types/api/sandbox_functions";
import { describe, expect, it } from "vitest";

const MANIFEST = {
  version: 1,
  description: "Track tasks.",
};

const FUNCTION = {
  name: "add-task",
  description: "Add a task.",
  entryPoint: "functions/add_task.ts",
};

describe("FrameManifestSchema", () => {
  it("defaults the single UI entry point to index.tsx", () => {
    const parsed = FrameManifestSchema.safeParse(MANIFEST);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.uiEntryPoint).toBe(FRAME_DEFAULT_UI_ENTRY_POINT);
      expect(parsed.data.functions).toEqual([]);
      expect(parsed.data.databases).toEqual([]);
    }
  });

  it("ignores a legacy name field", () => {
    const parsed = FrameManifestSchema.safeParse({
      ...MANIFEST,
      name: "Task List",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("name" in parsed.data).toBe(false);
    }
  });

  it("parses an explicit UI entry point", () => {
    const explicit = FrameManifestSchema.safeParse({
      ...MANIFEST,
      uiEntryPoint: "ui/App.tsx",
    });
    expect(explicit.success).toBe(true);
  });

  it("parses function declarations", () => {
    const parsed = FrameManifestSchema.safeParse({
      ...MANIFEST,
      functions: [FUNCTION],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.functions).toEqual([
        {
          ...FUNCTION,
          executionMode: DEFAULT_SANDBOX_FUNCTION_EXECUTION_MODE,
          defaultStake: DEFAULT_SANDBOX_FUNCTION_STAKE,
          schedules: [],
        },
      ]);
    }
  });

  it("parses explicit function execution settings", () => {
    const parsed = FrameManifestSchema.safeParse({
      ...MANIFEST,
      functions: [{ ...FUNCTION, executionMode: "fast", defaultStake: "high" }],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.functions[0]).toMatchObject({
        executionMode: "fast",
        defaultStake: "high",
      });
    }
  });

  it("rejects unsafe function entry points", () => {
    const parsed = FrameManifestSchema.safeParse({
      ...MANIFEST,
      functions: [
        {
          ...FUNCTION,
          entryPoint: "../add_task.ts",
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate function names", () => {
    const parsed = FrameManifestSchema.safeParse({
      ...MANIFEST,
      functions: [
        FUNCTION,
        { ...FUNCTION, entryPoint: "functions/add_another_task.ts" },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects function names that cannot become slugs", () => {
    const parsed = FrameManifestSchema.safeParse({
      ...MANIFEST,
      functions: [{ ...FUNCTION, name: "Add Task" }],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects function descriptions that cannot be persisted", () => {
    const parsed = FrameManifestSchema.safeParse({
      ...MANIFEST,
      functions: [
        {
          ...FUNCTION,
          description: "a".repeat(MAX_FRAME_FUNCTION_DESCRIPTION_LENGTH + 1),
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("parses database declarations", () => {
    const parsed = FrameManifestSchema.safeParse({
      ...MANIFEST,
      databases: [{ name: "task_store", schema: "databases/task_store.db.ts" }],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects invalid database names and schema paths", () => {
    expect(FRAME_DATABASE_NAME_REGEX.test("task_store")).toBe(true);
    expect(
      FrameManifestSchema.safeParse({
        ...MANIFEST,
        databases: [{ name: "Task Store", schema: "databases/tasks.db.ts" }],
      }).success
    ).toBe(false);
    expect(
      FrameManifestSchema.safeParse({
        ...MANIFEST,
        databases: [{ name: "tasks", schema: "../tasks.db.ts" }],
      }).success
    ).toBe(false);
  });

  it("rejects duplicate database names", () => {
    const parsed = FrameManifestSchema.safeParse({
      ...MANIFEST,
      databases: [
        { name: "tasks", schema: "databases/tasks.db.ts" },
        { name: "tasks", schema: "databases/tasks_v2.db.ts" },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("bounds database reconciliation within the publication lease", () => {
    const parsed = FrameManifestSchema.safeParse({
      ...MANIFEST,
      databases: Array.from(
        { length: MAX_FRAME_DATABASE_COUNT + 1 },
        (_, index) => ({
          name: `database_${index}`,
          schema: `databases/database_${index}.db.ts`,
        })
      ),
    });

    expect(parsed.success).toBe(false);
  });

  describe("schedules", () => {
    const SCHEDULE = {
      cron: "0 9 * * 1-5",
      timezone: "Europe/Paris",
      input: { source: "crm", limit: 50 },
    };
    function parseWithSchedules(
      schedules: unknown[],
      fn: Record<string, unknown> = FUNCTION
    ) {
      return FrameManifestSchema.safeParse({
        ...MANIFEST,
        functions: [{ ...fn, schedules }],
      });
    }

    it("parses a schedule on a durable function", () => {
      const parsed = parseWithSchedules([SCHEDULE], {
        ...FUNCTION,
        executionMode: "durable",
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.functions[0].schedules).toEqual([SCHEDULE]);
      }
    });

    it("drops an id written in the manifest", () => {
      const parsed = parseWithSchedules([{ ...SCHEDULE, id: "custom" }]);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.functions[0].schedules).toEqual([SCHEDULE]);
      }
    });

    it("allows several schedules on one function", () => {
      const parsed = parseWithSchedules([
        SCHEDULE,
        { ...SCHEDULE, cron: "0 18 * * *" },
        { ...SCHEDULE, input: { source: "billing" } },
      ]);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.functions[0].schedules).toHaveLength(3);
      }
    });

    it("rejects the same schedule declared twice on a function", () => {
      const parsed = parseWithSchedules([
        SCHEDULE,
        { ...SCHEDULE, input: { limit: 50, source: "crm" } },
      ]);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]).toMatchObject({
          message: expect.stringContaining(
            "Function 'add-task' declares the same schedule twice"
          ),
          path: ["functions", 0, "schedules", 1],
        });
      }
    });

    it("defaults to no schedules", () => {
      const parsed = FrameManifestSchema.safeParse({
        ...MANIFEST,
        functions: [FUNCTION],
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.functions[0].schedules).toEqual([]);
      }
    });

    it("rejects a schedule on a fast function", () => {
      const parsed = parseWithSchedules([SCHEDULE], {
        ...FUNCTION,
        executionMode: "fast",
      });

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toContain(
          "Function 'add-task' declares schedules, so it must declare"
        );
      }
    });

    it("rejects an invalid cron at the schedule's cron path", () => {
      const parsed = parseWithSchedules([{ ...SCHEDULE, cron: "@daily" }]);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]).toMatchObject({
          message: expect.stringContaining("Schedule cron '@daily' is invalid"),
          path: ["functions", 0, "schedules", 0, "cron"],
        });
      }
    });

    it.each(["*/15 * * * *", "0,30 * * * *", "* * * * *", "0-5 9 * * *"])(
      "rejects cron %j as more than hourly",
      (cron) => {
        const parsed = parseWithSchedules([{ ...SCHEDULE, cron }]);

        expect(parsed.success).toBe(false);
        if (!parsed.success) {
          expect(parsed.error.issues[0]).toMatchObject({
            message: expect.stringContaining("fires more than once per hour"),
            path: ["functions", 0, "schedules", 0, "cron"],
          });
        }
      }
    );

    it("rejects an invalid timezone at the schedule's timezone path", () => {
      const parsed = parseWithSchedules([{ ...SCHEDULE, timezone: "utc" }]);

      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]).toMatchObject({
          message: expect.stringContaining("is not an IANA timezone"),
          path: ["functions", 0, "schedules", 0, "timezone"],
        });
      }
    });

    it("requires an input", () => {
      const { input: _omitted, ...withoutInput } = SCHEDULE;

      expect(parseWithSchedules([withoutInput]).success).toBe(false);
    });

    it("parses schedules from a manifest file", () => {
      const parsed = parseFrameManifest(
        Buffer.from(
          JSON.stringify({
            ...MANIFEST,
            functions: [{ ...FUNCTION, schedules: [SCHEDULE] }],
          })
        )
      );

      expect(parsed.isOk()).toBe(true);
      if (parsed.isOk()) {
        expect(parsed.value.functions[0].schedules).toEqual([SCHEDULE]);
      }
    });
  });

  it("returns a useful error for invalid JSON", () => {
    const parsed = parseFrameManifest(Buffer.from("{"));

    expect(parsed.isErr()).toBe(true);
    if (parsed.isErr()) {
      expect(parsed.error).toContain("manifest.json is not valid JSON");
    }
  });
});

describe("isSafeFrameRelativePath", () => {
  it.each([
    ["index.tsx", true],
    ["src/ui/App.tsx", true],
    ["../index.tsx", false],
    ["src/../index.tsx", false],
    ["/index.tsx", false],
    ["src\\index.tsx", false],
    ["./.\x01./index.tsx", false],
    ["src/index\x00.tsx", false],
  ])("validates %s", (relativePath, expected) => {
    expect(isSafeFrameRelativePath(relativePath)).toBe(expected);
  });
});

describe("getFrameV2NameFromManifestPath", () => {
  it("returns the folder holding the manifest", () => {
    expect(
      getFrameV2NameFromManifestPath(
        "w/w1/pods/p1/files/Sales Dashboard/manifest.json"
      )
    ).toBe("Sales Dashboard");
  });

  it("reads a scoped path the same way", () => {
    expect(
      getFrameV2NameFromManifestPath("pod-p1/Sales Dashboard/manifest.json")
    ).toBe("Sales Dashboard");
  });

  it("returns null when the path is not a manifest", () => {
    expect(
      getFrameV2NameFromManifestPath("pod-p1/Status/index.tsx")
    ).toBeNull();
  });

  it("returns null for a manifest with no folder of its own", () => {
    expect(getFrameV2NameFromManifestPath("manifest.json")).toBeNull();
    expect(getFrameV2NameFromManifestPath("/manifest.json")).toBeNull();
  });
});

describe("validateFrameV2Name", () => {
  it("accepts and trims a plain name", () => {
    const result = validateFrameV2Name("  Sales Dashboard  ");

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe("Sales Dashboard");
    }
  });

  it.each(["", "   ", "a/b", "a\\b", ".", ".."])("rejects %j", (candidate) => {
    expect(validateFrameV2Name(candidate).isErr()).toBe(true);
  });

  it("rejects a name longer than the limit", () => {
    expect(
      validateFrameV2Name("a".repeat(MAX_FRAME_NAME_LENGTH + 1)).isErr()
    ).toBe(true);
  });
});

import {
  exportTable,
  serializeExportTable,
} from "@app/lib/api/analytics/export_tables";
import type { MessageExportRow } from "@app/lib/api/analytics/messages_export";
import { MESSAGE_EXPORT_HEADERS } from "@app/lib/api/analytics/messages_export";
import {
  ElasticsearchError,
  searchAnalytics,
  searchConsumptionAnalytics,
} from "@app/lib/api/elasticsearch";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { SkillFactory } from "@app/tests/utils/SkillFactory";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { ONE_DAY_MS } from "@app/types/shared/utils/date_utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

// UTC has no DST, so shifting an instant by whole-day multiples of
// ONE_DAY_MS always lands on the correct UTC calendar day.
const formatUtcDate = (date: Date) => date.toISOString().slice(0, 10);

// Keep `bucketsToArray` (and everything else) real; only stub the
// Elasticsearch query so the test does not depend on a live cluster.
vi.mock("@app/lib/api/elasticsearch", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/elasticsearch")>();
  return {
    ...actual,
    searchAnalytics: vi.fn(),
    searchConsumptionAnalytics: vi.fn(),
  };
});

// The export reads from the read replica; in tests there is no replica so
// point it at the primary test connection.
vi.mock("@app/lib/resources/storage", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/resources/storage")>();
  return {
    ...actual,
    getFrontReplicaDbConnection: () => actual.frontSequelize,
  };
});

describe("exportTable agents", () => {
  beforeEach(() => {
    vi.mocked(searchConsumptionAnalytics).mockReset();
  });

  it("queries the consumption index with a half-open completed_at range and returns its aggregated metrics", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    const agent = await AgentConfigurationFactory.createTestAgent(
      authenticator,
      { name: "Agent" }
    );

    vi.mocked(searchConsumptionAnalytics).mockResolvedValue(
      new Ok({
        took: 1,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 0, relation: "eq" }, hits: [] },
        aggregations: {
          by_agent: {
            buckets: [
              {
                key: agent.sId,
                doc_count: 5,
                unique_messages: { value: 3 },
                unique_users: { value: 2 },
                unique_conversations: { value: 1 },
                credit_micro: { value: 2_000_000 },
              },
            ],
          },
        },
      })
    );

    const result = await exportTable({
      auth: authenticator,
      table: "agents",
      startDate: "2024-01-01",
      endDate: "2024-01-31",
      timezone: "UTC",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    if (result.value.table !== "agents") {
      throw new Error(`Expected "agents" table, got "${result.value.table}"`);
    }

    // Regression: exportAgents used to build its query with the legacy,
    // timestamp-based buildAgentAnalyticsBaseQuery, which the consumption
    // index does not have a `timestamp` field for — every agent row silently
    // came back with zero metrics. It must now query the consumption index
    // with a half-open [startDate, endDate) `completed_at` range, bumping the
    // inclusive `endDate` calendar day up by one day.
    expect(searchConsumptionAnalytics).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(searchConsumptionAnalytics).mock.calls[0];
    expect(query).toEqual({
      bool: {
        filter: [
          {
            bool: {
              filter: [
                { term: { workspace_id: workspace.sId } },
                {
                  range: {
                    completed_at: {
                      gte: "2024-01-01T00:00:00.000Z",
                      lt: "2024-02-01T00:00:00.000Z",
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const row = result.value.rows.find((r) => r.agentId === agent.sId);
    expect(row).toBeDefined();
    expect(row!.messages).toBe(3);
    expect(row!.distinctUsersReached).toBe(2);
    expect(row!.distinctConversations).toBe(1);
    expect(row!.credits).toBe(2);
  });
});

describe("exportTable users", () => {
  beforeEach(() => {
    vi.mocked(searchConsumptionAnalytics).mockReset();
  });

  it("queries the consumption index with a half-open completed_at range and returns its aggregated metrics", async () => {
    const { authenticator, workspace, user } = await createResourceTest({
      role: "admin",
    });

    // The user's membership is created "now" by createResourceTest, so the
    // window has to cover the present rather than a fixed historical range
    // (unlike the agents test, this one hits the real memberships table).
    const today = new Date();
    const startDate = formatUtcDate(
      new Date(today.getTime() - 30 * ONE_DAY_MS)
    );
    const endDate = formatUtcDate(today);
    const startInstant = new Date(`${startDate}T00:00:00.000Z`).toISOString();
    const exclusiveEndInstant = new Date(
      new Date(`${endDate}T00:00:00.000Z`).getTime() + ONE_DAY_MS
    ).toISOString();
    const lastMessageAt = new Date(today.getTime() - ONE_DAY_MS);

    vi.mocked(searchConsumptionAnalytics).mockResolvedValue(
      new Ok({
        took: 1,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 0, relation: "eq" }, hits: [] },
        aggregations: {
          by_user: {
            buckets: [
              {
                key: user.sId,
                doc_count: 5,
                unique_messages: { value: 4 },
                last_message: { value: lastMessageAt.valueOf() },
                active_days: { buckets: [{ doc_count: 1 }, { doc_count: 1 }] },
                credit_micro: { value: 3_000_000 },
              },
            ],
          },
        },
      })
    );

    const result = await exportTable({
      auth: authenticator,
      table: "users",
      startDate,
      endDate,
      timezone: "UTC",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    if (result.value.table !== "users") {
      throw new Error(`Expected "users" table, got "${result.value.table}"`);
    }

    // Regression: exportUsers used to build its query with the legacy,
    // timestamp-based buildAgentAnalyticsBaseQuery, which the consumption
    // index does not have a `timestamp` field for — every user row silently
    // came back with zero metrics. It must now query the consumption index
    // with a half-open [startDate, endDate) `completed_at` range, bumping the
    // inclusive `endDate` calendar day up by one day.
    expect(searchConsumptionAnalytics).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(searchConsumptionAnalytics).mock.calls[0];
    expect(query).toEqual({
      bool: {
        filter: [
          {
            bool: {
              filter: [
                { term: { workspace_id: workspace.sId } },
                {
                  range: {
                    completed_at: {
                      gte: startInstant,
                      lt: exclusiveEndInstant,
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const row = result.value.rows.find((r) => r.userId === user.sId);
    expect(row).toBeDefined();
    expect(row!.messageCount).toBe(4);
    expect(row!.activeDaysCount).toBe(2);
    expect(row!.credits).toBe(3);
    expect(row!.lastMessageSent).toBe(formatUtcDate(lastMessageAt));
  });
});

describe("exportTable skills", () => {
  beforeEach(() => {
    vi.mocked(searchConsumptionAnalytics).mockReset();
  });

  it("queries the consumption index with a half-open completed_at range for skill attribution", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    const skill = await SkillFactory.create(authenticator, {
      name: "Test Skill",
    });

    vi.mocked(searchConsumptionAnalytics).mockResolvedValue(
      new Ok({
        took: 1,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 0, relation: "eq" }, hits: [] },
        aggregations: {
          by_skill_id: { buckets: [] },
        },
      })
    );

    const result = await exportTable({
      auth: authenticator,
      table: "skills",
      startDate: "2024-01-01",
      endDate: "2024-01-31",
      timezone: "UTC",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    if (result.value.table !== "skills") {
      throw new Error(`Expected "skills" table, got "${result.value.table}"`);
    }

    // Regression: exportSkills used to build its query with the legacy,
    // timestamp-based buildAgentAnalyticsBaseQuery. It must now query the
    // consumption index with a half-open [startDate, endDate) `completed_at`
    // range, bumping the inclusive `endDate` calendar day up by one day.
    expect(searchConsumptionAnalytics).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(searchConsumptionAnalytics).mock.calls[0];
    expect(query).toEqual({
      bool: {
        filter: [
          { term: { workspace_id: workspace.sId } },
          {
            range: {
              completed_at: {
                gte: "2024-01-01T00:00:00.000Z",
                lt: "2024-02-01T00:00:00.000Z",
              },
            },
          },
        ],
      },
    });

    const row = result.value.rows.find((r) => r.skillId === skill.sId);
    expect(row).toBeDefined();
    expect(row!.name).toBe("Test Skill");
  });
});

describe("exportTable usage_metrics", () => {
  beforeEach(() => {
    vi.mocked(searchConsumptionAnalytics).mockReset();
  });

  it("queries the consumption index with a half-open completed_at range and returns its aggregated metrics", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    vi.mocked(searchConsumptionAnalytics).mockResolvedValue(
      new Ok({
        took: 1,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 0, relation: "eq" }, hits: [] },
        aggregations: {
          by_date: {
            buckets: [
              {
                key: Date.UTC(2024, 0, 15),
                key_as_string: "2024-01-15",
                doc_count: 10,
                unique_messages: { value: 4 },
                unique_conversations: { value: 3 },
                unique_users: { value: 2 },
              },
            ],
          },
        },
      })
    );

    const result = await exportTable({
      auth: authenticator,
      table: "usage_metrics",
      startDate: "2024-01-01",
      endDate: "2024-01-31",
      timezone: "UTC",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    if (result.value.table !== "usage_metrics") {
      throw new Error(
        `Expected "usage_metrics" table, got "${result.value.table}"`
      );
    }

    // Regression: exportUsageMetrics used to build its query with the legacy,
    // timestamp-based buildAgentAnalyticsBaseQuery. It must now query the
    // consumption index with a half-open [startDate, endDate) `completed_at`
    // range, bumping the inclusive `endDate` calendar day up by one day, and
    // dedupe messages by agent_message_id since the consumption index splits
    // a message across several documents.
    expect(searchConsumptionAnalytics).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(searchConsumptionAnalytics).mock.calls[0];
    expect(query).toEqual({
      bool: {
        filter: [
          { term: { workspace_id: workspace.sId } },
          {
            range: {
              completed_at: {
                gte: "2024-01-01T00:00:00.000Z",
                lt: "2024-02-01T00:00:00.000Z",
              },
            },
          },
        ],
      },
    });

    expect(result.value.rows).toEqual([
      { date: "2024-01-15", messages: 4, conversations: 3, activeUsers: 2 },
    ]);
  });

  it("resolves the completed_at range from timezone-local day boundaries, not UTC", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    vi.mocked(searchConsumptionAnalytics).mockResolvedValue(
      new Ok({
        took: 1,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 0, relation: "eq" }, hits: [] },
        aggregations: { by_date: { buckets: [] } },
      })
    );

    await exportTable({
      auth: authenticator,
      table: "usage_metrics",
      startDate: "2024-01-01",
      endDate: "2024-01-31",
      // UTC-8: local midnight on 2024-01-01 is 2024-01-01T08:00:00.000Z, not
      // 2024-01-01T00:00:00.000Z. A bare-date range filter is parsed by
      // Elasticsearch as UTC midnight, which would disagree with the
      // date_histogram aggregation's timezone-local day buckets and cut off
      // the first/last local day's early-morning activity.
      timezone: "America/Los_Angeles",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(searchConsumptionAnalytics).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(searchConsumptionAnalytics).mock.calls[0];
    expect(query).toEqual({
      bool: {
        filter: [
          { term: { workspace_id: workspace.sId } },
          {
            range: {
              completed_at: {
                gte: "2024-01-01T08:00:00.000Z",
                lt: "2024-02-01T08:00:00.000Z",
              },
            },
          },
        ],
      },
    });
  });
});

describe("exportTable active_users", () => {
  beforeEach(() => {
    vi.mocked(searchConsumptionAnalytics).mockReset();
  });

  it("queries the consumption index over an MAU-extended half-open completed_at range and computes rolling DAU/WAU/MAU", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    const day1 = Date.UTC(2024, 0, 1);
    const day2 = Date.UTC(2024, 0, 2);

    vi.mocked(searchConsumptionAnalytics).mockResolvedValue(
      new Ok({
        took: 1,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 0, relation: "eq" }, hits: [] },
        aggregations: {
          by_user_day: {
            buckets: [
              { key: { day: day1, user: "user_1" }, doc_count: 3 },
              { key: { day: day2, user: "user_1" }, doc_count: 2 },
              { key: { day: day2, user: "user_2" }, doc_count: 1 },
            ],
          },
        },
      })
    );

    const result = await exportTable({
      auth: authenticator,
      table: "active_users",
      startDate: "2024-01-01",
      endDate: "2024-01-02",
      timezone: "UTC",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    if (result.value.table !== "active_users") {
      throw new Error(
        `Expected "active_users" table, got "${result.value.table}"`
      );
    }

    // Regression: exportActiveUsers used to build its query against the
    // legacy timestamp/user_id index. It must now query the consumption
    // index's completed_at/user.id fields, extending the queried range back
    // by the MAU window so the rolling windows on the first requested days
    // are complete, with a half-open upper bound on the inclusive endDate.
    expect(searchConsumptionAnalytics).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(searchConsumptionAnalytics).mock.calls[0];
    expect(query).toEqual({
      bool: {
        filter: [
          { term: { workspace_id: workspace.sId } },
          {
            range: {
              completed_at: {
                gte: "2023-12-05T00:00:00.000Z",
                lt: "2024-01-03T00:00:00.000Z",
              },
            },
          },
        ],
      },
    });

    expect(result.value.rows).toEqual([
      { date: "2024-01-01", dau: 1, wau: 1, mau: 1 },
      { date: "2024-01-02", dau: 2, wau: 2, mau: 2 },
    ]);
  });

  it("resolves the completed_at range from timezone-local day boundaries, not UTC", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    vi.mocked(searchConsumptionAnalytics).mockResolvedValue(
      new Ok({
        took: 1,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 0, relation: "eq" }, hits: [] },
        aggregations: { by_user_day: { buckets: [] } },
      })
    );

    await exportTable({
      auth: authenticator,
      table: "active_users",
      startDate: "2024-01-01",
      endDate: "2024-01-02",
      // UTC-8: local midnight on 2024-01-01 is 2024-01-01T08:00:00.000Z, not
      // 2024-01-01T00:00:00.000Z. A bare-date range filter is parsed by
      // Elasticsearch as UTC midnight, which would disagree with the
      // composite aggregation's timezone-local day buckets and cut off the
      // first/last local day's early-morning activity.
      timezone: "America/Los_Angeles",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(searchConsumptionAnalytics).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(searchConsumptionAnalytics).mock.calls[0];
    expect(query).toEqual({
      bool: {
        filter: [
          { term: { workspace_id: workspace.sId } },
          {
            range: {
              completed_at: {
                gte: "2023-12-05T08:00:00.000Z",
                lt: "2024-01-03T08:00:00.000Z",
              },
            },
          },
        ],
      },
    });
  });
});

describe("exportTable skill_usage", () => {
  beforeEach(() => {
    vi.mocked(searchConsumptionAnalytics).mockReset();
  });

  it("queries the consumption index with a half-open completed_at range and resolves skill names by id", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    const skill = await SkillFactory.create(authenticator, {
      name: "Test Skill",
    });

    vi.mocked(searchConsumptionAnalytics).mockResolvedValue(
      new Ok({
        took: 1,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 0, relation: "eq" }, hits: [] },
        aggregations: {
          by_skill: {
            buckets: [
              {
                key: skill.sId,
                doc_count: 5,
                by_date: {
                  buckets: [
                    {
                      key: Date.UTC(2024, 0, 15),
                      doc_count: 5,
                      unique_users: { value: 2 },
                    },
                  ],
                },
              },
            ],
          },
        },
      })
    );

    const result = await exportTable({
      auth: authenticator,
      table: "skill_usage",
      startDate: "2024-01-01",
      endDate: "2024-01-31",
      timezone: "UTC",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    if (result.value.table !== "skill_usage") {
      throw new Error(
        `Expected "skill_usage" table, got "${result.value.table}"`
      );
    }

    // Regression: exportSkillUsage used to build its query with the legacy,
    // timestamp-based buildAgentAnalyticsBaseQuery. It must now query the
    // consumption index with a half-open [startDate, endDate) `completed_at`
    // range, and resolve the skill's display name from the flat
    // tool.attributed_skill_ids id since (unlike the old nested index) the
    // consumption index only stores skill ids.
    expect(searchConsumptionAnalytics).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(searchConsumptionAnalytics).mock.calls[0];
    expect(query).toEqual({
      bool: {
        filter: [
          { term: { workspace_id: workspace.sId } },
          {
            range: {
              completed_at: {
                gte: "2024-01-01T00:00:00.000Z",
                lt: "2024-02-01T00:00:00.000Z",
              },
            },
          },
        ],
      },
    });

    expect(result.value.rows).toEqual([
      {
        date: "2024-01-15",
        skillName: "Test Skill",
        executions: 5,
        uniqueUsers: 2,
      },
    ]);
  });

  it("resolves the completed_at range from timezone-local day boundaries, not UTC", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    vi.mocked(searchConsumptionAnalytics).mockResolvedValue(
      new Ok({
        took: 1,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 0, relation: "eq" }, hits: [] },
        aggregations: { by_skill: { buckets: [] } },
      })
    );

    await exportTable({
      auth: authenticator,
      table: "skill_usage",
      startDate: "2024-01-01",
      endDate: "2024-01-31",
      // UTC-8: local midnight on 2024-01-01 is 2024-01-01T08:00:00.000Z, not
      // 2024-01-01T00:00:00.000Z. A bare-date range filter is parsed by
      // Elasticsearch as UTC midnight, which would disagree with the
      // date_histogram aggregation's timezone-local day buckets and cut off
      // the first/last local day's early-morning activity.
      timezone: "America/Los_Angeles",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(searchConsumptionAnalytics).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(searchConsumptionAnalytics).mock.calls[0];
    expect(query).toEqual({
      bool: {
        filter: [
          { term: { workspace_id: workspace.sId } },
          {
            range: {
              completed_at: {
                gte: "2024-01-01T08:00:00.000Z",
                lt: "2024-02-01T08:00:00.000Z",
              },
            },
          },
        ],
      },
    });
  });
});

describe("exportTable tool_usage", () => {
  beforeEach(() => {
    vi.mocked(searchConsumptionAnalytics).mockReset();
  });

  it("queries the consumption index with a half-open completed_at range and returns raw server names", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    vi.mocked(searchConsumptionAnalytics).mockResolvedValue(
      new Ok({
        took: 1,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 0, relation: "eq" }, hits: [] },
        aggregations: {
          by_tool: {
            buckets: [
              {
                key: "search",
                doc_count: 5,
                by_date: {
                  buckets: [
                    {
                      key: Date.UTC(2024, 0, 15),
                      doc_count: 5,
                      unique_users: { value: 3 },
                    },
                  ],
                },
              },
            ],
          },
        },
      })
    );

    const result = await exportTable({
      auth: authenticator,
      table: "tool_usage",
      startDate: "2024-01-01",
      endDate: "2024-01-31",
      timezone: "UTC",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    if (result.value.table !== "tool_usage") {
      throw new Error(
        `Expected "tool_usage" table, got "${result.value.table}"`
      );
    }

    // Regression: exportToolUsage used to build its query with the legacy,
    // timestamp-based buildAgentAnalyticsBaseQuery, looping once per tool.
    // It must now query the consumption index with a single
    // terms+date_histogram aggregation over a half-open [startDate, endDate)
    // `completed_at` range; doc_count within a (tool, date) bucket is
    // already the execution count since the consumption index has one
    // document per tool call invocation.
    expect(searchConsumptionAnalytics).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(searchConsumptionAnalytics).mock.calls[0];
    expect(query).toEqual({
      bool: {
        filter: [
          { term: { workspace_id: workspace.sId } },
          {
            range: {
              completed_at: {
                gte: "2024-01-01T00:00:00.000Z",
                lt: "2024-02-01T00:00:00.000Z",
              },
            },
          },
        ],
      },
    });

    expect(result.value.rows).toEqual([
      { date: "2024-01-15", toolName: "search", executions: 5, uniqueUsers: 3 },
    ]);
  });

  it("resolves the completed_at range from timezone-local day boundaries, not UTC", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    vi.mocked(searchConsumptionAnalytics).mockResolvedValue(
      new Ok({
        took: 1,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 0, relation: "eq" }, hits: [] },
        aggregations: { by_tool: { buckets: [] } },
      })
    );

    await exportTable({
      auth: authenticator,
      table: "tool_usage",
      startDate: "2024-01-01",
      endDate: "2024-01-31",
      // UTC-8: local midnight on 2024-01-01 is 2024-01-01T08:00:00.000Z, not
      // 2024-01-01T00:00:00.000Z. A bare-date range filter is parsed by
      // Elasticsearch as UTC midnight, which would disagree with the
      // date_histogram aggregation's timezone-local day buckets and cut off
      // the first/last local day's early-morning activity.
      timezone: "America/Los_Angeles",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(searchConsumptionAnalytics).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(searchConsumptionAnalytics).mock.calls[0];
    expect(query).toEqual({
      bool: {
        filter: [
          { term: { workspace_id: workspace.sId } },
          {
            range: {
              completed_at: {
                gte: "2024-01-01T08:00:00.000Z",
                lt: "2024-02-01T08:00:00.000Z",
              },
            },
          },
        ],
      },
    });
  });
});

describe("exportTable source", () => {
  beforeEach(() => {
    vi.mocked(searchConsumptionAnalytics).mockReset();
  });

  it("queries the consumption index with a half-open completed_at range and returns its aggregated metrics", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    vi.mocked(searchConsumptionAnalytics).mockResolvedValue(
      new Ok({
        took: 1,
        timed_out: false,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 0, relation: "eq" }, hits: [] },
        aggregations: {
          by_date: {
            buckets: [
              {
                key: Date.UTC(2024, 0, 15),
                key_as_string: "2024-01-15",
                doc_count: 10,
                by_origin: {
                  buckets: [
                    { key: "web", doc_count: 6, unique_messages: { value: 3 } },
                    {
                      key: "slack",
                      doc_count: 4,
                      unique_messages: { value: 2 },
                    },
                  ],
                },
              },
            ],
          },
        },
      })
    );

    const result = await exportTable({
      auth: authenticator,
      table: "source",
      startDate: "2024-01-01",
      endDate: "2024-01-31",
      timezone: "UTC",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    if (result.value.table !== "source") {
      throw new Error(`Expected "source" table, got "${result.value.table}"`);
    }

    // Regression: exportSource used to build its query with the legacy,
    // timestamp-based buildAgentAnalyticsBaseQuery, which the consumption
    // index does not have a `timestamp` field for — every source row
    // silently came back with zero metrics. It must now query the
    // consumption index with a half-open [startDate, endDate) `completed_at`
    // range, bumping the inclusive `endDate` calendar day up by one day. The
    // message count within a day must also dedupe by agent_message_id
    // instead of using raw doc_count, since the consumption index splits a
    // message across several documents.
    expect(searchConsumptionAnalytics).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(searchConsumptionAnalytics).mock.calls[0];
    expect(query).toEqual({
      bool: {
        filter: [
          { term: { workspace_id: workspace.sId } },
          {
            range: {
              completed_at: {
                gte: "2024-01-01T00:00:00.000Z",
                lt: "2024-02-01T00:00:00.000Z",
              },
            },
          },
        ],
      },
    });

    expect(result.value.rows).toEqual([
      { date: "2024-01-15", source: "slack", messageCount: 2 },
      { date: "2024-01-15", source: "web", messageCount: 3 },
    ]);
  });
});

function messageRow(messageId: string): MessageExportRow {
  return {
    messageId,
    createdAt: "2026-07-01 12:00:00",
    assistantId: "agent_1",
    assistantName: "Agent",
    assistantSettings: "published",
    assistantTags: "",
    conversationId: "conv_1",
    spaceId: "",
    spaceName: "",
    parentMessageId: "",
    userId: "user_1",
    userEmail: "alice@example.com",
    source: "web",
    toolsUsed: "",
    skillsUsed: "",
    modelId: "",
    modelProviderId: "",
    modelResolutionMethod: "",
    credits: 1,
  };
}

function messagesExport(pages: Result<MessageExportRow[], Error>[]) {
  const pulled: number[] = [];
  async function* generate() {
    for (const [i, page] of pages.entries()) {
      pulled.push(i);
      yield page;
    }
  }
  return {
    pulled,
    data: {
      table: "messages" as const,
      headers: MESSAGE_EXPORT_HEADERS,
      workspaceId: "w_test",
      pages: generate(),
    },
  };
}

async function readBody(body: string | ReadableStream<Uint8Array>) {
  return new Response(body).text();
}

describe("serializeExportTable messages", () => {
  it("streams CSV with a single header line across pages", async () => {
    const { data } = messagesExport([
      new Ok([messageRow("msg_1"), messageRow("msg_2")]),
      new Ok([]),
      new Ok([messageRow("msg_3")]),
    ]);

    const lines = (await readBody(serializeExportTable(data, "csv")))
      .trim()
      .split("\n");

    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(MESSAGE_EXPORT_HEADERS.join(","));
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual([
      "msg_1",
      "msg_2",
      "msg_3",
    ]);
  });

  it("streams a single valid JSON array across pages", async () => {
    const { data } = messagesExport([
      new Ok([messageRow("msg_1")]),
      new Ok([]),
      new Ok([messageRow("msg_2"), messageRow("msg_3")]),
    ]);

    const parsed = JSON.parse(
      await readBody(serializeExportTable(data, "json"))
    );

    expect(parsed).toEqual([
      messageRow("msg_1"),
      messageRow("msg_2"),
      messageRow("msg_3"),
    ]);
  });

  it("streams an empty JSON array when there are no messages", async () => {
    const { data } = messagesExport([new Ok([])]);

    expect(
      JSON.parse(await readBody(serializeExportTable(data, "json")))
    ).toEqual([]);
  });

  it("errors the stream when a later page fails", async () => {
    const { data, pulled } = messagesExport([
      new Ok([messageRow("msg_1")]),
      new Err(new Error("es unavailable")),
      new Ok([messageRow("msg_2")]),
    ]);

    await expect(readBody(serializeExportTable(data, "csv"))).rejects.toThrow(
      "es unavailable"
    );
    expect(pulled).toEqual([0, 1]);
  });

  it("pulls the next page only when the consumer reads", async () => {
    const { data, pulled } = messagesExport([
      new Ok([messageRow("msg_1")]),
      new Ok([messageRow("msg_2")]),
    ]);

    const body = serializeExportTable(data, "csv");
    if (typeof body === "string") {
      throw new Error("Expected a stream for the messages table.");
    }
    const reader = body.getReader();

    await reader.read();
    await reader.read();
    expect(pulled).toEqual([0]);

    await reader.read();
    expect(pulled).toEqual([0, 1]);
    await reader.cancel();
  });
});

describe("exportTable messages", () => {
  it("returns an Err when the first Elasticsearch page fails", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    vi.mocked(searchAnalytics).mockResolvedValueOnce(
      new Err(new ElasticsearchError("query_error", "es unavailable"))
    );

    const result = await exportTable({
      auth: authenticator,
      table: "messages",
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      timezone: "UTC",
      owner: workspace,
      includeHiddenAgents: false,
    });

    expect(result.isErr()).toBe(true);
  });
});

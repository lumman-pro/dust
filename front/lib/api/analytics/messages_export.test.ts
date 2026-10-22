import type { MessageExportRow } from "@app/lib/api/analytics/messages_export";
import { generateMessageExportRows } from "@app/lib/api/analytics/messages_export";
import type { ElasticsearchBaseDocument } from "@app/lib/api/elasticsearch";
import {
  ElasticsearchError,
  searchAnalytics,
} from "@app/lib/api/elasticsearch";
import { TagResource } from "@app/lib/resources/tags_resource";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { TagFactory } from "@app/tests/utils/TagFactory";
import { Err, Ok } from "@app/types/shared/result";
import { describe, expect, it, vi } from "vitest";

// Keep everything real; only stub the Elasticsearch query so the test does not
// depend on a live cluster.
vi.mock("@app/lib/api/elasticsearch", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/elasticsearch")>();
  return { ...actual, searchAnalytics: vi.fn() };
});

// The export reads from the read replica; in tests there is no replica so point
// it at the primary test connection.
vi.mock("@app/lib/resources/storage", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/resources/storage")>();
  return {
    ...actual,
    getFrontReplicaDbConnection: () => actual.frontSequelize,
  };
});

function messageHits(docs: ElasticsearchBaseDocument[]) {
  return new Ok({
    took: 1,
    timed_out: false,
    _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
    hits: {
      total: { value: docs.length, relation: "eq" as const },
      hits: docs.map((doc, i) => ({
        _index: "test",
        _source: doc,
        sort: [i],
      })),
    },
  });
}

function mockMessageHits(docs: ElasticsearchBaseDocument[]) {
  vi.mocked(searchAnalytics).mockClear();
  vi.mocked(searchAnalytics).mockResolvedValue(messageHits(docs));
}

// Must match PAGE_SIZE in messages_export.ts: a full page makes the generator fetch the next one.
const ES_PAGE_SIZE = 10_000;

function messageDoc(
  overrides: Record<string, unknown> = {}
): ElasticsearchBaseDocument {
  return {
    workspace_id: "w_test",
    message_id: "msg_1",
    timestamp: "2026-07-01T12:00:00.000Z",
    agent_id: "agent_1",
    conversation_id: "conv_1",
    user_id: "user_1",
    context_origin: "web",
    status: "succeeded",
    ...overrides,
  };
}

async function collectMessageExportRows(
  params: Parameters<typeof generateMessageExportRows>[0]
): Promise<MessageExportRow[]> {
  const rows: MessageExportRow[] = [];
  for await (const page of generateMessageExportRows(params)) {
    if (page.isErr()) {
      throw page.error;
    }
    rows.push(...page.value);
  }
  return rows;
}

describe("generateMessageExportRows", () => {
  it("correctly reports credits column", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    mockMessageHits([
      messageDoc({
        cost: { full_awu: 10, llm_awu: 4, tool_awu: 3, billable_awu: 7 },
      }),
    ]);

    const rows = await collectMessageExportRows({
      auth: authenticator,
      owner: workspace,
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      timezone: "UTC",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].credits).toBe(7);
  });

  it("does not filter on status, so failed messages keep their billable credits", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    // A multi-execution message whose terminal execution errored: still billed
    // for the work of its successful executions.
    mockMessageHits([
      messageDoc({
        message_id: "msg_failed",
        status: "failed",
        cost: { full_awu: 10, llm_awu: 4, tool_awu: 3, billable_awu: 5 },
      }),
    ]);

    const rows = await collectMessageExportRows({
      auth: authenticator,
      owner: workspace,
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      timezone: "UTC",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe("msg_failed");
    expect(rows[0].credits).toBe(5);
  });

  it("resolves agent_tag_ids to sorted, distinct tag names in the assistantTags column", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    const [zeta, alpha] = await Promise.all([
      TagFactory.create(workspace, { name: "Zeta" }),
      TagFactory.create(workspace, { name: "Alpha" }),
    ]);

    mockMessageHits([
      messageDoc({ agent_tag_ids: [zeta.sId, alpha.sId, "tag_unknown"] }),
    ]);

    const rows = await collectMessageExportRows({
      auth: authenticator,
      owner: workspace,
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      timezone: "UTC",
    });
    // Sorted, distinct, and unknown ids dropped.
    expect(rows[0].assistantTags).toBe("Alpha,Zeta");
  });

  it("leaves assistantTags empty for docs indexed before agent_tag_ids shipped", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    mockMessageHits([messageDoc()]);

    const rows = await collectMessageExportRows({
      auth: authenticator,
      owner: workspace,
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      timezone: "UTC",
    });
    expect(rows[0].assistantTags).toBe("");
  });

  it("defaults credits to 0 for docs indexed before the cost fields shipped", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    mockMessageHits([messageDoc()]);

    const rows = await collectMessageExportRows({
      auth: authenticator,
      owner: workspace,
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      timezone: "UTC",
    });
    expect(rows[0].credits).toBe(0);
  });

  it("reports the resolved model columns", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    mockMessageHits([
      messageDoc({
        model: {
          provider_id: "anthropic",
          model_id: "claude-opus-5",
          reasoning_effort: "medium",
          resolution_method: "agent",
        },
      }),
    ]);

    const rows = await collectMessageExportRows({
      auth: authenticator,
      owner: workspace,
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      timezone: "UTC",
    });
    expect(rows[0].modelId).toBe("claude-opus-5");
    expect(rows[0].modelProviderId).toBe("anthropic");
    expect(rows[0].modelResolutionMethod).toBe("agent");
  });

  it("leaves the model columns empty for docs indexed before the model fields shipped", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    mockMessageHits([messageDoc()]);

    const rows = await collectMessageExportRows({
      auth: authenticator,
      owner: workspace,
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      timezone: "UTC",
    });
    expect(rows[0].modelId).toBe("");
    expect(rows[0].modelProviderId).toBe("");
    expect(rows[0].modelResolutionMethod).toBe("");
  });

  it("reports the direct parent in parentMessageId and defaults to empty", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    mockMessageHits([
      messageDoc({
        message_id: "msg_child",
        ancestor_message_ids: ["msg_parent"],
      }),
      messageDoc({ message_id: "msg_root" }),
    ]);

    const rows = await collectMessageExportRows({
      auth: authenticator,
      owner: workspace,
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      timezone: "UTC",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].parentMessageId).toBe("msg_parent");
    expect(rows[1].parentMessageId).toBe("");
  });

  it("yields one page per Elasticsearch page and looks each tag up once", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });
    const tag = await TagFactory.create(workspace, { name: "Alpha" });
    const fetchTagsSpy = vi.spyOn(TagResource, "fetchByIds");

    vi.mocked(searchAnalytics).mockClear();
    vi.mocked(searchAnalytics)
      .mockResolvedValueOnce(
        messageHits(
          Array.from({ length: ES_PAGE_SIZE }, (_, i) =>
            messageDoc({ message_id: `msg_${i}`, agent_tag_ids: [tag.sId] })
          )
        )
      )
      .mockResolvedValueOnce(
        messageHits([
          messageDoc({ message_id: "msg_last", agent_tag_ids: [tag.sId] }),
        ])
      );

    const pageSizes: number[] = [];
    let lastRow: MessageExportRow | undefined;
    for await (const page of generateMessageExportRows({
      auth: authenticator,
      owner: workspace,
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      timezone: "UTC",
    })) {
      if (page.isErr()) {
        throw page.error;
      }
      pageSizes.push(page.value.length);
      lastRow = page.value.at(-1);
    }

    expect(pageSizes).toEqual([ES_PAGE_SIZE, 1]);
    expect(vi.mocked(searchAnalytics)).toHaveBeenCalledTimes(2);
    expect(lastRow?.messageId).toBe("msg_last");
    expect(lastRow?.assistantTags).toBe("Alpha");
    expect(fetchTagsSpy).toHaveBeenCalledTimes(1);
    fetchTagsSpy.mockRestore();
  });

  it("yields an Err and stops when a later Elasticsearch page fails", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });

    vi.mocked(searchAnalytics).mockClear();
    vi.mocked(searchAnalytics)
      .mockResolvedValueOnce(
        messageHits(
          Array.from({ length: ES_PAGE_SIZE }, (_, i) =>
            messageDoc({ message_id: `msg_${i}` })
          )
        )
      )
      .mockResolvedValueOnce(
        new Err(new ElasticsearchError("query_error", "es unavailable"))
      );

    const outcomes: string[] = [];
    for await (const page of generateMessageExportRows({
      auth: authenticator,
      owner: workspace,
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      timezone: "UTC",
    })) {
      outcomes.push(page.isOk() ? "ok" : page.error.message);
    }

    expect(outcomes).toEqual(["ok", "es unavailable"]);
    expect(vi.mocked(searchAnalytics)).toHaveBeenCalledTimes(2);
  });

  it("reports the conversation space id and name, defaulting to empty", async () => {
    const { authenticator, workspace, user } = await createResourceTest({
      role: "admin",
    });
    const pod = await SpaceFactory.project(workspace, user.id, {
      name: "Pod Alpha",
    });

    mockMessageHits([
      messageDoc({ message_id: "msg_pod", space_id: pod.sId }),
      messageDoc({ message_id: "msg_unknown", space_id: "space_unknown" }),
      messageDoc({ message_id: "msg_null", space_id: null }),
      messageDoc({ message_id: "msg_legacy" }),
    ]);

    const rows = await collectMessageExportRows({
      auth: authenticator,
      owner: workspace,
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      timezone: "UTC",
    });

    expect(
      rows.map((r) => ({ spaceId: r.spaceId, spaceName: r.spaceName }))
    ).toEqual([
      { spaceId: pod.sId, spaceName: "Pod Alpha" },
      { spaceId: "space_unknown", spaceName: "" },
      { spaceId: "", spaceName: "" },
      { spaceId: "", spaceName: "" },
    ]);
  });
});

/**
 * Compare the AWU credits Metronome metered for a workspace over a billing cycle with the
 * credits indexed in the agent message consumption analytics index, in total, by usage type
 * and per Metronome user.
 *
 * Both sides are read over the same hour-aligned window, the finest granularity the Metronome
 * usage endpoint exposes. Metronome `free` usage is reported but not compared: it is never
 * indexed.
 *
 * npx tsx scripts/compare_metronome_consumption_analytics.ts \
 *   --workspaceId <wId> [--cyclesAgo 1]
 */
import {
  CONSUMPTION_ANALYTICS_ALIAS_NAME,
  searchConsumptionAnalytics,
} from "@app/lib/api/elasticsearch";
import { Authenticator } from "@app/lib/auth";
import {
  microCreditsToCredits,
  roundCreditsToMicroCredits,
} from "@app/lib/credits/units";
import {
  getMetronomeContractById,
  listMetronomeUsageWithGroups,
} from "@app/lib/metronome/client";
import {
  getMetricLlmProviderCostAwuId,
  toFreeMetronomeUserId,
  USAGE_TYPE_FREE,
  USAGE_TYPE_GROUP_KEY,
} from "@app/lib/metronome/constants";
import { buildUsageQuerySegments } from "@app/lib/metronome/per_user_usage";
import type { BillingCycle } from "@app/lib/plans/billing_cycle";
import { getBillingCycleFromDay } from "@app/lib/plans/billing_cycle";
import { MembershipResource } from "@app/lib/resources/membership_resource";
import { UserResource } from "@app/lib/resources/user_resource";
import { WorkspaceResource } from "@app/lib/resources/workspace_resource";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import { makeScript } from "@app/scripts/helpers";
import chunk from "lodash/chunk";

const HOUR_MS = 60 * 60 * 1000;
const COMPOSITE_PAGE_SIZE = 1_000;
const METRONOME_USER_ID_BATCH_SIZE = 1_000;
const MISMATCH_SAMPLE_LIMIT = 20;
const UNKNOWN_METRONOME_USER_ID = "unknown";

type ConsumptionCompositeKey = {
  user_id: string | null;
  seat_type: string | null;
  usage_type: string;
};

type ConsumptionCompositeAggregations = {
  by_user: {
    after_key?: ConsumptionCompositeKey;
    buckets: Array<{
      key: ConsumptionCompositeKey;
      credit_micro: { value: number | null };
    }>;
  };
};

type CreditMicroByKey = Map<string, number>;

function ceilToHour(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / HOUR_MS) * HOUR_MS);
}

function comparisonKey(metronomeUserId: string, usageType: string): string {
  return `${metronomeUserId}|${usageType}`;
}

function parseComparisonKey(key: string): {
  metronomeUserId: string;
  usageType: string;
} {
  const separatorIndex = key.lastIndexOf("|");
  return {
    metronomeUserId: key.slice(0, separatorIndex),
    usageType: key.slice(separatorIndex + 1),
  };
}

function addCreditMicro(
  creditMicroByKey: CreditMicroByKey,
  key: string,
  creditMicro: number
) {
  creditMicroByKey.set(key, (creditMicroByKey.get(key) ?? 0) + creditMicro);
}

async function resolveBillingCycle({
  cyclesAgo,
  metronomeContractId,
  metronomeCustomerId,
}: {
  cyclesAgo: number;
  metronomeContractId: string;
  metronomeCustomerId: string;
}): Promise<BillingCycle> {
  const contractResult = await getMetronomeContractById({
    metronomeCustomerId,
    metronomeContractId,
  });
  if (contractResult.isErr()) {
    throw contractResult.error;
  }
  const contract = contractResult.value;
  const anchorDateString =
    contract.usage_statement_schedule?.billing_anchor_date;
  if (!anchorDateString) {
    throw new Error("No billing anchor date found on Metronome contract");
  }

  const anchorDate = new Date(anchorDateString);
  let cycle = getBillingCycleFromDay(
    anchorDate.getUTCDate(),
    new Date(),
    true,
    anchorDate
  );
  for (let i = 0; i < cyclesAgo; i++) {
    cycle = getBillingCycleFromDay(
      anchorDate.getUTCDate(),
      new Date(cycle.cycleStart.getTime() - 1),
      true,
      anchorDate
    );
  }

  const contractStart = new Date(contract.starting_at);
  const overlapsContractStart =
    cycle.cycleStart.getTime() < contractStart.getTime() &&
    cycle.cycleEnd.getTime() > contractStart.getTime();
  return {
    cycleStart: overlapsContractStart ? contractStart : cycle.cycleStart,
    cycleEnd: cycle.cycleEnd,
  };
}

async function listActiveMemberMetronomeUserIds(
  workspace: WorkspaceResource
): Promise<string[]> {
  const auth = await Authenticator.internalAdminForWorkspace(workspace.sId);
  const { memberships } = await MembershipResource.getActiveMemberships({
    workspace: auth.getNonNullableWorkspace(),
  });
  const users = await UserResource.fetchByModelIds([
    ...new Set(memberships.map(({ userId }) => userId)),
  ]);
  return users.flatMap((user) => [user.sId, toFreeMetronomeUserId(user.sId)]);
}

async function fetchConsumptionCreditMicro({
  from,
  to,
  workspaceId,
}: {
  from: Date;
  to: Date;
  workspaceId: string;
}): Promise<CreditMicroByKey> {
  const creditMicroByKey: CreditMicroByKey = new Map();

  let afterKey: ConsumptionCompositeKey | undefined;
  do {
    const result = await searchConsumptionAnalytics<
      never,
      ConsumptionCompositeAggregations
    >(
      {
        bool: {
          filter: [
            { term: { workspace_id: workspaceId } },
            {
              range: {
                completed_at: { gte: from.toISOString(), lt: to.toISOString() },
              },
            },
          ],
        },
      },
      {
        aggregations: {
          by_user: {
            composite: {
              size: COMPOSITE_PAGE_SIZE,
              sources: [
                {
                  user_id: {
                    terms: { field: "user.id", missing_bucket: true },
                  },
                },
                {
                  seat_type: {
                    terms: { field: "user.seat_type", missing_bucket: true },
                  },
                },
                { usage_type: { terms: { field: "usage_type" } } },
              ],
              ...(afterKey ? { after: afterKey } : {}),
            },
            aggs: { credit_micro: { sum: { field: "credit_micro" } } },
          },
        },
        size: 0,
      }
    );
    if (result.isErr()) {
      throw new Error(
        `Failed to query ${CONSUMPTION_ANALYTICS_ALIAS_NAME}: ${result.error.message}`
      );
    }

    const aggregation = result.value.aggregations?.by_user;
    const buckets = aggregation?.buckets ?? [];
    for (const { key, credit_micro } of buckets) {
      const metronomeUserId = !key.user_id
        ? UNKNOWN_METRONOME_USER_ID
        : key.seat_type === "free"
          ? toFreeMetronomeUserId(key.user_id)
          : key.user_id;
      addCreditMicro(
        creditMicroByKey,
        comparisonKey(metronomeUserId, key.usage_type),
        Math.round(credit_micro.value ?? 0)
      );
    }
    afterKey = buckets.length > 0 ? aggregation?.after_key : undefined;
  } while (afterKey);

  return creditMicroByKey;
}

// Grouped Metronome AWU usage over [from, to), keyed by `groupKey` values. Buckets are kept by
// their start, so `from` and `to` must be hour-aligned for the window to be exact.
async function fetchMetronomeCreditMicro({
  from,
  groupFilters,
  groupKey,
  metronomeCustomerId,
  to,
}: {
  from: Date;
  groupFilters?: Record<string, string[]>;
  groupKey: string[];
  metronomeCustomerId: string;
  to: Date;
}): Promise<CreditMicroByKey> {
  const segments = buildUsageQuerySegments({
    cycleStart: from,
    requestEnd: new Date(Math.min(to.getTime(), Date.now())),
  });
  const results = await concurrentExecutor(
    segments,
    (segment) =>
      listMetronomeUsageWithGroups({
        customerId: metronomeCustomerId,
        billableMetricId: getMetricLlmProviderCostAwuId(),
        startingOn: segment.startingOn,
        endingBefore: segment.endingBefore,
        windowSize: segment.windowSize,
        groupKey,
        groupFilters,
      }),
    { concurrency: 3 }
  );

  const creditMicroByKey: CreditMicroByKey = new Map();
  for (const result of results) {
    if (result.isErr()) {
      throw result.error;
    }
    for (const entry of result.value) {
      const startMs = new Date(entry.startingOn).getTime();
      if (
        entry.value === null ||
        startMs < from.getTime() ||
        startMs >= to.getTime()
      ) {
        continue;
      }
      addCreditMicro(
        creditMicroByKey,
        groupKey.map((key) => entry.group?.[key] ?? "").join("|"),
        roundCreditsToMicroCredits(entry.value)
      );
    }
  }
  return creditMicroByKey;
}

makeScript(
  {
    workspaceId: {
      alias: "w",
      demandOption: true,
      description: "Workspace sId to compare.",
      type: "string" as const,
    },
    cyclesAgo: {
      default: 0,
      description:
        "Billing cycle to compare: 0 for the current cycle, 1 for the previous one, etc.",
      type: "number" as const,
    },
  },
  async ({ cyclesAgo, workspaceId }, logger) => {
    const workspace = await WorkspaceResource.fetchById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    const { metronomeCustomerId } = workspace;
    if (!metronomeCustomerId) {
      throw new Error(
        `No Metronome customer configured for workspace: ${workspaceId}`
      );
    }
    const auth = await Authenticator.internalAdminForWorkspace(workspace.sId);
    const metronomeContractId = auth.subscription()?.metronomeContractId;
    if (!metronomeContractId) {
      throw new Error(
        `No Metronome contract on the active subscription of workspace: ${workspaceId}`
      );
    }

    const { cycleStart, cycleEnd } = await resolveBillingCycle({
      cyclesAgo,
      metronomeContractId,
      metronomeCustomerId,
    });
    const from = ceilToHour(cycleStart);
    const to = ceilToHour(cycleEnd);

    const consumptionCreditMicroByKey = await fetchConsumptionCreditMicro({
      from,
      to,
      workspaceId: workspace.sId,
    });
    const metronomeCreditMicroByUsageType = await fetchMetronomeCreditMicro({
      from,
      groupKey: [USAGE_TYPE_GROUP_KEY],
      metronomeCustomerId,
      to,
    });

    const metronomeUserIds = [
      ...new Set([
        UNKNOWN_METRONOME_USER_ID,
        ...[...consumptionCreditMicroByKey.keys()].map(
          (key) => parseComparisonKey(key).metronomeUserId
        ),
        ...(await listActiveMemberMetronomeUserIds(workspace)),
      ]),
    ];
    const metronomeCreditMicroByKey: CreditMicroByKey = new Map();
    for (const userIdBatch of chunk(
      metronomeUserIds,
      METRONOME_USER_ID_BATCH_SIZE
    )) {
      const batchCreditMicroByKey = await fetchMetronomeCreditMicro({
        from,
        groupFilters: { user_id: userIdBatch },
        groupKey: ["user_id", USAGE_TYPE_GROUP_KEY],
        metronomeCustomerId,
        to,
      });
      for (const [key, creditMicro] of batchCreditMicroByKey) {
        if (parseComparisonKey(key).usageType !== USAGE_TYPE_FREE) {
          addCreditMicro(metronomeCreditMicroByKey, key, creditMicro);
        }
      }
    }

    const comparisons = [
      ...new Set([
        ...consumptionCreditMicroByKey.keys(),
        ...metronomeCreditMicroByKey.keys(),
      ]),
    ].map((key) => {
      const metronomeCreditMicro = metronomeCreditMicroByKey.get(key) ?? 0;
      const consumptionCreditMicro = consumptionCreditMicroByKey.get(key) ?? 0;
      return {
        ...parseComparisonKey(key),
        metronomeCredits: microCreditsToCredits(metronomeCreditMicro),
        consumptionCredits: microCreditsToCredits(consumptionCreditMicro),
        differenceCredits: microCreditsToCredits(
          consumptionCreditMicro - metronomeCreditMicro
        ),
      };
    });
    const mismatches = comparisons
      .filter(({ differenceCredits }) => differenceCredits !== 0)
      .sort(
        (left, right) =>
          Math.abs(right.differenceCredits) - Math.abs(left.differenceCredits)
      );

    const consumptionCreditMicroByUsageType: CreditMicroByKey = new Map();
    for (const [key, creditMicro] of consumptionCreditMicroByKey) {
      addCreditMicro(
        consumptionCreditMicroByUsageType,
        parseComparisonKey(key).usageType,
        creditMicro
      );
    }
    const billedUsageTypes = [
      ...new Set([
        ...consumptionCreditMicroByUsageType.keys(),
        ...metronomeCreditMicroByUsageType.keys(),
      ]),
    ]
      .filter((usageType) => usageType !== USAGE_TYPE_FREE)
      .sort();
    const byUsageType = Object.fromEntries(
      billedUsageTypes.map((usageType) => {
        const metronomeCreditMicro =
          metronomeCreditMicroByUsageType.get(usageType) ?? 0;
        const consumptionCreditMicro =
          consumptionCreditMicroByUsageType.get(usageType) ?? 0;
        return [
          usageType,
          {
            metronomeCredits: microCreditsToCredits(metronomeCreditMicro),
            consumptionCredits: microCreditsToCredits(consumptionCreditMicro),
            differenceCredits: microCreditsToCredits(
              consumptionCreditMicro - metronomeCreditMicro
            ),
          },
        ];
      })
    );
    const sumCreditMicro = (creditMicros: Iterable<number>) =>
      [...creditMicros].reduce((total, creditMicro) => total + creditMicro, 0);
    const metronomeCreditMicro = sumCreditMicro(
      billedUsageTypes.map(
        (usageType) => metronomeCreditMicroByUsageType.get(usageType) ?? 0
      )
    );
    const consumptionCreditMicro = sumCreditMicro(
      consumptionCreditMicroByKey.values()
    );

    const summary = {
      workspaceId: workspace.sId,
      cyclesAgo,
      cycleStart: cycleStart.toISOString(),
      cycleEnd: cycleEnd.toISOString(),
      comparedFrom: from.toISOString(),
      comparedTo: new Date(Math.min(to.getTime(), Date.now())).toISOString(),
      metronomeCredits: microCreditsToCredits(metronomeCreditMicro),
      consumptionCredits: microCreditsToCredits(consumptionCreditMicro),
      differenceCredits: microCreditsToCredits(
        consumptionCreditMicro - metronomeCreditMicro
      ),
      byUsageType,
      metronomeFreeCredits: microCreditsToCredits(
        metronomeCreditMicroByUsageType.get(USAGE_TYPE_FREE) ?? 0
      ),
      metronomeCreditsOutsideComparedUsers: microCreditsToCredits(
        metronomeCreditMicro -
          sumCreditMicro(metronomeCreditMicroByKey.values())
      ),
      comparedUserUsageTypeCount: comparisons.length,
      mismatchCount: mismatches.length,
      mismatchSampleLimit: MISMATCH_SAMPLE_LIMIT,
      mismatchSamples: mismatches.slice(0, MISMATCH_SAMPLE_LIMIT),
    };

    if (
      mismatches.length > 0 ||
      metronomeCreditMicro !== consumptionCreditMicro
    ) {
      logger.error(summary, "Consumption analytics differs from Metronome");
      return;
    }
    logger.info(summary, "Consumption analytics matches Metronome");
  }
);

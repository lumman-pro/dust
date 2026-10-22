import { randomUUID } from "node:crypto";
import type { RedisClientType } from "@app/lib/api/redis";
import { runOnRedisCollab } from "@app/lib/api/redis";
import type { DfmComment } from "@app/lib/markdown/dfm";
import { dfmCommentsSchema } from "@app/lib/markdown/dfm";
import { raceWithTimeout } from "@app/lib/utils/async_utils";
import logger from "@app/logger/logger";
import { parseSessionName } from "@app/types/collab";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { safeParseJSON } from "@app/types/shared/utils/json_utils";
import * as Y from "yjs";
import { z } from "zod";

export const YDOC_STATE_MAX_BYTES = 2 * 1024 * 1024;
export const YDOC_STATE_TTL_SECONDS = 24 * 60 * 60;
// Commands sent while Redis is unreachable wait for it: a fetch waits this long at most.
export const YDOC_STATE_TIMEOUT_MS = 5 * 1000;

const storedYDocStateSchema = z.object({
  epoch: z.string().min(1),
  revision: z.string().min(1),
  comments: dfmCommentsSchema,
  update: z.string(),
});

/**
 * A live document's Yjs state, kept between saves so a reload keeps its Yjs ids. `epoch` names
 * its Yjs history, `revision` is the file revision it continues from.
 */
export interface YDocState {
  epoch: string;
  revision: string;
  doc: Y.Doc;
  comments: DfmComment[];
}

const stateKey = (documentName: string) => `collab_ydoc_state:${documentName}`;

/** A new Yjs history, for a document built from its file. */
export const newYDocEpoch = (): string => randomUUID();

async function runOnStateRedis<T>(
  run: (redis: RedisClientType) => Promise<T>
): Promise<Result<T, Error>> {
  try {
    return new Ok(await runOnRedisCollab({ origin: "collab_ydoc_state" }, run));
  } catch (err) {
    return new Err(normalizeError(err));
  }
}

/**
 * @cc [owner:PopDaph;tdraier,label:product;performance] collab-ydoc-state-store
 * The stored state MUST hold the whole Yjs state of `doc`, with `epoch`, `revision` and
 * `comments`, and expire `YDOC_STATE_TTL_SECONDS` after this call. A state larger than
 * `YDOC_STATE_MAX_BYTES` once serialized MUST NOT be stored, and MUST delete the one stored
 * before, answering `too_large`. A Redis failure MUST fail. The call MUST NOT time out: it
 * resolves once Redis answered or failed, so a caller knows when its write is no longer pending.
 */
export async function storeYDocState(
  documentName: string,
  { epoch, revision, doc, comments }: YDocState
): Promise<Result<"stored" | "too_large", Error>> {
  const value = JSON.stringify({
    epoch,
    revision,
    comments,
    update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
  } satisfies z.infer<typeof storedYDocStateSchema>);
  const key = stateKey(documentName);
  if (Buffer.byteLength(value, "utf8") > YDOC_STATE_MAX_BYTES) {
    const deleted = await runOnStateRedis((redis) => redis.del(key));
    return deleted.isErr() ? deleted : new Ok("too_large");
  }
  const stored = await runOnStateRedis((redis) =>
    redis.set(key, value, { EX: YDOC_STATE_TTL_SECONDS })
  );
  return stored.isErr() ? stored : new Ok("stored");
}

/**
 * @cc [owner:PopDaph;tdraier,label:product] collab-ydoc-state-fetch
 * MUST return the state `storeYDocState` last stored for `documentName`, as a new `Y.Doc` holding
 * the same Yjs ids, or null when none is stored or what is stored cannot be read, which MUST be
 * logged. A state found
 * MUST then expire `YDOC_STATE_TTL_SECONDS` after this call. A Redis failure or a Redis that does
 * not answer within `YDOC_STATE_TIMEOUT_MS` MUST fail.
 */
export async function fetchYDocState(
  documentName: string
): Promise<Result<YDocState | null, Error>> {
  const stored = await raceWithTimeout(
    runOnStateRedis((redis) =>
      redis.getEx(stateKey(documentName), { EX: YDOC_STATE_TTL_SECONDS })
    ),
    YDOC_STATE_TIMEOUT_MS
  );
  if (stored === "timeout") {
    return new Err(new Error("Redis did not answer in time."));
  }
  if (stored.isErr()) {
    return stored;
  }
  if (stored.value === null) {
    return new Ok(null);
  }
  const state = parseStoredYDocState(stored.value);
  if (state.isErr()) {
    logger.warn(
      {
        err: state.error,
        documentName,
        workspaceId: parseSessionName(documentName)?.workspaceId,
      },
      "Collab document state unreadable"
    );
    return new Ok(null);
  }
  return state;
}

function parseStoredYDocState(value: string): Result<YDocState, Error> {
  const json = safeParseJSON(value);
  if (json.isErr()) {
    return json;
  }
  const parsed = storedYDocStateSchema.safeParse(json.value);
  if (!parsed.success) {
    return new Err(parsed.error);
  }
  const { epoch, revision, comments, update } = parsed.data;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Buffer.from(update, "base64"));
  } catch (err) {
    return new Err(normalizeError(err));
  }
  return new Ok({ epoch, revision, doc, comments });
}

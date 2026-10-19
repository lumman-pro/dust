import { parseGcsReplicationNotification } from "@app/lib/api/dfs/gcs_notifications";
import { Authenticator } from "@app/lib/auth";
import fileStorageConfig from "@app/lib/file_storage/config";
import logger from "@app/logger/logger";
import { launchGcsReplicationWorkflow } from "@app/temporal/dfs_gcs_replication/client";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import type { Message } from "@google-cloud/pubsub";
import {
  Duration,
  PubSub,
  SubscriptionCloseBehaviors,
} from "@google-cloud/pubsub";

const MAX_CONCURRENT_HANDOFFS = 8;
const MAX_BUFFERED_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_PROCESSING_MS = 60_000;
const DRAIN_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 60_000;

interface GcsWorkerOptions {
  subscriptionName: string;
  source: { bucket: string; notificationConfig: string };
  // The process entrypoint supplies a signal aborted on SIGTERM or SIGINT.
  signal: AbortSignal;
}

/**
 * @cc [owner:flvndvd,label:concurrency] gcs-worker-durable-handoff
 * Eligible notifications MUST be acknowledged only after Temporal accepts the source signal.
 * A failed or ambiguous handoff MUST be nacked. Import completion is owned by Temporal.
 */
/**
 * @cc [owner:flvndvd,label:error-handling] gcs-worker-message-boundary
 * This Pub/Sub callback boundary MAY catch lookup and handoff exceptions to log and nack the
 * delivery. Invalid notifications and failed handoffs MUST be nacked, never acknowledged.
 */
/**
 * @cc [owner:flvndvd,label:security] gcs-worker-workspace-feature-flag
 * The worker MUST check dfs_gcs_replication for the workspace in the validated object path before
 * signaling Temporal. Objects outside the supported file prefixes or with the flag disabled
 * MUST be acknowledged without signaling. A failed flag lookup MUST be retried, not treated as
 * a disabled flag.
 */
/**
 * @cc [owner:flvndvd,label:concurrency] gcs-worker-shutdown
 * Shutdown MUST stop accepting messages, allow active handoffs to drain, then cancel remaining
 * RPCs. Cancelled handoffs MUST NOT be acknowledged, even if Temporal later accepts them.
 * A worker that returns with active handlers MUST return Err so its process can exit.
 */
export async function runGcsReplicationWorker({
  subscriptionName,
  source,
  signal,
}: GcsWorkerOptions): Promise<Result<void, Error>> {
  if (!/^projects\/[^/]+\/subscriptions\/[^/]+$/.test(subscriptionName)) {
    return new Err(new Error("A full Pub/Sub subscription name is required."));
  }
  if (signal.aborted) {
    return new Ok(undefined);
  }

  const pubsub = new PubSub({
    keyFilename: fileStorageConfig.getServiceAccount(),
  });
  const subscription = pubsub.subscription(subscriptionName, {
    flowControl: {
      maxMessages: MAX_CONCURRENT_HANDOFFS,
      maxBytes: MAX_BUFFERED_MESSAGE_BYTES,
      allowExcessMessages: false,
    },
    maxExtensionTime: Duration.from({ milliseconds: MAX_PROCESSING_MS }),
    closeOptions: {
      behavior: SubscriptionCloseBehaviors.WaitForProcessing,
      timeout: Duration.from({ milliseconds: CLOSE_TIMEOUT_MS }),
    },
  });
  const processing = new AbortController();
  let closing = false;
  let activeHandoffs = 0;
  let failure: Error | undefined;

  return new Promise<Result<void, Error>>((resolve) => {
    async function close(error?: Error): Promise<void> {
      failure ??= error;
      if (closing) {
        return;
      }
      closing = true;
      const drainTimer = setTimeout(() => processing.abort(), DRAIN_TIMEOUT_MS);
      try {
        await subscription.close();
      } catch (err) {
        failure ??= normalizeError(err);
      }
      processing.abort();
      clearTimeout(drainTimer);
      try {
        await pubsub.close();
      } catch (err) {
        failure ??= normalizeError(err);
      }
      signal.removeEventListener("abort", onAbort);
      subscription.removeListener("message", onMessage);
      subscription.removeListener("error", onError);
      subscription.removeListener("close", onClose);
      if (activeHandoffs > 0) {
        failure ??= new Error(
          "GCS replication handoffs did not stop before shutdown."
        );
      }
      logger.info(
        { subscriptionName, activeHandoffs },
        "GCS replication worker stopped."
      );
      resolve(failure ? new Err(failure) : new Ok(undefined));
    }

    async function handleMessage(message: Message): Promise<void> {
      activeHandoffs++;
      try {
        const parsed = parseGcsReplicationNotification(message, source);
        if (parsed.isErr()) {
          logger.warn(
            { error: parsed.error, messageId: message.id },
            "Invalid GCS notification."
          );
          message.nack();
          return;
        }
        if (parsed.value) {
          const auth = await Authenticator.internalAdminForWorkspace(
            parsed.value.destination.workspaceId
          );
          const enabled = await auth.hasFeatureFlag("dfs_gcs_replication");
          if (enabled && !processing.signal.aborted) {
            const handedOff = await launchGcsReplicationWorkflow(
              {
                workspaceId: parsed.value.destination.workspaceId,
                bucket: parsed.value.metadata.bucket,
                objectName: parsed.value.metadata.name,
              },
              processing.signal
            );
            if (handedOff.isErr()) {
              logger.warn(
                { error: handedOff.error, messageId: message.id },
                "GCS notification handoff failed."
              );
              message.nack();
              return;
            }
          }
        }
        if (processing.signal.aborted) {
          message.nack();
        } else {
          message.ack();
        }
      } catch (error) {
        logger.error(
          { error: normalizeError(error), messageId: message.id },
          "GCS notification processing failed."
        );
        message.nack();
      } finally {
        activeHandoffs--;
      }
    }

    function onMessage(message: Message): void {
      // Keep the bound even if the SDK expires a message lease while its handoff still runs.
      if (closing || activeHandoffs >= MAX_CONCURRENT_HANDOFFS) {
        message.nack();
        return;
      }
      void handleMessage(message);
    }

    function onError(error: Error): void {
      logger.error(
        { error, subscriptionName },
        "GCS replication subscription failed."
      );
      void close(error);
    }

    function onAbort(): void {
      void close();
    }

    function onClose(): void {
      if (!closing) {
        void close(
          new Error("GCS replication subscription closed unexpectedly.")
        );
      }
    }

    subscription.on("error", onError);
    subscription.on("close", onClose);
    subscription.on("message", onMessage);
    signal.addEventListener("abort", onAbort, { once: true });
    logger.info({ subscriptionName }, "GCS replication worker started.");
  });
}

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
  signal: AbortSignal;
}

/**
 * @cc [owner:flvndvd,label:concurrency] gcs-worker-durable-handoff
 * Acknowledge eligible notifications only after Temporal accepts the signal. Failed, ambiguous
 * or canceled handoffs MUST be nacked.
 */
/**
 * @cc [owner:flvndvd,label:error-handling] gcs-worker-message-boundary
 * This Pub/Sub callback MAY catch lookup and handoff exceptions to log and nack the delivery.
 * Invalid notifications MUST be nacked.
 */
/**
 * @cc [owner:flvndvd,label:security] gcs-worker-workspace-feature-flag
 * Check dfs_gcs_replication in the workspace from the validated path before signaling Temporal.
 * Acknowledge out-of-scope or disabled sources. Failed flag lookups MUST be retried.
 */
/**
 * @cc [owner:flvndvd,label:concurrency] gcs-worker-shutdown
 * Shutdown MUST stop intake, drain active handoffs, then cancel remaining RPCs. Canceled
 * handoffs MUST NOT be acknowledged. Returning with active handlers MUST return Err.
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
    const close = async (error?: Error): Promise<void> => {
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
    };

    const handleMessage = async (message: Message): Promise<void> => {
      activeHandoffs++;

      try {
        const parsedRes = parseGcsReplicationNotification(message, source);
        if (parsedRes.isErr()) {
          logger.warn(
            { error: parsedRes.error, messageId: message.id },
            "Invalid GCS notification."
          );
          message.nack();
          return;
        }

        const replicationSource = parsedRes.value;
        if (!replicationSource) {
          message.ack();
          return;
        }

        const auth = await Authenticator.internalAdminForWorkspace(
          replicationSource.workspaceId
        );
        const enabled = await auth.hasFeatureFlag("dfs_gcs_replication");

        if (processing.signal.aborted) {
          message.nack();
          return;
        }

        if (!enabled) {
          message.ack();
          return;
        }

        const handedOffRes = await launchGcsReplicationWorkflow(
          replicationSource,
          processing.signal
        );

        if (handedOffRes.isErr()) {
          logger.warn(
            { error: handedOffRes.error, messageId: message.id },
            "GCS notification handoff failed."
          );
          message.nack();
          return;
        }

        if (processing.signal.aborted) {
          message.nack();
          return;
        }

        message.ack();
      } catch (error) {
        logger.error(
          { error: normalizeError(error), messageId: message.id },
          "GCS notification processing failed."
        );
        message.nack();
      } finally {
        activeHandoffs--;
      }
    };

    const onMessage = (message: Message): void => {
      // Keep the bound even if the SDK expires a message lease while its handoff still runs.
      if (closing || activeHandoffs >= MAX_CONCURRENT_HANDOFFS) {
        message.nack();
        return;
      }

      void handleMessage(message);
    };

    const onError = (error: Error): void => {
      logger.error(
        { error, subscriptionName },
        "GCS replication subscription failed."
      );

      void close(error);
    };

    const onAbort = (): void => {
      void close();
    };

    const onClose = (): void => {
      if (!closing) {
        void close(
          new Error("GCS replication subscription closed unexpectedly.")
        );
      }
    };

    subscription.on("error", onError);
    subscription.on("close", onClose);
    subscription.on("message", onMessage);
    signal.addEventListener("abort", onAbort, { once: true });

    logger.info({ subscriptionName }, "GCS replication worker started.");
  });
}

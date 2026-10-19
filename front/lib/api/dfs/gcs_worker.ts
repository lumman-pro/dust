import type { GcsReplicationNotification } from "@app/lib/api/dfs/gcs_notifications";
import { parseGcsReplicationNotification } from "@app/lib/api/dfs/gcs_notifications";
import { Authenticator } from "@app/lib/auth";
import fileStorageConfig from "@app/lib/file_storage/config";
import logger from "@app/logger/logger";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import type { Message } from "@google-cloud/pubsub";
import {
  Duration,
  PubSub,
  SubscriptionCloseBehaviors,
} from "@google-cloud/pubsub";

const MAX_CONCURRENT_IMPORTS = 8;
const MAX_BUFFERED_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_PROCESSING_MS = 30 * 60_000;
const DRAIN_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 60_000;

export type GcsReplicationImporter = (
  notification: GcsReplicationNotification,
  signal: AbortSignal
) => Promise<Result<void, Error>>;

interface GcsWorkerOptions {
  subscriptionName: string;
  source: { bucket: string; notificationConfig: string };
  importNotification: GcsReplicationImporter;
  // The process entrypoint supplies a signal aborted on SIGTERM or SIGINT.
  signal: AbortSignal;
}

/**
 * @cc [owner:flvndvd,label:concurrency] gcs-worker-import-completion
 * The importer MUST hold the source lock through all GCS reads and DFS writes, with DFS rejecting
 * writes from a previous holder. It MUST resolve Ok only after a completed import or a verified
 * skip, and MUST stop work when its signal is aborted. Acknowledging a message MUST NOT substitute
 * for that lock or establish event ordering.
 */
/**
 * @cc [owner:flvndvd,label:error-handling] gcs-worker-message-boundary
 * This Pub/Sub callback boundary MAY catch lookup and importer exceptions to log and nack the
 * delivery. Invalid notifications and failed imports MUST be nacked, never acknowledged.
 */
/**
 * @cc [owner:flvndvd,label:security] gcs-worker-workspace-feature-flag
 * The worker MUST check dfs_gcs_replication for the workspace in the validated object path before
 * calling the importer. Objects outside the supported file prefixes or with the flag disabled
 * MUST be acknowledged without importing. A failed flag lookup MUST be retried, not treated as
 * a disabled flag.
 */
/**
 * @cc [owner:flvndvd,label:concurrency] gcs-worker-shutdown
 * Shutdown MUST stop accepting imports, allow active imports to drain, then cancel remaining work.
 * A cancelled import MUST NOT be acknowledged, even if it later returns Ok. A worker that returns
 * with active imports MUST return Err so its process can exit rather than keep writing.
 */
export async function runGcsReplicationWorker({
  subscriptionName,
  source,
  importNotification,
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
      maxMessages: MAX_CONCURRENT_IMPORTS,
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
  let activeImports = 0;
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
      if (activeImports > 0) {
        failure ??= new Error(
          "GCS replication imports did not stop before shutdown."
        );
      }
      logger.info(
        { subscriptionName, activeImports },
        "GCS replication worker stopped."
      );
      resolve(failure ? new Err(failure) : new Ok(undefined));
    }

    async function handleMessage(message: Message): Promise<void> {
      activeImports++;
      let importSignal = processing.signal;
      let importTimer: ReturnType<typeof setTimeout> | undefined;
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
          const timeout = new AbortController();
          importTimer = setTimeout(() => timeout.abort(), MAX_PROCESSING_MS);
          importTimer.unref();
          importSignal = AbortSignal.any([processing.signal, timeout.signal]);
          const auth = await Authenticator.internalAdminForWorkspace(
            parsed.value.destination.workspaceId
          );
          const enabled = await auth.hasFeatureFlag("dfs_gcs_replication");
          if (enabled && !importSignal.aborted) {
            const imported = await importNotification(
              parsed.value,
              importSignal
            );
            if (imported.isErr()) {
              logger.warn(
                { error: imported.error, messageId: message.id },
                "GCS import failed."
              );
              message.nack();
              return;
            }
          }
        }
        if (importSignal.aborted) {
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
        clearTimeout(importTimer);
        activeImports--;
      }
    }

    function onMessage(message: Message): void {
      // Keep the bound even if the SDK expires a message lease while its import still runs.
      if (closing || activeImports >= MAX_CONCURRENT_IMPORTS) {
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

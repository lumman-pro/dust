import { EventEmitter } from "node:events";
import type { ClientConfig, SubscriptionOptions } from "@google-cloud/pubsub";
import { vi } from "vitest";

export class FakePubSubMessage {
  readonly ack = vi.fn();
  readonly nack = vi.fn();

  constructor(
    readonly attributes: Record<string, string>,
    readonly data: Buffer,
    readonly id = "message-1"
  ) {}
}

class FakeSubscription extends EventEmitter {
  readonly close = vi.fn(async () => {});

  deliver(message: FakePubSubMessage): void {
    this.emit("message", message);
  }

  holdClose(): () => void {
    const pending = Promise.withResolvers<void>();
    this.close.mockImplementation(() => pending.promise);
    return () => pending.resolve();
  }
}

export class FakePubSub {
  static instances: FakePubSub[] = [];

  readonly subscriber = new FakeSubscription();
  readonly close = vi.fn(async () => {});
  readonly subscription = vi.fn(
    (_name: string, _options?: SubscriptionOptions) => this.subscriber
  );

  constructor(readonly options?: ClientConfig) {
    FakePubSub.instances.push(this);
  }

  static latest(): FakePubSub {
    const client = this.instances.at(-1);
    if (!client) {
      throw new Error("The test has not started a Pub/Sub client.");
    }
    return client;
  }
}

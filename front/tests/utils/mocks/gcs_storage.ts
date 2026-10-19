import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";

interface GcsResponse {
  statusCode: number;
  body?: unknown;
  headers?: Record<string, string>;
  hold?: boolean;
}

// Exercises the real GCS SDK against its local emulator endpoint.
export class FakeGcsStorageServer {
  readonly requests: { url: string; headers: IncomingHttpHeaders }[] = [];
  readonly responses: GcsResponse[] = [];
  private readonly server = createServer((request, response) => {
    this.requests.push({ url: request.url ?? "", headers: request.headers });
    const next = this.responses.shift();
    if (!next) {
      response.writeHead(500).end("Unexpected GCS request");
      return;
    }
    response.writeHead(next.statusCode, {
      "content-type": "application/json",
      ...next.headers,
    });
    const body =
      Buffer.isBuffer(next.body) || typeof next.body === "string"
        ? next.body
        : JSON.stringify(next.body);
    if (next.hold) {
      response.write(body ?? "");
    } else {
      response.end(body);
    }
  });

  async start(): Promise<string> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve)
    );
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP address for the GCS test server.");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  reset(): void {
    this.requests.length = 0;
    this.responses.length = 0;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

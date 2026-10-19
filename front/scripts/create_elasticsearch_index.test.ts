import { execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";

describe("Elasticsearch index initialization", () => {
  const index = "front.skills_1";
  const alias = "front.skills";
  let indexStatus: number;
  let aliasStatus: number;
  let updateStatus: number;
  let requests: { method: string; path: string; body: unknown }[];
  let url: string;

  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
    }
    const method = request.method ?? "";
    const requestPath = request.url ?? "";
    requests.push({
      method,
      path: requestPath,
      body: body ? JSON.parse(body) : null,
    });
    response.setHeader("x-elastic-product", "Elasticsearch");
    response.setHeader("Content-Type", "application/json");

    if (method === "HEAD" && requestPath === "/") {
      response.writeHead(200).end();
    } else if (method === "HEAD" && requestPath === `/${index}`) {
      response.writeHead(indexStatus).end();
    } else if (method === "HEAD" && requestPath === `/_alias/${alias}`) {
      response.writeHead(aliasStatus).end();
    } else if (method === "PUT" && requestPath === `/${index}`) {
      indexStatus = 200;
      response.end(JSON.stringify({ acknowledged: true }));
    } else if (method === "POST" && requestPath === "/_aliases") {
      if (updateStatus === 200) {
        aliasStatus = 200;
      }
      response
        .writeHead(updateStatus)
        .end(JSON.stringify({ acknowledged: updateStatus === 200 }));
    } else {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: "Unexpected request" }));
    }
  });

  beforeEach(async () => {
    indexStatus = 200;
    aliasStatus = 404;
    updateStatus = 200;
    requests = [];
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    assert(address && typeof address !== "string");
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function runScript(args: string[]) {
    return new Promise<{
      code: number | string;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = execFile(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(__dirname, "create_elasticsearch_index.ts"),
          "--index-name",
          "skills",
          "--index-version",
          "1",
          ...args,
        ],
        {
          timeout: 10_000,
          env: {
            NODE_ENV: "development",
            ELASTICSEARCH_URL: url,
            ELASTICSEARCH_USERNAME: "dev",
            ELASTICSEARCH_PASSWORD: "dev",
          },
        },
        (error, stdout, stderr) => {
          resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
        }
      );
      child.stdin?.end("n\n");
    });
  }

  it("repairs a missing write alias without recreating the index, and can be rerun", async () => {
    const first = await runScript(["--execute", "--skip-confirmation"]);
    const second = await runScript(["--execute", "--skip-confirmation"]);

    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    expect(requests.filter((request) => request.method !== "HEAD")).toEqual([
      {
        method: "POST",
        path: "/_aliases",
        body: {
          actions: [{ add: { index, alias, is_write_index: true } }],
        },
      },
    ]);
  });

  it("preserves an existing alias without changing its target", async () => {
    aliasStatus = 200;

    const result = await runScript(["--execute", "--skip-confirmation"]);

    expect(result.code, result.stderr).toBe(0);
    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ["HEAD", "/"],
      ["HEAD", `/${index}`],
      ["HEAD", `/_alias/${alias}`],
    ]);
  });

  it.each([
    {
      mode: "a dry run",
      args: [],
      code: 0,
      output: "[DRY RUN] Would restore alias",
    },
    {
      mode: "declined confirmation",
      args: ["--execute"],
      code: 1,
      output: "Aborted",
    },
  ])(
    "leaves the missing alias unchanged on $mode",
    async ({ args, code, output }) => {
      const result = await runScript(args);

      expect(result.code).toBe(code);
      expect(result.stdout + result.stderr).toContain(output);
      expect(requests.filter((request) => request.method !== "HEAD")).toEqual(
        []
      );
    }
  );

  it("creates the index and write alias on a fresh setup", async () => {
    indexStatus = 404;

    const result = await runScript(["--execute", "--skip-confirmation"]);

    expect(result.code, result.stderr).toBe(0);
    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ["HEAD", "/"],
      ["HEAD", `/${index}`],
      ["PUT", `/${index}`],
      ["POST", "/_aliases"],
    ]);
    expect(requests[3].body).toEqual({
      actions: [{ add: { index, alias, is_write_index: true } }],
    });
  });

  it("fails without writing when the alias lookup fails", async () => {
    aliasStatus = 403;

    const result = await runScript(["--execute", "--skip-confirmation"]);

    expect(result.code).toBe(1);
    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ["HEAD", "/"],
      ["HEAD", `/${index}`],
      ["HEAD", `/_alias/${alias}`],
    ]);
  });

  it("reports alias repair failures without an already-exists success marker", async () => {
    updateStatus = 403;

    const result = await runScript(["--execute", "--skip-confirmation"]);

    expect(result.code).toBe(1);
    expect(requests.some((request) => request.method === "POST")).toBe(true);
    expect(result.stdout + result.stderr).not.toContain("already exists");
  });
});

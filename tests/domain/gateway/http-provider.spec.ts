import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createHttpMessagesProvider, type HttpTransport } from "../../../lib/domain/gateway/http-provider.ts";
import { parseModelRequest } from "../../../lib/domain/gateway/types.ts";
import { ProviderFailure } from "../../../lib/domain/gateway/errors.ts";

const REVIEW = {
  acknowledgeDataEgressReview: true as const,
  reviewer: "synthetic-review",
  reason: "loopback-only synthetic drill; no real child data, no real keys",
};

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req_test0001_gatewayB1",
    traceId: "trc_test0001_gatewayB1",
    turnId: "trn_test0001_gatewayB1",
    modelId: "real-mini",
    messages: [
      { role: "system", content: "[synthetic] system policy" },
      { role: "user", content: "[synthetic] hello" },
      { role: "assistant", content: "[synthetic] prior" },
      { role: "user", content: "[synthetic] again" },
    ],
    timeoutMs: 500,
    ...overrides,
  };
}

interface FakeRequestRecord {
  path: string;
  apiKeyHeader: string | undefined;
  contentType: string | undefined;
  body: Record<string, unknown>;
}

function startFakeMessagesServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void,
): Promise<{ url: string; requests: FakeRequestRecord[]; close: () => Promise<void> }> {
  const requests: FakeRequestRecord[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      requests.push({
        path: req.url ?? "/",
        apiKeyHeader: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined,
        body,
      });
      handler(req, res, body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no loopback port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((error) => (error === undefined ? res() : rej(error)));
          }),
      });
    });
  });
}

function sse(frames: Array<{ event: string; data: unknown }>): string {
  return frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join("");
}

const SUCCESS_FRAMES = sse([
  { event: "message_start", data: { message: { usage: { input_tokens: 11, output_tokens: 0 } } } },
  { event: "content_block_delta", data: { delta: { type: "text_delta", text: "HELLO " } } },
  { event: "content_block_delta", data: { delta: { type: "text_delta", text: "SYNTHETIC" } } },
  { event: "message_delta", data: { usage: { input_tokens: 11, output_tokens: 5 } } },
  { event: "message_stop", data: {} },
]);

async function collectStream(
  provider: ReturnType<typeof createHttpMessagesProvider>,
  request: unknown,
  signal: AbortSignal,
): Promise<{ deltas: string[]; usage: { inputTokens: number; outputTokens: number } | null }> {
  const deltas: string[] = [];
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  const parsed = parseModelRequest(request);
  for await (const event of provider.stream(parsed, { signal })) {
    if (event.type === "delta") {
      deltas.push(event.text);
    } else {
      usage = event.usage;
    }
  }
  return { deltas, usage };
}

test("the adapter streams the Messages protocol and maps it to gateway events", async () => {
  const server = await startFakeMessagesServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(SUCCESS_FRAMES);
  });
  try {
    const provider = createHttpMessagesProvider({
      providerId: "real-a",
      baseURL: server.url,
      keySource: () => "sk-synthetic-loopback-key",
      dataEgressReview: REVIEW,
    });
    const { deltas, usage } = await collectStream(
      provider,
      baseRequest(),
      new AbortController().signal,
    );
    assert.deepEqual(deltas, ["HELLO ", "SYNTHETIC"]);
    assert.deepEqual(usage, { inputTokens: 11, outputTokens: 5 });

    const sent = server.requests[0];
    assert.equal(sent.path, "/v1/messages");
    assert.equal(sent.apiKeyHeader, "sk-synthetic-loopback-key");
    assert.equal(sent.body.model, "real-mini");
    assert.equal(sent.body.stream, true);
    // The system message rides in the top-level system param, not messages.
    assert.deepEqual(sent.body.system, "[synthetic] system policy");
    assert.deepEqual(sent.body.messages, [
      { role: "user", content: "[synthetic] hello" },
      { role: "assistant", content: "[synthetic] prior" },
      { role: "user", content: "[synthetic] again" },
    ]);
    assert.equal(sent.body.max_tokens, 1024);
    assert.equal(provider.dataEgressAuthorized, true);
    assert.deepEqual(provider.registrationView().dataEgressReview, {
      reviewer: "synthetic-review",
      reason: "loopback-only synthetic drill; no real child data, no real keys",
    });
  } finally {
    await server.close();
  }
});

test("HTTP status classes map to static provider failure classifications", async () => {
  const expectations: Array<[number, ProviderFailure["classification"]]> = [
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limited"],
    [500, "server_error"],
    [503, "server_error"],
    [400, "bad_request"],
  ];
  for (const [status, classification] of expectations) {
    const server = await startFakeMessagesServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      // The body deliberately carries content that must never escape.
      res.end(JSON.stringify({ error: "DIRTY-PROVIDER-BODY-123" }));
    });
    try {
      const provider = createHttpMessagesProvider({
        providerId: "real-a",
        baseURL: server.url,
        keySource: () => "sk-synthetic-loopback-key",
        dataEgressReview: REVIEW,
      });
      await assert.rejects(
        () => collectStream(provider, baseRequest(), new AbortController().signal),
        (error: unknown) => {
          assert.ok(error instanceof ProviderFailure);
          assert.equal(error.classification, classification);
          assert.equal(error.statusClass, status);
          return true;
        },
        `status ${status} must classify as ${classification}`,
      );
    } finally {
      await server.close();
    }
  }
});

test("a missing credential fails closed before any request leaves", async () => {
  let calls = 0;
  const transport: HttpTransport = async () => {
    calls += 1;
    throw new Error("transport must never be called");
  };
  const provider = createHttpMessagesProvider({
    providerId: "real-a",
    baseURL: "https://api.example.test/v1",
    keySource: () => null,
    dataEgressReview: REVIEW,
  }, { transport });
  await assert.rejects(
    () => collectStream(provider, baseRequest(), new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof ProviderFailure);
      assert.equal(error.classification, "auth");
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("construction is fail-closed: no default endpoint, no silent credential, no unreviewed egress", () => {
  const keySource = (): string | null => "sk-synthetic";
  assert.throws(() => createHttpMessagesProvider({
    providerId: "real-a",
    baseURL: "",
    keySource,
    dataEgressReview: REVIEW,
  }), /absolute baseURL/);
  assert.throws(() => createHttpMessagesProvider({
    providerId: "real-a",
    baseURL: "http://api.example.test/v1",
    keySource,
    dataEgressReview: REVIEW,
  }), /https/);
  assert.throws(() => createHttpMessagesProvider({
    providerId: "real-a",
    baseURL: "https://user:pass@api.example.test/v1",
    keySource,
    dataEgressReview: REVIEW,
  }), /credentials/);
  assert.throws(() => createHttpMessagesProvider({
    providerId: "real-a",
    baseURL: "https://api.example.test/v1",
    keySource: undefined as unknown as () => string | null,
    dataEgressReview: REVIEW,
  }), /key source/);
  assert.throws(() => createHttpMessagesProvider({
    providerId: "real-a",
    baseURL: "https://api.example.test/v1",
    keySource,
    // Truthy-but-not-true acknowledgement must NOT pass the gate.
    dataEgressReview: {
      acknowledgeDataEgressReview: "yes" as unknown as true,
      reviewer: "x",
      reason: "y",
    },
  }), /acknowledgement/);
});

test("loopback plain http is allowed for synthetic test servers only", () => {
  const keySource = (): string | null => "sk-synthetic";
  assert.doesNotThrow(() => createHttpMessagesProvider({
    providerId: "real-a",
    baseURL: "http://127.0.0.1:9/v1",
    keySource,
    dataEgressReview: REVIEW,
  }));
  assert.doesNotThrow(() => createHttpMessagesProvider({
    providerId: "real-a",
    baseURL: "http://localhost:9/v1",
    keySource,
    dataEgressReview: REVIEW,
  }));
});

test("an in-flight stream is cancelled when the signal aborts", async () => {
  const server = await startFakeMessagesServer((_req, res) => {
    // Deliberately never respond: the request hangs until abort.
    void res;
  });
  try {
    const provider = createHttpMessagesProvider({
      providerId: "real-a",
      baseURL: server.url,
      keySource: () => "sk-synthetic-loopback-key",
      dataEgressReview: REVIEW,
    });
    const controller = new AbortController();
    const pending = collectStream(provider, baseRequest(), controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(() => pending, (error: unknown) => {
      assert.ok(error instanceof ProviderFailure);
      assert.equal(error.classification, "cancelled");
      return true;
    });
  } finally {
    await server.close();
  }
});

test("protocol violations in the SSE stream are rejected as provider failures", async () => {
  const cases: Array<{ name: string; frames: string; contentType?: string }> = [
    {
      name: "malformed json data frame",
      frames: 'event: content_block_delta\ndata: {not-json}\n\n',
    },
    {
      name: "stream ends without message_stop",
      frames: sse([{ event: "message_delta", data: { usage: { input_tokens: 1, output_tokens: 1 } } }]),
    },
    {
      name: "completed without usage",
      frames: sse([
        { event: "content_block_delta", data: { delta: { type: "text_delta", text: "hi" } } },
        { event: "message_stop", data: {} },
      ]),
    },
    {
      name: "non-event-stream body",
      frames: "just text",
      contentType: "application/json",
    },
  ];
  for (const spec of cases) {
    const server = await startFakeMessagesServer((_req, res) => {
      res.writeHead(200, { "content-type": spec.contentType ?? "text/event-stream" });
      res.end(spec.frames);
    });
    try {
      const provider = createHttpMessagesProvider({
        providerId: "real-a",
        baseURL: server.url,
        keySource: () => "sk-synthetic-loopback-key",
        dataEgressReview: REVIEW,
      });
      await assert.rejects(
        () => collectStream(provider, baseRequest(), new AbortController().signal),
        (error: unknown) => {
          assert.ok(error instanceof ProviderFailure, `${spec.name}: must be a ProviderFailure`);
          assert.equal(error.classification, "protocol", spec.name);
          return true;
        },
        spec.name,
      );
    } finally {
      await server.close();
    }
  }
});

test("the adapter never surfaces provider bodies, only status classes", async () => {
  const server = await startFakeMessagesServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "DIRTY-PROVIDER-BODY-123", key: "sk-synthetic-loopback-key" }));
  });
  try {
    const provider = createHttpMessagesProvider({
      providerId: "real-a",
      baseURL: server.url,
      keySource: () => "sk-synthetic-loopback-key",
      dataEgressReview: REVIEW,
    });
    try {
      await collectStream(provider, baseRequest(), new AbortController().signal);
      assert.fail("expected rejection");
    } catch (error) {
      assert.ok(error instanceof ProviderFailure);
      const serialized = JSON.stringify({
        message: error.message,
        classification: error.classification,
        statusClass: error.statusClass,
      });
      assert.equal(serialized.includes("DIRTY-PROVIDER-BODY-123"), false);
      assert.equal(serialized.includes("sk-synthetic-loopback-key"), false);
    }
  } finally {
    await server.close();
  }
});

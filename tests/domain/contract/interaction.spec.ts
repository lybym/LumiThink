import assert from "node:assert/strict";
import test from "node:test";

import {
  TEXT_LIMITS,
  fingerprintInteractionRequest,
  normalizeInteractionRequest,
  parseInteractionEvent,
  parseInteractionRequest,
} from "../../../lib/domain/contract/interaction.ts";
import { ContractValidationError } from "../../../lib/domain/contract/core.ts";

import {
  syntheticChildActor,
  syntheticVoiceDeviceActor,
  webTextInteractionRequestTurn1,
  webTextInteractionRequestTurn2,
  voiceAdapterTextInteractionRequestTurn1,
} from "../../../lib/domain/contract/fixtures.ts";

const SERVER_IDS = {
  eventId: "evt_test_event_0000001",
  conversationId: "conv_test_conversation_01",
  turnId: "trn_test_turn_00000001",
  traceId: "trc_test_trace_0000001",
  occurredAt: "2026-10-13T10:00:02.000Z",
};

function problemsOf(error: unknown): { code: string; path: string }[] {
  assert.ok(error instanceof ContractValidationError, "expected ContractValidationError");
  return error.problems.map((p) => ({ code: p.code, path: p.path }));
}

function assertProblemCodes(error: unknown, expected: { code: string; path: string }[]): void {
  const problems = problemsOf(error);
  for (const wanted of expected) {
    assert.ok(
      problems.some((p) => p.code === wanted.code && p.path === wanted.path),
      `expected problem ${wanted.code}@${wanted.path}, got ${JSON.stringify(problems)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Positive paths
// ---------------------------------------------------------------------------

test("web and voice-adapter request fixtures both parse", () => {
  const web = parseInteractionRequest(webTextInteractionRequestTurn1);
  assert.equal(web.interaction.kind, "text");
  assert.equal(web.interaction.clientContext?.client, "web");

  const voice = parseInteractionRequest(voiceAdapterTextInteractionRequestTurn1);
  assert.equal(voice.interaction.clientContext?.client, "voice_adapter");
});

test("web and voice-adapter requests normalize into the same standard event", () => {
  const web = normalizeInteractionRequest(parseInteractionRequest(webTextInteractionRequestTurn1), {
    actor: syntheticChildActor,
    ingress: "web",
    ...SERVER_IDS,
    boundConversationIds: [SERVER_IDS.conversationId],
  });
  const voice = normalizeInteractionRequest(
    parseInteractionRequest(voiceAdapterTextInteractionRequestTurn1),
    {
      actor: syntheticChildActor,
      ingress: "voice_adapter",
      ...SERVER_IDS,
      boundConversationIds: [SERVER_IDS.conversationId],
    },
  );

  // The standard event is identical except for the two fields that are
  // legitimately caller/transport-owned: the echoed idempotency key
  // (requestId — the client generated a fresh one per transport) and the
  // server-decided ingress. Every server-owned field must be equal.
  const webRecord = web.event as Record<string, unknown>;
  const voiceRecord = voice.event as Record<string, unknown>;
  const differingKeys = Object.keys(webRecord)
    .filter((key) => JSON.stringify(webRecord[key]) !== JSON.stringify(voiceRecord[key]))
    .sort();
  assert.deepEqual(differingKeys, ["ingress", "requestId"]);

  const { ingress: webIngress, requestId: _webRequestId, ...webRest } = web.event;
  const { ingress: voiceIngress, requestId: _voiceRequestId, ...voiceRest } = voice.event;
  assert.deepEqual(webRest, voiceRest);
  assert.equal(webIngress, "web");
  assert.equal(voiceIngress, "voice_adapter");
});

test("canonical events are frozen through the domain intake guard", () => {
  const { event } = normalizeInteractionRequest(
    parseInteractionRequest(webTextInteractionRequestTurn1),
    { actor: syntheticChildActor, ingress: "web", ...SERVER_IDS },
  );
  assert.ok(Object.isFrozen(event));
  assert.ok(Object.isFrozen(event.actor));
  assert.ok(Object.isFrozen(event.text));
});

test("multi-turn fixtures share the conversation but get fresh turn/trace/request ids", () => {
  // Turn 1 starts the conversation; turn 2 continues exactly that canonical
  // conversation (the client-supplied id must resolve to itself).
  const conversationId = "conv_demo_conversation_0001";
  const turn1 = normalizeInteractionRequest(parseInteractionRequest(webTextInteractionRequestTurn1), {
    actor: syntheticChildActor,
    ingress: "web",
    eventId: "evt_test_event_0000001",
    conversationId,
    turnId: "trn_test_turn_00000001",
    traceId: "trc_test_trace_0000001",
    occurredAt: "2026-10-13T10:00:02.000Z",
  }).event;
  const turn2 = normalizeInteractionRequest(parseInteractionRequest(webTextInteractionRequestTurn2), {
    actor: syntheticChildActor,
    ingress: "web",
    eventId: "evt_test_event_0000002",
    conversationId,
    turnId: "trn_test_turn_00000002",
    traceId: "trc_test_trace_0000002",
    occurredAt: "2026-10-13T10:01:00.000Z",
    boundConversationIds: [conversationId],
  }).event;

  assert.equal(turn2.conversationId, turn1.conversationId);
  assert.notEqual(turn2.turnId, turn1.turnId);
  assert.notEqual(turn2.traceId, turn1.traceId);
  assert.notEqual(turn2.requestId, turn1.requestId);
});

test("a bound conversation cannot be re-pointed to another canonical conversation", () => {
  // The client continues a bound conversation, but the server would record
  // the event under a different canonical id — this is a cross-conversation
  // correlation and must fail closed.
  assert.throws(
    () =>
      normalizeInteractionRequest(parseInteractionRequest(webTextInteractionRequestTurn2), {
        actor: syntheticChildActor,
        ingress: "web",
        eventId: "evt_test_event_0000004",
        conversationId: "conv_other_conversation_2",
        turnId: "trn_test_turn_00000004",
        traceId: "trc_test_trace_0000004",
        occurredAt: "2026-10-13T10:03:00.000Z",
        boundConversationIds: [webTextInteractionRequestTurn2.interaction.conversationId as string],
      }),
    (error: unknown) => {
      const problems = problemsOf(error);
      assert.equal(problems.length, 1);
      assert.equal(problems[0].code, "CONTRACT_CROSS_CONVERSATION");
      const serialized = JSON.stringify(problems);
      assert.equal(serialized.includes("conv_other_conversation_2"), false);
      assert.equal(
        serialized.includes(webTextInteractionRequestTurn2.interaction.conversationId as string),
        false,
      );
      return true;
    },
  );
});

test("parseInteractionEvent round-trips a canonical event and rejects corruption", () => {
  const { event } = normalizeInteractionRequest(
    parseInteractionRequest(webTextInteractionRequestTurn1),
    { actor: syntheticChildActor, ingress: "web", ...SERVER_IDS },
  );
  const reparsed = parseInteractionEvent(event);
  assert.deepEqual(reparsed, event);

  assert.throws(
    () => parseInteractionEvent({ ...event, requestId: "evt_not_a_request_id" }),
    (error: unknown) =>
      problemsOf(error).some((p) => p.path === "requestId" && p.code === "CONTRACT_FIELD_INVALID"),
  );
});

// ---------------------------------------------------------------------------
// Negative paths — the issue's acceptance criteria
// ---------------------------------------------------------------------------

test("missing required fields are reported per path", () => {
  const stripped = {
    interaction: {
      kind: "text",
      // clientRequestId missing
      text: { content: "hello", format: "plain" },
    },
    // protocolVersion missing
  };
  assert.throws(() => parseInteractionRequest(stripped), (error: unknown) => {
    assertProblemCodes(error, [
      { code: "CONTRACT_FIELD_MISSING", path: "protocolVersion" },
      { code: "CONTRACT_FIELD_MISSING", path: "interaction.clientRequestId" },
    ]);
    return true;
  });

  const noText = {
    protocolVersion: "1.0",
    interaction: { kind: "text", clientRequestId: "req_test_request_000001" },
  };
  assert.throws(() => parseInteractionRequest(noText), (error: unknown) => {
    assertProblemCodes(error, [{ code: "CONTRACT_FIELD_MISSING", path: "interaction.text" }]);
    return true;
  });

  const noContent = {
    protocolVersion: "1.0",
    interaction: { kind: "text", clientRequestId: "req_test_request_000001", text: {} },
  };
  assert.throws(() => parseInteractionRequest(noContent), (error: unknown) => {
    assertProblemCodes(error, [
      { code: "CONTRACT_FIELD_MISSING", path: "interaction.text.content" },
    ]);
    return true;
  });
});

test("unknown protocol version is rejected on the request path", () => {
  assert.throws(
    () =>
      parseInteractionRequest({
        protocolVersion: "9.9",
        interaction: {
          kind: "text",
          clientRequestId: "req_test_request_000001",
          text: { content: "hello", format: "plain" },
        },
      }),
    (error: unknown) => problemsOf(error)[0].code === "CONTRACT_UNKNOWN_VERSION",
  );
});

test("client-supplied identity fields are rejected as untrusted (actor/childId/sessionId/role)", () => {
  for (const [key, value] of [
    ["actor", { role: "child", actorId: "act_attacker_claim_1" }],
    ["actorContext", { role: "guardian" }],
    ["childId", "chd_someone_else"],
    ["child_id", "chd_someone_else"],
    ["childRef", "chd_demo_001"],
    ["role", "guardian"],
    ["sessionId", "ses_stolen_session_01"],
    ["session_id", "ses_stolen_session_01"],
    ["traceId", "trc_client_made_trace"],
  ] as const) {
    const smuggled = {
      protocolVersion: "1.0",
      interaction: {
        kind: "text",
        clientRequestId: "req_test_request_000001",
        text: { content: "hello", format: "plain" },
      },
      [key]: value,
    };
    assert.throws(
      () => parseInteractionRequest(smuggled),
      (error: unknown) => {
        const problems = problemsOf(error);
        return problems.some((p) => p.code === "CONTRACT_UNTRUSTED_IDENTITY");
      },
      `expected CONTRACT_UNTRUSTED_IDENTITY for top-level ${key}`,
    );

    const smuggledInInteraction = {
      protocolVersion: "1.0",
      interaction: {
        kind: "text",
        clientRequestId: "req_test_request_000001",
        text: { content: "hello", format: "plain" },
        [key]: value,
      },
    };
    assert.throws(
      () => parseInteractionRequest(smuggledInInteraction),
      (error: unknown) =>
        problemsOf(error).some((p) => p.code === "CONTRACT_UNTRUSTED_IDENTITY"),
      `expected CONTRACT_UNTRUSTED_IDENTITY for interaction.${key}`,
    );
  }
});

test("untrusted identity rejection happens even for empty/null values (fail-closed)", () => {
  assert.throws(
    () =>
      parseInteractionRequest({
        protocolVersion: "1.0",
        interaction: {
          kind: "text",
          clientRequestId: "req_test_request_000001",
          text: { content: "hello", format: "plain" },
          childId: null,
        },
      }),
    (error: unknown) => problemsOf(error).some((p) => p.code === "CONTRACT_UNTRUSTED_IDENTITY"),
  );
});

test("malicious long text is rejected with the limit detail and never echoed", () => {
  const marker = "MALICIOUS_LONG_TEXT_MARKER";
  const longText = "a".repeat(TEXT_LIMITS.maxChars + 1) + marker;
  try {
    parseInteractionRequest({
      protocolVersion: "1.0",
      interaction: {
        kind: "text",
        clientRequestId: "req_test_request_000001",
        text: { content: longText, format: "plain" },
      },
    });
    assert.fail("must throw");
  } catch (error) {
    assertProblemCodes(error, [
      { code: "CONTRACT_TEXT_TOO_LONG", path: "interaction.text.content" },
    ]);
    const validationError = error as ContractValidationError;
    const tooLong = validationError.problems.find((p) => p.code === "CONTRACT_TEXT_TOO_LONG");
    assert.equal(tooLong?.detail?.limit, TEXT_LIMITS.maxChars);
    const serialized = JSON.stringify(validationError.problems);
    assert.equal(serialized.includes(marker), false);
  }
});

test("a very large payload is rejected quickly (no pathological scan)", () => {
  const huge = "x".repeat(100_000);
  const startedAt = Date.now();
  assert.throws(
    () =>
      parseInteractionRequest({
        protocolVersion: "1.0",
        interaction: {
          kind: "text",
          clientRequestId: "req_test_request_000001",
          text: { content: huge, format: "plain" },
        },
      }),
    ContractValidationError,
  );
  assert.ok(Date.now() - startedAt < 2000, "long-text rejection must be linear and fast");
});

test("text length counts Unicode code points, not UTF-16 units", () => {
  const emoji = "😀";
  const ok = emoji.repeat(TEXT_LIMITS.maxChars); // 8000 UTF-16 units, 4000 code points
  assert.doesNotThrow(() =>
    parseInteractionRequest({
      protocolVersion: "1.0",
      interaction: {
        kind: "text",
        clientRequestId: "req_test_request_000001",
        text: { content: ok, format: "plain" },
      },
    }),
  );
  assert.throws(
    () =>
      parseInteractionRequest({
        protocolVersion: "1.0",
        interaction: {
          kind: "text",
          clientRequestId: "req_test_request_000001",
          text: { content: emoji.repeat(TEXT_LIMITS.maxChars + 1), format: "plain" },
        },
      }),
    (error: unknown) => problemsOf(error)[0].code === "CONTRACT_TEXT_TOO_LONG",
  );
});

test("empty and whitespace-only text is invalid", () => {
  for (const content of ["", "   ", "\n\t"]) {
    assert.throws(
      () =>
        parseInteractionRequest({
          protocolVersion: "1.0",
          interaction: {
            kind: "text",
            clientRequestId: "req_test_request_000001",
            text: { content, format: "plain" },
          },
        }),
      (error: unknown) =>
        problemsOf(error).some(
          (p) => p.path === "interaction.text.content" && p.code === "CONTRACT_FIELD_INVALID",
        ),
      `expected rejection for ${JSON.stringify(content)}`,
    );
  }
});

test("only kind=text and format=plain exist in contract v1.0", () => {
  assert.throws(
    () =>
      parseInteractionRequest({
        protocolVersion: "1.0",
        interaction: {
          kind: "voice",
          clientRequestId: "req_test_request_000001",
          text: { content: "hello", format: "plain" },
        },
      }),
    (error: unknown) =>
      problemsOf(error).some((p) => p.path === "interaction.kind" && p.code === "CONTRACT_FIELD_INVALID"),
  );
  assert.throws(
    () =>
      parseInteractionRequest({
        protocolVersion: "1.0",
        interaction: {
          kind: "text",
          clientRequestId: "req_test_request_000001",
          text: { content: "hello", format: "markdown" },
        },
      }),
    (error: unknown) =>
      problemsOf(error).some((p) => p.path === "interaction.text.format"),
  );
});

test("voice_device actors cannot submit text interactions (wrong role)", () => {
  assert.throws(
    () =>
      normalizeInteractionRequest(parseInteractionRequest(webTextInteractionRequestTurn1), {
        actor: syntheticVoiceDeviceActor,
        ingress: "voice_adapter",
        ...SERVER_IDS,
      }),
    (error: unknown) => problemsOf(error)[0].code === "CONTRACT_WRONG_ROLE",
  );
});

test("clientContext is advisory: unknown client versions are tolerated (upgrade compatibility)", () => {
  const legacyClient = parseInteractionRequest({
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: "req_test_request_000001",
      text: { content: "hello", format: "plain" },
      clientContext: { client: "web", clientVersion: "0.9.0-legacy-web" },
    },
  });
  assert.equal(legacyClient.interaction.clientContext?.clientVersion, "0.9.0-legacy-web");

  // Absent clientContext is fine too.
  const minimal = parseInteractionRequest({
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: "req_test_request_000001",
      text: { content: "hello", format: "plain" },
    },
  });
  assert.equal(minimal.interaction.clientContext, undefined);
});

test("clientContext rejects malformed values and vendor-protocol names", () => {
  assert.throws(
    () =>
      parseInteractionRequest({
        protocolVersion: "1.0",
        interaction: {
          kind: "text",
          clientRequestId: "req_test_request_000001",
          text: { content: "hello", format: "plain" },
          clientContext: { client: "xiaozhi" },
        },
      }),
    (error: unknown) =>
      problemsOf(error).some(
        (p) => p.path === "interaction.clientContext.client" && p.code === "CONTRACT_FIELD_INVALID",
      ),
  );
  assert.throws(
    () =>
      parseInteractionRequest({
        protocolVersion: "1.0",
        interaction: {
          kind: "text",
          clientRequestId: "req_test_request_000001",
          text: { content: "hello", format: "plain" },
          clientContext: { client: "web", clientVersion: "v1; drop table users" },
        },
      }),
    (error: unknown) =>
      problemsOf(error).some((p) => p.path === "interaction.clientContext.clientVersion"),
  );
});

test("ingress is decided by the server transport, not by the client claim", () => {
  const { event } = normalizeInteractionRequest(
    parseInteractionRequest(voiceAdapterTextInteractionRequestTurn1), // claims voice_adapter
    { actor: syntheticChildActor, ingress: "web", ...SERVER_IDS }, // arrives via web transport
  );
  assert.equal(event.ingress, "web");
});

test("cross-conversation correlation is rejected when the conversation is not bound to the actor", () => {
  assert.throws(
    () =>
      normalizeInteractionRequest(parseInteractionRequest(webTextInteractionRequestTurn2), {
        actor: syntheticChildActor,
        ingress: "web",
        eventId: "evt_test_event_0000003",
        conversationId: "conv_other_conversation_1",
        turnId: "trn_test_turn_00000003",
        traceId: "trc_test_trace_0000003",
        occurredAt: "2026-10-13T10:02:00.000Z",
        boundConversationIds: ["conv_my_conversation_001"],
      }),
    (error: unknown) => {
      const problems = problemsOf(error);
      assert.equal(problems.length, 1);
      assert.equal(problems[0].code, "CONTRACT_CROSS_CONVERSATION");
      // Neither the submitted id nor the bound list may be echoed.
      const serialized = JSON.stringify(problems);
      assert.equal(serialized.includes("conv_other_conversation_1"), false);
      assert.equal(serialized.includes("conv_my_conversation_001"), false);
      return true;
    },
  );
});

test("a new conversation may be started without a bound conversation id", () => {
  assert.doesNotThrow(() =>
    normalizeInteractionRequest(parseInteractionRequest(webTextInteractionRequestTurn1), {
      actor: syntheticChildActor,
      ingress: "web",
      ...SERVER_IDS,
    }),
  );
});

test("request fingerprints are semantic and stable across key order and client upgrades", () => {
  const a = fingerprintInteractionRequest(parseInteractionRequest(webTextInteractionRequestTurn1));
  const reordered = parseInteractionRequest({
    interaction: {
      text: { format: "plain", content: webTextInteractionRequestTurn1.interaction.text.content },
      clientRequestId: "req_anything_else_0001",
      kind: "text",
      clientContext: { clientVersion: "9.9.9-future-client", client: "web" },
    },
    protocolVersion: "1.0",
  });
  const b = fingerprintInteractionRequest(reordered);
  assert.equal(a, b, "semantic payload (version/kind/conversation/text) defines the fingerprint");
});

test("request fingerprints are content-free digests — no verbatim text is stored (review R1 P0-1)", () => {
  const content = webTextInteractionRequestTurn1.interaction.text.content;
  const fingerprint = fingerprintInteractionRequest(parseInteractionRequest(webTextInteractionRequestTurn1));
  // Hash-like bounded digest: 16 lowercase hex chars (64-bit FNV-1a).
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
  // No fragment of the submitted child text survives in the digest.
  for (const word of content.split(/(?<=[。，])|\s+/)) {
    if (word.length >= 2) {
      assert.ok(!fingerprint.includes(word), `the digest must not embed the submitted text fragment`);
    }
  }
  // Deterministic: the same semantic payload hashes to the same digest, and
  // distinguishing payloads hash differently (replay-vs-409 is preserved).
  assert.equal(fingerprint, fingerprintInteractionRequest(parseInteractionRequest(webTextInteractionRequestTurn1)));
  const differentText = parseInteractionRequest({
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: "req_other_text_0001",
      text: { content: "[synthetic] 换一段完全不同的内容。", format: "plain" },
    },
  });
  assert.notEqual(fingerprint, fingerprintInteractionRequest(differentText));
  const differentConversation = parseInteractionRequest({
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: "req_other_conv_0001",
      conversationId: "conv_other_conversation_1",
      text: { content, format: "plain" },
    },
  });
  assert.notEqual(fingerprint, fingerprintInteractionRequest(differentConversation));
  // Degenerate payloads stay distinguishable (no truncation-style collapse).
  const minimal = parseInteractionRequest({
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: "req_min_text_0001",
      text: { content: "a", format: "plain" },
    },
  });
  const minimalOther = parseInteractionRequest({
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: "req_min_text_0002",
      text: { content: "b", format: "plain" },
    },
  });
  assert.notEqual(
    fingerprintInteractionRequest(minimal),
    fingerprintInteractionRequest(minimalOther),
  );
});

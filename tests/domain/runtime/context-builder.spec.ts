import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHarnessContext,
  composeModelMessages,
  MAX_CONTEXT_HISTORY_MESSAGES,
  MAX_CONTEXT_TOTAL_CHARS,
} from "../../../lib/domain/runtime/context-builder.ts";
import { MAX_MODEL_MESSAGE_CHARS } from "../../../lib/domain/gateway/types.ts";
import { syntheticActor, SYNTHETIC_CONVERSATION_A, SYNTHETIC_SESSION_A } from "./helpers.ts";

const BASE_CONTEXT = {
  requestId: "req_r1t3cx000001",
  sessionId: SYNTHETIC_SESSION_A,
  conversationId: SYNTHETIC_CONVERSATION_A,
  actor: syntheticActor(),
  personaVersion: "1.0.0",
};

test("harness context carries the HARNESS §2 field set with bounded budget", () => {
  const context = buildHarnessContext({
    ...BASE_CONTEXT,
    skillVersions: [{ skillId: "emotion_support", version: "1.0.0" }],
    contextRefs: [{ kind: "evidence", refId: "ev_synthetic_card_01", version: "1.0.0" }],
    unknownFields: ["clientPreferredSkin"],
  });
  assert.equal(context.protocolVersion, "1.0");
  assert.equal(context.requestId, "req_r1t3cx000001");
  assert.equal(context.sessionId, SYNTHETIC_SESSION_A);
  assert.equal(context.actor.role, "child");
  assert.equal(context.personaVersion, "1.0.0");
  assert.deepEqual([...context.skillVersions], [{ skillId: "emotion_support", version: "1.0.0" }]);
  assert.equal(context.contextRefs.length, 1);
  assert.equal(context.contextRefs[0]?.kind, "evidence");
  assert.equal(context.contextRefs[0]?.version, "1.0.0");
  assert.equal(context.epoch, 0);
  assert.deepEqual([...context.unknownFields], ["clientPreferredSkin"]);
  assert.equal(context.budget.maxHistoryMessages, MAX_CONTEXT_HISTORY_MESSAGES);
  assert.equal(context.budget.maxContextChars, MAX_CONTEXT_TOTAL_CHARS);
  assert.equal(context.budget.maxModelCallsPerTurn, 1);
  // Frozen: the context cannot be mutated after intake.
  assert.throws(() => {
    (context as unknown as { epoch: number }).epoch = 1;
  });
});

test("context refs are ids/versions only — no content field exists to leak through", () => {
  const context = buildHarnessContext({
    ...BASE_CONTEXT,
    contextRefs: [
      { kind: "evidence", refId: "ev_synthetic_card_01", version: "1.0.0" },
      { kind: "memory", refId: "mem_demo_pref_01", version: null },
    ],
  });
  for (const ref of context.contextRefs) {
    const keys = Object.keys(ref);
    assert.deepEqual([...keys].sort(), ["kind", "refId", "version"]);
    assert.ok(!("content" in ref));
    assert.ok(!("body" in ref));
  }
});

test("invalid shapes fail closed: bad actor, unknown fields, oversized ref ids, bad budget", () => {
  assert.throws(() => buildHarnessContext({ ...BASE_CONTEXT, actor: { role: "child" } }));
  assert.throws(() =>
    buildHarnessContext({ ...BASE_CONTEXT, intruder: true } as unknown as Parameters<typeof buildHarnessContext>[0]),
  );
  assert.throws(() =>
    buildHarnessContext({
      ...BASE_CONTEXT,
      contextRefs: [{ kind: "evidence", refId: "x".repeat(200), version: null }],
    }),
  );
  assert.throws(() =>
    buildHarnessContext({ ...BASE_CONTEXT, budget: { maxHistoryMessages: 0, maxContextChars: 5000 } }),
  );
  assert.throws(() =>
    buildHarnessContext({ ...BASE_CONTEXT, unknownFields: ["x".repeat(100)] }),
  );
});

test("model messages: registry-owned system part, bounded history, current text last", () => {
  const messages = composeModelMessages({
    identityDisclosure: "我是 Lumi，一个 AI 伙伴（synthetic）。",
    boundaries: ["relation.no_exclusive_relationship", "relation.no_unconditional_secrecy"],
    skillHeader: "Active skill: emotion_support@1.0.0",
    history: [
      { role: "user", content: "synthetic 1" },
      { role: "assistant", content: "synthetic reply 1" },
      { role: "user", content: "synthetic 2" },
    ],
    currentText: "synthetic 当前输入",
    budget: { maxHistoryMessages: 2, maxContextChars: MAX_CONTEXT_TOTAL_CHARS },
  });
  assert.equal(messages.length, 4); // system + 2 history + current
  assert.equal(messages[0]?.role, "system");
  assert.ok(messages[0]?.content.includes("我是 Lumi"));
  assert.ok(messages[0]?.content.includes("relation.no_exclusive_relationship"));
  assert.ok(messages[0]?.content.includes("emotion_support@1.0.0"));
  // Oldest history dropped first.
  assert.equal(messages[1]?.content, "synthetic reply 1");
  assert.equal(messages[2]?.content, "synthetic 2");
  assert.equal(messages[3]?.role, "user");
  assert.equal(messages[3]?.content, "synthetic 当前输入");
});

test("history budget drops oldest-first and always keeps the current turn", () => {
  const filler = "x".repeat(200);
  const messages = composeModelMessages({
    identityDisclosure: "disclosure",
    boundaries: ["b1"],
    skillHeader: null,
    history: [
      { role: "user", content: `oldest-${filler}` },
      { role: "assistant", content: `older-reply-${filler}` },
      { role: "user", content: `recent-${filler}` },
    ],
    currentText: "current synthetic input",
    // 600 < system + current + all three history messages, but ≥ the two
    // newest ones → the OLDEST message is dropped, never the current turn.
    budget: { maxHistoryMessages: 4, maxContextChars: 600 },
  });
  const contents = messages.map((message) => message.content);
  assert.ok(contents.includes("current synthetic input"));
  assert.ok(!contents.some((content) => content.startsWith("oldest-")), "oldest message dropped under budget");
  assert.ok(contents.some((content) => content.startsWith("older-reply-")));
  assert.ok(contents.some((content) => content.startsWith("recent-")));
});

test("a single over-limit history message fails closed instead of being truncated", () => {
  assert.throws(() =>
    composeModelMessages({
      identityDisclosure: "disclosure",
      boundaries: [],
      skillHeader: null,
      history: [{ role: "user", content: "y".repeat(MAX_MODEL_MESSAGE_CHARS + 1) }],
      currentText: "current",
      budget: { maxHistoryMessages: 4, maxContextChars: MAX_CONTEXT_TOTAL_CHARS },
    }),
  );
});

test("malformed composition inputs fail closed", () => {
  assert.throws(() =>
    composeModelMessages({
      identityDisclosure: "disclosure",
      boundaries: ["ok"],
      skillHeader: null,
      history: [{ role: "system", content: "role injection" }],
      currentText: "current",
      budget: { maxHistoryMessages: 4, maxContextChars: MAX_CONTEXT_TOTAL_CHARS },
    }),
  );
  assert.throws(() =>
    composeModelMessages({
      identityDisclosure: "disclosure",
      boundaries: ["ok"],
      skillHeader: null,
      history: [],
      currentText: "",
      budget: { maxHistoryMessages: 4, maxContextChars: MAX_CONTEXT_TOTAL_CHARS },
    }),
  );
});

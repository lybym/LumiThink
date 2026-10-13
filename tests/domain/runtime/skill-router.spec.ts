import assert from "node:assert/strict";
import test from "node:test";

import { routeSkillForText, SKILL_ROUTER_VERSION } from "../../../lib/domain/runtime/skill-router.ts";

test("emotion signals route to emotion_support", () => {
  const decision = routeSkillForText("[synthetic] 我今天很委屈，不想继续讲了。");
  assert.equal(decision.route, "emotion_support");
  assert.equal(decision.reason, "emotion_signal");
  assert.equal(decision.arbitration, null);
  assert.equal(decision.routerVersion, SKILL_ROUTER_VERSION);
});

test("homework signals route to homework_initiation", () => {
  const decision = routeSkillForText("[synthetic] 一道数学题不会，我现在其他作业也不想写。");
  assert.equal(decision.route, "homework_initiation");
  assert.equal(decision.reason, "homework_signal");
  assert.equal(decision.arbitration, null);
});

test("joint emotion+homework input arbitrates deterministically to emotion_support", () => {
  const decision = routeSkillForText("[synthetic] 我一想到不会的数学题就很生气。");
  assert.equal(decision.route, "emotion_support");
  assert.equal(decision.reason, "joint_emotion_precedence");
  assert.equal(decision.arbitration, "emotion_precedence");
});

test("neutral input routes to none", () => {
  const decision = routeSkillForText("[synthetic] 今天天气怎么样？");
  assert.equal(decision.route, "none");
  assert.equal(decision.reason, "no_signal");
  assert.equal(decision.arbitration, null);
});

test("routing is deterministic and never echoes the submitted text", () => {
  const text = "[synthetic] 我很难过，作业也不会写。";
  const first = routeSkillForText(text);
  const second = routeSkillForText(text);
  assert.deepEqual(first, second);
  const serialized = JSON.stringify(first);
  assert.ok(!serialized.includes("难过"));
  assert.ok(!serialized.includes("作业"));
});

test("non-string input fails closed", () => {
  assert.throws(() => routeSkillForText(42 as unknown as string));
  assert.throws(() => routeSkillForText(null as unknown as string));
});

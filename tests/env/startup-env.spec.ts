import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_BOOT_REQUIREMENTS,
  StartupEnvError,
  readStartupEnv,
  type EnvSource,
} from "../../lib/env.ts";

test("an empty environment boots with safe defaults and no external requirements", () => {
  const env = readStartupEnv({});
  assert.deepEqual(env, { nodeEnv: "development", port: null });

  assert.deepEqual(FIRST_BOOT_REQUIREMENTS.modelProviderKeysRequired, []);
  assert.equal(FIRST_BOOT_REQUIREMENTS.childDataRequired, false);
  assert.equal(FIRST_BOOT_REQUIREMENTS.databaseRequired, false);
  assert.equal(FIRST_BOOT_REQUIREMENTS.telemetry, "disabled-by-default");
});

test("NODE_ENV accepts only the documented values", () => {
  assert.equal(readStartupEnv({ NODE_ENV: "production" }).nodeEnv, "production");
  assert.equal(readStartupEnv({ NODE_ENV: "test" }).nodeEnv, "test");
  assert.equal(readStartupEnv({ NODE_ENV: "" }).nodeEnv, "development");

  assert.throws(() => readStartupEnv({ NODE_ENV: "staging" }), (error: unknown) => {
    assert.ok(error instanceof StartupEnvError);
    assert.deepEqual(error.problems, ["NODE_ENV must be one of development | production | test when set"]);
    return true;
  });
});

test("PORT must be a valid TCP port when set", () => {
  assert.equal(readStartupEnv({ PORT: "3123" }).port, 3123);
  assert.equal(readStartupEnv({ PORT: "" }).port, null);

  for (const bad of ["0", "-1", "65536", "abc", "80.5"]) {
    assert.throws(() => readStartupEnv({ PORT: bad }), (error: unknown) => {
      assert.ok(error instanceof StartupEnvError);
      assert.match(error.problems[0], /PORT/);
      return true;
    });
  }
});

test("DATABASE_URL is optional but must target SQLite while the legacy schema is frozen", () => {
  assert.doesNotThrow(() => readStartupEnv({}));
  assert.doesNotThrow(() => readStartupEnv({ DATABASE_URL: "file:./data/lumithink-dev.db" }));

  assert.throws(
    () => readStartupEnv({ DATABASE_URL: "postgresql://user:secret@db.internal/lumi" }),
    (error: unknown) => {
      assert.ok(error instanceof StartupEnvError);
      assert.match(error.problems[0], /DATABASE_URL/);
      assert.match(error.problems[0], /file:/);
      // Values are never echoed back.
      assert.equal(error.problems.join(" ").includes("secret"), false);
      return true;
    },
  );
});

test("validation collects all problems and never echoes variable values", () => {
  const badEnv: EnvSource = { NODE_ENV: "qa", PORT: "0", DATABASE_URL: "mysql://x" };
  assert.throws(() => readStartupEnv(badEnv), (error: unknown) => {
    assert.ok(error instanceof StartupEnvError);
    assert.equal(error.problems.length, 3);
    return true;
  });
});

test("provider credentials present in the environment are ignored, never required", () => {
  // Simulates a developer machine that happens to carry model keys: the
  // baseline startup env must neither read nor require them.
  const envWithKeys: EnvSource = {
    DEEPSEEK_API_KEY: "sk-synthetic-not-real",
    OPENAI_API_KEY: "sk-synthetic-not-real",
  };
  assert.doesNotThrow(() => readStartupEnv(envWithKeys));
  const serialized = JSON.stringify(FIRST_BOOT_REQUIREMENTS);
  assert.equal(serialized.includes("DEEPSEEK_API_KEY"), false);
  assert.equal(serialized.includes("OPENAI_API_KEY"), false);
});

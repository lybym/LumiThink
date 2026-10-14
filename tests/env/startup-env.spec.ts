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
  assert.deepEqual(env, {
    nodeEnv: "development",
    port: null,
    guardianAccessCode: null,
    adminAccessCode: null,
    snapshot: { path: null, keyHex: null, keyFile: null, intervalMs: null, restoreReplay: false },
  });

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

// ---------------------------------------------------------------------------
// R1-08 (issue #20): deployment secrets + encrypted snapshot configuration.
// ---------------------------------------------------------------------------

const GOOD_CODE = "correct-horse-battery";
const GOOD_KEY = "a".repeat(64);

test("R1-08: real access codes parse only as a PAIR and reject demo collisions", () => {
  // Both unset → demo mode.
  assert.equal(readStartupEnv({}).guardianAccessCode, null);
  // Both set → real mode.
  const paired = readStartupEnv({
    LUMITHINK_GUARDIAN_ACCESS_CODE: GOOD_CODE,
    LUMITHINK_ADMIN_ACCESS_CODE: GOOD_CODE,
  });
  assert.equal(paired.guardianAccessCode, GOOD_CODE);
  assert.equal(paired.adminAccessCode, GOOD_CODE);
  // Exactly one set → fail-closed (a half-real deployment would silently
  // leave the other role on the published demo code).
  assert.throws(() => readStartupEnv({ LUMITHINK_GUARDIAN_ACCESS_CODE: GOOD_CODE }), (error: unknown) => {
    assert.ok(error instanceof StartupEnvError);
    assert.match(error.problems.join(" "), /must be set together/);
    return true;
  });
  // Demo-code collision is a misconfiguration.
  assert.throws(
    () =>
      readStartupEnv({
        LUMITHINK_GUARDIAN_ACCESS_CODE: "lumithink-guardian-demo",
        LUMITHINK_ADMIN_ACCESS_CODE: GOOD_CODE,
      }),
    (error: unknown) => {
      assert.ok(error instanceof StartupEnvError);
      assert.match(error.problems.join(" "), /must not be the published synthetic demo code/);
      return true;
    },
  );
  // Shape bounds (12-128, no whitespace), values never echoed.
  assert.throws(
    () =>
      readStartupEnv({
        LUMITHINK_GUARDIAN_ACCESS_CODE: "short",
        LUMITHINK_ADMIN_ACCESS_CODE: GOOD_CODE,
      }),
    (error: unknown) => {
      assert.ok(error instanceof StartupEnvError);
      assert.match(error.problems.join(" "), /LUMITHINK_GUARDIAN_ACCESS_CODE/);
      assert.equal(error.problems.join(" ").includes("short"), false);
      return true;
    },
  );
});

test("R1-08: snapshot config requires a key, exactly one source, and valid shapes", () => {
  // Path without a key → plaintext snapshots are never allowed.
  assert.throws(() => readStartupEnv({ LUMITHINK_SNAPSHOT_PATH: "/var/lib/lumithink/snapshot.bin" }), (error: unknown) => {
    assert.ok(error instanceof StartupEnvError);
    assert.match(error.problems.join(" "), /snapshots are always encrypted/);
    return true;
  });
  // Both key sources → ambiguous, fail-closed.
  assert.throws(
    () =>
      readStartupEnv({
        LUMITHINK_SNAPSHOT_PATH: "/tmp/snapshot.bin",
        LUMITHINK_SNAPSHOT_KEY: GOOD_KEY,
        LUMITHINK_SNAPSHOT_KEY_FILE: "/etc/lumithink/snapshot.key",
      }),
    (error: unknown) => {
      assert.ok(error instanceof StartupEnvError);
      assert.match(error.problems.join(" "), /mutually exclusive/);
      return true;
    },
  );
  // Key-file source is accepted and carried as a path.
  const withFile = readStartupEnv({
    LUMITHINK_SNAPSHOT_PATH: "/var/lib/lumithink/snapshot.bin",
    LUMITHINK_SNAPSHOT_KEY_FILE: "/etc/lumithink/snapshot.key",
    LUMITHINK_SNAPSHOT_INTERVAL_MS: "30000",
  });
  assert.equal(withFile.snapshot.path, "/var/lib/lumithink/snapshot.bin");
  assert.equal(withFile.snapshot.keyFile, "/etc/lumithink/snapshot.key");
  assert.equal(withFile.snapshot.keyHex, null);
  assert.equal(withFile.snapshot.intervalMs, 30000);
  // Inline key is normalized to lowercase hex.
  const withKey = readStartupEnv({
    LUMITHINK_SNAPSHOT_PATH: "/tmp/snapshot.bin",
    LUMITHINK_SNAPSHOT_KEY: "A".repeat(64),
  });
  assert.equal(withKey.snapshot.keyHex, GOOD_KEY);
  // Bad key shape fails with the NAME only.
  assert.throws(
    () => readStartupEnv({ LUMITHINK_SNAPSHOT_PATH: "/tmp/snapshot.bin", LUMITHINK_SNAPSHOT_KEY: "zz" }),
    (error: unknown) => {
      assert.ok(error instanceof StartupEnvError);
      assert.match(error.problems.join(" "), /LUMITHINK_SNAPSHOT_KEY must be exactly 64 hex/);
      return true;
    },
  );
  // Interval bounds.
  assert.throws(
    () =>
      readStartupEnv({
        LUMITHINK_SNAPSHOT_PATH: "/tmp/snapshot.bin",
        LUMITHINK_SNAPSHOT_KEY: GOOD_KEY,
        LUMITHINK_SNAPSHOT_INTERVAL_MS: "10",
      }),
    (error: unknown) => {
      assert.ok(error instanceof StartupEnvError);
      assert.match(error.problems.join(" "), /LUMITHINK_SNAPSHOT_INTERVAL_MS/);
      return true;
    },
  );
});

test("R1-08: restore-replay flag accepts only the documented booleans", () => {
  const base = { LUMITHINK_SNAPSHOT_PATH: "/tmp/snapshot.bin", LUMITHINK_SNAPSHOT_KEY: GOOD_KEY };
  assert.equal(readStartupEnv(base).snapshot.restoreReplay, false);
  assert.equal(readStartupEnv({ ...base, LUMITHINK_SNAPSHOT_RESTORE_REPLAY: "1" }).snapshot.restoreReplay, true);
  assert.equal(readStartupEnv({ ...base, LUMITHINK_SNAPSHOT_RESTORE_REPLAY: "false" }).snapshot.restoreReplay, false);
  assert.throws(() => readStartupEnv({ ...base, LUMITHINK_SNAPSHOT_RESTORE_REPLAY: "yes" }), (error: unknown) => {
    assert.ok(error instanceof StartupEnvError);
    assert.match(error.problems.join(" "), /LUMITHINK_SNAPSHOT_RESTORE_REPLAY/);
    return true;
  });
});

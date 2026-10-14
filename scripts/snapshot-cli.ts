/**
 * R1-08 snapshot CLI (issue #20 backup/restore drill; deploy/backup.sh and
 * deploy/restore.sh drive it).
 *
 * Commands:
 *   node --experimental-strip-types scripts/snapshot-cli.ts verify <file> (--key-hex <hex> | --key-file <path>)
 *     Decrypts + validates the snapshot envelope and prints STRUCTURAL
 *     metadata only (format, source, createdAt, counts, fingerprint). Never
 *     prints payload content or key material.
 *
 *   node --experimental-strip-types scripts/snapshot-cli.ts rotate-key <file> --from-hex <hex>|--from-file <path> --to-hex <hex>|--to-file <path>
 *     Decrypts with the old key and re-encrypts with the new key (atomic
 *     replace). Used for secret rotation (runbook §rotation).
 */
import { readSnapshotFileSync, readSnapshotKeyFileSync, SnapshotStoreError, writeSnapshotFileSync } from "../lib/server/snapshot/snapshot-store.ts";
import { snapshotFingerprint, validateRuntimeSnapshot } from "../lib/server/snapshot/runtime-snapshot.ts";

interface KeyArgs {
  readonly keyHex: string;
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new SnapshotStoreError("bad_args", `missing value for ${arg}`);
      }
      parsed[arg] = value;
      i += 1;
    } else {
      parsed.positional ??= arg;
    }
  }
  return parsed;
}

function resolveKey(args: Record<string, string>, prefix: string): string {
  const hex = args[`--${prefix}-hex`];
  const file = args[`--${prefix}-file`];
  if (hex !== undefined && file !== undefined) {
    throw new SnapshotStoreError("bad_args", `choose one key source for --${prefix}`);
  }
  if (hex !== undefined) {
    return hex;
  }
  if (file !== undefined) {
    return readSnapshotKeyFileSync(file);
  }
  throw new SnapshotStoreError("bad_args", `no key source for --${prefix} (use --${prefix}-hex or --${prefix}-file)`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  if (command === "verify") {
    const file = args.positional;
    if (file === undefined) {
      throw new SnapshotStoreError("bad_args", "verify requires a snapshot file path");
    }
    const key = resolveKey(args, "key");
    const plaintext = readSnapshotFileSync(file, key);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext) as unknown;
    } catch {
      throw new SnapshotStoreError("bad_json", "the snapshot does not contain valid JSON.");
    }
    const snapshot = validateRuntimeSnapshot(parsed);
    console.log(
      JSON.stringify(
        {
          format: snapshot.format,
          source: snapshot.source,
          createdAt: snapshot.createdAt,
          counts: snapshot.counts,
          fingerprint: snapshotFingerprint(snapshot),
          tombstones: snapshot.tombstones.length,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "rotate-key") {
    const file = args.positional;
    if (file === undefined) {
      throw new SnapshotStoreError("bad_args", "rotate-key requires a snapshot file path");
    }
    const fromKey = resolveKey(args, "from");
    const toKey = resolveKey(args, "to");
    const plaintext = readSnapshotFileSync(file, fromKey);
    // Validate before re-encrypting so a wrong-format file never lands.
    validateRuntimeSnapshot(JSON.parse(plaintext) as unknown);
    writeSnapshotFileSync(file, plaintext, toKey);
    console.log(`rotated: ${file}`);
    return;
  }
  throw new SnapshotStoreError("bad_args", "unknown command (use: verify | rotate-key)");
}

try {
  main();
} catch (error) {
  console.error(error instanceof SnapshotStoreError ? error.message : "snapshot cli failed");
  process.exit(1);
}

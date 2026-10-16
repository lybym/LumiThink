/**
 * E2E-03 (issue #53) — OPT-IN real-provider evidence runner (DoD 1).
 *
 * Runs the REAL locked-version DSH runtime through the Model Gateway egress
 * proxy against the REVIEWED real provider record (LUMITHINK_MODEL_ROUTE=real
 * + the full activation record + the request-time credential) and produces a
 * sanitized three-round evidence file: per-turn token counts, integer
 * micro-USD cost, duration and model id — all from the gateway audit, never
 * from the child.
 *
 * Hard opt-in gates (fail closed, never a silent real call):
 *   - `LUMITHINK_E2E03_REAL=1` must be set explicitly for THIS run;
 *   - the full `LUMITHINK_REAL_PROVIDER_*` activation record must parse;
 *   - `LUMITHINK_MODEL_PROVIDER_KEY` must be present (preflight check: the
 *     value is never printed).
 * CI never sets any of these: `pnpm test` / the R0+E2E gates stay all-mock
 * and loopback-only (issue #53 DoD 3).
 *
 * PRIVACY: prompts are synthetic operator samples marked `E2E03-REAL`; the
 * evidence file carries structural facts only (no prompt text, no key, no
 * child data — the child-data egress review stays `not_performed`).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseRealProviderActivation,
  buildRealProviderGateway,
  RealProviderActivationError,
  type RealProviderActivationRecord,
} from '../../../lib/server/real-provider-composition.ts'
import { createGatewayEgressProxy } from '../../../lib/server/gateway-egress-proxy.ts'
import {
  startBridgeFixture,
  submitAndAwaitCompletion,
} from '../tests/bridge/helpers.ts'

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))
const ROUNDS = 3
const TURN_TIMEOUT_MS = 120_000

/** The synthetic operator prompts (adult/operator verification content only). */
const PROMPTS = Object.freeze([
  'E2E03-REAL-R1 运营者合成验证提示：请用一句话确认你收到这条消息。',
  'E2E03-REAL-R2 运营者合成验证提示：请复述数字 3、5、8 并结束。',
  'E2E03-REAL-R3 运营者合成验证提示：请回答 2+3 等于多少并结束。',
])

function fail(message: string): never {
  process.stderr.write(`E2E-03 real-provider evidence run: BLOCKED — ${message}\n`)
  process.exitCode = 1
  throw new Error(message)
}

async function main(): Promise<void> {
  if (process.env.LUMITHINK_E2E03_REAL !== '1') {
    fail('LUMITHINK_E2E03_REAL=1 is required: this runner performs REAL provider egress and must be explicitly opted in (CI never sets it)')
  }
  if (process.env.LUMITHINK_MODEL_PROVIDER_KEY === undefined || process.env.LUMITHINK_MODEL_PROVIDER_KEY === '') {
    fail('LUMITHINK_MODEL_PROVIDER_KEY is not set: without a credential the run would fail closed at every turn')
  }

  const activationResult = (() => {
    try {
      return parseRealProviderActivation(process.env)
    } catch (error) {
      if (error instanceof RealProviderActivationError) {
        fail(`the activation record is incomplete (variable NAMES only): ${error.problems.join('; ')}`)
      }
      throw error
    }
  })()
  if (activationResult.mode !== 'real') {
    fail('LUMITHINK_MODEL_ROUTE=real with the full provider record is required for the real evidence run')
  }
  const record: RealProviderActivationRecord = activationResult.record

  const { gateway } = buildRealProviderGateway(record, process.env)
  const proxy = createGatewayEgressProxy({ gateway, allowedModelIds: [record.modelId] })
  const started = await proxy.start()
  process.stdout.write(`E2E-03 real run: gateway egress proxy on ${started.url} (loopback)\n`)

  const fixture = await startBridgeFixture({
    script: {},
    workerEnv: { DSH_BRIDGE_MODEL_BASE_URL: started.url },
  })
  const turnRows: Array<Record<string, unknown>> = []
  try {
    const sessionKey = fixture.sessionKey
    const opened = await fixture.stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e03realev01',
      ownerActorId: 'act_e2e03operator01',
    })
    if (!opened.ok) {
      fail(`session.open refused: ${JSON.stringify(opened)}`)
    }

    let auditCursor = 0
    for (let index = 1; index <= ROUNDS; index += 1) {
      auditCursor = gateway.auditTrail().length
      await submitAndAwaitCompletion(
        fixture.stack,
        sessionKey,
        PROMPTS[index - 1] ?? PROMPTS[0],
        TURN_TIMEOUT_MS,
        fixture.forensics,
      )
      const audit = gateway.auditTrail()
      const completed = audit.slice(auditCursor).filter((event) => event.type === 'turn.completed')
      const last = completed.at(-1)
      if (last === undefined) {
        fail(`round ${index} completed without a turn.completed audit event — no evidence row can be produced`)
      }
      turnRows.push({
        index,
        requestId: last.requestId,
        modelId: last.modelId,
        providerId: last.providerId,
        attempts: last.attempts,
        inputTokens: last.inputTokens,
        outputTokens: last.outputTokens,
        costMicroUsd: last.costMicroUsd,
        durationMs: last.durationMs,
      })
      process.stdout.write(
        `round ${index}/${ROUNDS}: model=${last.modelId} tokens=${last.inputTokens}/${last.outputTokens} costMicroUsd=${last.costMicroUsd} durationMs=${last.durationMs}\n`,
      )
    }

    const totalCost = turnRows.reduce((sum, row) => sum + Number(row.costMicroUsd ?? 0), 0)
    const evidence = {
      schema: 'lumithink.e2e03-real-provider-evidence@1',
      issue: 'https://github.com/lybym/LumiThink/issues/53',
      generatedAt: new Date().toISOString(),
      mode: 'real',
      providerId: record.providerId,
      providerBaseURLOrigin: new URL(record.baseURL).origin,
      modelId: record.modelId,
      dataEgressReview: {
        reviewer: record.dataEgressReview.reviewer,
        reason: record.dataEgressReview.reason,
      },
      childDataEgressReview: 'not_performed',
      rounds: ROUNDS,
      turns: turnRows,
      totalCostMicroUsd: totalCost,
    }
    const reportsDir = join(MODULE_DIR, '..', 'reports')
    await mkdir(reportsDir, { recursive: true })
    const outPath = join(reportsDir, 'e2e03-real-evidence.json')
    await writeFile(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    process.stdout.write(`E2E-03 real run: PASS — evidence written to ${outPath}\n`)
  } finally {
    await fixture.dispose().catch(() => undefined)
    await proxy.stop().catch(() => undefined)
  }
}

/** Run only when this file is the process entry point (not when imported). */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  return typeof entry === 'string' && resolve(entry) === resolve(import.meta.filename)
}

if (isEntryPoint()) {
  main().catch((error) => {
    process.stderr.write(`E2E-03 real run: FAILED — ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

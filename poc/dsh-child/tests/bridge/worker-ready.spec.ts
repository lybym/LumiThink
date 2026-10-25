import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRealCordisAgentPort, type WorkerFaultInfo } from '../../src/real-agent-port.ts'

const workerScriptPath = fileURLToPath(new URL('./fake-bridge-worker.ts', import.meta.url))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('cold boot queues create and followup until ready and starts reply timeouts afterwards', async () => {
  const port = createRealCordisAgentPort({
    dshHome: 'fake-boot-home', mockBaseUrl: 'http://127.0.0.1:9', workerScriptPath,
    childBootTimeoutMs: 3_000, controlReplyTimeoutMs: 100,
    workerEnv: { LUMI_FAKE_WORKER_PLAN: JSON.stringify({ bootDelayMs: 350, followup: ['stream:start', 'stream:chunk', 'stream:end'] }) },
  })
  const faults: WorkerFaultInfo[] = []
  port.onFault(info => faults.push(info))
  try {
    const created = port.createAgent('ses_boot_ready')
    assert.ok(created.ok)
    if (!created.ok) return
    const frames: string[] = []
    created.handle.onStream(event => frames.push(event.kind))
    const result = created.handle.runPrompt({ turnId: 'trn_boot_ready', nonceFingerprint: 'boot-ready-test', promptText: 'synthetic' })
    assert.ok(result.ok)
    for (let i = 0; i < 100 && !frames.includes('end') && faults.length === 0; i++) await sleep(20)
    assert.deepEqual(faults, [])
    assert.deepEqual(frames, ['start', 'chunk', 'end'])
  } finally {
    await port.disposeAll()
  }
})

test('a worker that never becomes ready fails with boot_timeout and releases queued requests', async () => {
  const port = createRealCordisAgentPort({
    dshHome: 'fake-boot-timeout-home', mockBaseUrl: 'http://127.0.0.1:9', workerScriptPath,
    childBootTimeoutMs: 150, controlReplyTimeoutMs: 50,
    workerEnv: { LUMI_FAKE_WORKER_PLAN: JSON.stringify({ bootDelayMs: 5_000 }) },
  })
  const faults: WorkerFaultInfo[] = []
  port.onFault(info => faults.push(info))
  try {
    assert.ok(port.createAgent('ses_boot_timeout').ok)
    for (let i = 0; i < 100 && faults.length === 0; i++) await sleep(20)
    assert.equal(faults.length, 1)
    assert.equal(faults[0].detail, 'boot_timeout')
  } finally {
    await port.disposeAll()
  }
})

test('stop verification stays bounded while a worker is still booting', async () => {
  const port = createRealCordisAgentPort({
    dshHome: 'fake-boot-cancel-home', mockBaseUrl: 'http://127.0.0.1:9', workerScriptPath,
    childBootTimeoutMs: 3_000, whenIdleTimeoutMs: 80, disposeTimeoutMs: 80,
    workerEnv: { LUMI_FAKE_WORKER_PLAN: JSON.stringify({ bootDelayMs: 2_000 }) },
  })
  try {
    const created = port.createAgent('ses_boot_cancel')
    assert.ok(created.ok)
    if (!created.ok) return
    assert.ok(created.handle.runPrompt({ turnId: 'trn_boot_cancel', nonceFingerprint: 'boot-cancel-test', promptText: 'synthetic' }).ok)
    assert.ok(created.handle.cancel({ kind: 'user' }).ok)
    const started = Date.now()
    const idle = await created.handle.whenIdle()
    assert.ok(Date.now() - started < 800, 'stop verification must not wait for profile boot')
    assert.equal(idle.ok, true)
    if (idle.ok) assert.notEqual(idle.attemptId, null, 'a timed-out stop remains unverified')
  } finally {
    await port.disposeAll()
  }
})

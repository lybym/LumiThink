/**
 * Contract test: the pinned TypeScript SDK drives the isolated
 * `lumithink-child` runtime through synthetic multi-turn text, collects the
 * streamed event stream, and shuts the subprocess down deterministically.
 * Only the synthetic identifier `child_demo_001` is used — never real data.
 *
 * These tests spawn the runtime over stdio JSON-RPC (piped child stdio).
 * Environments that forbid piped child processes (e.g. the DeepSeek Harness
 * execution sandbox) skip them with an explicit reason; run the suite in a
 * normal shell or CI for the full PASS/FAIL evidence.
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MockMessagesServer } from '../../src/mock-model.ts'
import { disposeTempHome, startChildHarness } from '../../src/child-runtime.ts'
import { canSpawnPipedChild } from '../../src/dump-config.ts'
import type { StartedChild } from '../../src/child-runtime.ts'

const SYNTHETIC_SESSION = 'child_demo_001'
const PIPES_UNAVAILABLE = 'piped stdio child processes are unavailable in this execution environment; run the suite in a normal shell or CI for SDK e2e evidence'

const pipedOk = canSpawnPipedChild()

describe('R0-01 SDK contract over the lumithink-child profile', { skip: pipedOk ? false : PIPES_UNAVAILABLE }, () => {
  let mock: MockMessagesServer
  let started: StartedChild | undefined

  beforeEach(async () => {
    mock = new MockMessagesServer()
  })

  afterEach(async () => {
    await started?.harness.close().catch(() => undefined)
    if (started !== undefined && started.dshHome.includes('lumithink-child-home-')) {
      await disposeTempHome(started.dshHome)
    }
    started = undefined
    await mock.close()
  })

  it('completes synthetic multi-turn text with streamed events', async () => {
    started = await startChildHarness({ mock })

    const first = await started.harness.run('我今天很委屈，不想继续讲了。', { sessionId: SYNTHETIC_SESSION })
    assert.equal(first.sessionId, SYNTHETIC_SESSION)
    assert.ok(first.finalResponse.includes('MOCK-OK'), `unexpected final response: ${first.finalResponse}`)
    assert.ok(first.finalResponse.includes('messages=1'))
    assert.ok(first.events.length > 0)
    assert.ok(
      first.events.some(event => JSON.stringify(event).includes('"assistant"')),
      'the collected event stream must contain the committed assistant message',
    )

    const second = await started.harness.run('一道数学题不会，其他作业也不想写。', { sessionId: first.sessionId })
    assert.ok(second.finalResponse.includes('MOCK-OK'))
    // The second turn carries the accumulated history: user + assistant + user.
    assert.ok(second.finalResponse.includes('messages=3'))
    assert.ok(second.events.length > first.events.length)
  })

  it('refuses further runs after close() and leaves no running subprocess', async () => {
    started = await startChildHarness({ mock })
    await started.harness.run('你好', { sessionId: SYNTHETIC_SESSION })
    await started.harness.close()

    await assert.rejects(started.harness.run('再见'))
    // The closed client must not leave an orphan: closing again is idempotent.
    await started.harness.close()
  })

  it('routes every model request to the local synthetic mock only', async () => {
    started = await startChildHarness({ mock })
    await started.harness.run('第一条合成消息', { sessionId: SYNTHETIC_SESSION })
    await started.harness.run('第二条合成消息', { sessionId: SYNTHETIC_SESSION })

    const records = mock.requestRecords
    assert.ok(records.length >= 2, 'at least two model requests expected')
    for (const record of records) {
      assert.equal(record.method, 'POST')
      assert.ok(record.path.endsWith('/v1/messages'), `unexpected egress path: ${record.path}`)
      assert.ok(record.authorization.includes('dsh-poc-synthetic-key'))
      // The model never saw a tool schema: the profile mounts no tool providers.
      assert.deepEqual(record.advertisedTools, [])
    }
  })
})

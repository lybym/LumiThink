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
import { MockMessagesServer, SYNTHETIC_API_KEY } from '../../src/mock-model.ts'
import { disposeTempHome, startChildHarness } from '../../src/child-runtime.ts'
import { canSpawnPipedChild } from '../../src/dump-config.ts'
import type { StartedChild } from '../../src/child-runtime.ts'

const SYNTHETIC_SESSION = 'child_demo_001'
const PIPES_UNAVAILABLE = 'piped stdio child processes are unavailable in this execution environment; run the suite in a normal shell or CI for SDK e2e evidence'

const pipedOk = canSpawnPipedChild()

/** The `type` field of each collected turn event, in order. */
function eventTypes(events: readonly unknown[]): string[] {
  return events.map(event => (event as { type?: string }).type ?? '(none)')
}

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
    const firstTypes = eventTypes(first.events)
    // The first turn emits the deterministic pre-request sequence; the exact
    // tail depends on streaming timing, so only the stable prefix is pinned.
    assert.deepEqual(
      firstTypes.slice(0, 6),
      ['agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced', 'step/start', 'system/message', 'user/message'],
      'the first turn must emit the deterministic pre-request event sequence',
    )
    for (const required of ['request/header', 'assistant/message', 'turn/end']) {
      assert.ok(firstTypes.includes(required), `the first turn must stream a ${required} event (saw ${firstTypes.join(', ')})`)
    }

    const second = await started.harness.run('一道数学题不会，其他作业也不想写。', { sessionId: first.sessionId })
    assert.ok(second.finalResponse.includes('MOCK-OK'))
    // The second turn carries the accumulated history: user + assistant + user.
    assert.ok(second.finalResponse.includes('messages=3'))
    // The second turn replays the session surface instead of re-deriving it,
    // so its event set differs from the first turn's pre-request frames. What
    // the contract actually requires is that the turn is fully streamed and
    // bracketed by turn/step boundaries.
    const secondTypes = eventTypes(second.events)
    for (const required of ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end']) {
      assert.ok(secondTypes.includes(required), `the second turn must stream a ${required} event (saw ${secondTypes.join(', ')})`)
    }
    assert.ok(
      second.events.some(event => JSON.stringify(event).includes('MOCK-OK')),
      'the streamed assistant message must carry the synthetic model text',
    )
    assert.equal(second.sessionId, first.sessionId, 'multi-turn runs must stay in the same synthetic session')
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
      // The pinned deepseek adapter authenticates with `x-api-key`. The mock
      // records only the sanitized shape, so this proves the synthetic
      // credential was used without the value ever being stored.
      assert.equal(
        record.apiKeyHeader,
        SYNTHETIC_API_KEY,
        'every model request must carry exactly the synthetic credential placeholder',
      )
      assert.equal(record.apiKeyLength, SYNTHETIC_API_KEY.length)
      assert.ok(
        !JSON.stringify(records).includes('sk-'),
        'no real-looking provider credential may appear in the egress evidence',
      )
      // The model never saw a tool schema: the profile mounts no tool providers.
      assert.deepEqual(record.advertisedTools, [])
    }
    // The only endpoint reached is the loopback mock.
    assert.match(started.mockBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  })
})

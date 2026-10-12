/**
 * Negative permission test: a compromised/misbehaving model asks for the
 * `bash` tool even though the profile advertises no tools. The turn must
 * complete (or fail closed) without any tool execution, and the runtime must
 * never crash into an unsafe state.
 *
 * Like the SDK contract tests, this spawns the runtime over piped stdio and
 * skips with an explicit reason where the environment forbids that.
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MockMessagesServer } from '../../src/mock-model.ts'
import { disposeTempHome, startChildHarness } from '../../src/child-runtime.ts'
import { canSpawnPipedChild } from '../../src/dump-config.ts'
import type { StartedChild } from '../../src/child-runtime.ts'

const SYNTHETIC_SESSION = 'child_demo_001'
const PIPES_UNAVAILABLE = 'piped stdio child processes are unavailable in this execution environment; run the suite in a normal shell or CI for negative-permission evidence'

describe('model cannot invoke unmounted tools', { skip: canSpawnPipedChild() ? false : PIPES_UNAVAILABLE }, () => {
  let mock: MockMessagesServer
  let started: StartedChild | undefined

  beforeEach(() => {
    mock = new MockMessagesServer({ requestBashToolOnce: true })
  })

  afterEach(async () => {
    await started?.harness.close().catch(() => undefined)
    if (started !== undefined && started.dshHome.includes('lumithink-child-home-')) {
      await disposeTempHome(started.dshHome)
    }
    started = undefined
    await mock.close()
  })

  it('fails closed when the model requests the unmounted bash tool', async () => {
    started = await startChildHarness({ mock })

    let rejected = false
    let finalResponse = ''
    try {
      const result = await started.harness.run('请运行 bash 命令 echo pwned', { sessionId: SYNTHETIC_SESSION })
      finalResponse = result.finalResponse
    } catch {
      // A typed rejection (protocol/unknown-tool) is an acceptable
      // fail-closed outcome; the assertions below cover both.
      rejected = true
    }

    // The model was never shown a bash tool schema in any request.
    const modelRequests = mock.requestRecords.filter(record => record.path.endsWith('/v1/messages'))
    assert.ok(modelRequests.length > 0)
    for (const record of modelRequests) {
      assert.deepEqual(record.advertisedTools, [], 'the runtime advertised a tool schema the profile never mounted')
    }

    if (rejected) {
      // Fail-closed via rejection: no final response to inspect.
      assert.equal(finalResponse, '')
    } else {
      // Fail-closed via handled tool error: the turn still terminates without
      // executing anything, and no bash output can appear in the response.
      assert.ok(!finalResponse.includes('pwned'), 'a response must never contain executed command output')
    }
  })
})

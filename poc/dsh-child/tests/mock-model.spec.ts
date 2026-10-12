/**
 * In-process contract test for the synthetic Messages mock: the exact wire
 * frames the mock emits must match what the official DeepSeek Messages
 * adapter parses (SSE `event:` field == JSON `type`, Anthropic Messages
 * content block shapes), and every request must be recorded in sanitized
 * form. This test needs no subprocess, so it runs everywhere.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MockMessagesServer } from '../src/mock-model.ts'

interface SseFrame {
  event: string
  data: Record<string, unknown>
}

function parseSse(raw: string): SseFrame[] {
  const frames: SseFrame[] = []
  for (const block of raw.split('\n\n')) {
    let event = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length)
      if (line.startsWith('data: ')) data += line.slice('data: '.length)
    }
    if (event !== '' || data !== '') frames.push({ event, data: JSON.parse(data) as Record<string, unknown> })
  }
  return frames
}

describe('synthetic Messages mock wire contract', () => {
  let server: MockMessagesServer | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('streams Anthropic-Messages-shaped SSE frames over /v1/messages', async () => {
    server = new MockMessagesServer()
    const base = await server.listen()
    try {
      const response = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer dsh-poc-synthetic-key', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          stream: true,
          max_tokens: 1024,
          system: '你是 LumiThink 合成测试环境中的助手',
          messages: [{ role: 'user', content: '我今天很委屈，不想继续讲了。' }],
        }),
      })
      assert.equal(response.status, 200)
      const frames = parseSse(await response.text())
      const types = frames.map(frame => frame.event)
      assert.deepEqual(types, [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ])
      // Every SSE `event:` must equal the JSON payload `type` — the official
      // adapter rejects mismatched frames as MALFORMED_RESPONSE.
      for (const frame of frames) {
        assert.equal(frame.data.type, frame.event)
      }
      const start = frames[0]!.data.message as Record<string, unknown>
      assert.equal(start.role, 'assistant')
      assert.equal(start.type, 'message')
      const delta0 = frames[2]!.data.delta as Record<string, unknown>
      assert.equal(delta0.type, 'text_delta')
      const stop = frames.find(frame => frame.event === 'message_delta')!.data.delta as Record<string, unknown>
      assert.equal(stop.stop_reason, 'end_turn')
    } finally {
      await server.close()
      server = undefined
    }
  })

  it('answers non-streaming requests with a complete message object', async () => {
    server = new MockMessagesServer()
    const base = await server.listen()
    try {
      const response = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '你好' }] }),
      })
      assert.equal(response.status, 200)
      const body = (await response.json()) as Record<string, unknown>
      assert.equal(body.type, 'message')
      assert.equal(body.role, 'assistant')
      assert.equal(body.stop_reason, 'end_turn')
      const content = body.content as Array<Record<string, unknown>>
      assert.equal(content[0]!.type, 'text')
      assert.ok(String(content[0]!.text).includes('MOCK-OK'))
    } finally {
      await server.close()
      server = undefined
    }
  })

  it('records every request sanitized and rejects unmocked paths', async () => {
    server = new MockMessagesServer()
    const base = await server.listen()
    try {
      await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer super-secret-real-key' },
        body: JSON.stringify({ model: 'deepseek-v4-flash', stream: false, tools: [{ name: 'bash' }], messages: [{ role: 'user', content: 'x' }] }),
      })
      const rejected = await fetch(`${base}/other/path`, { method: 'POST', body: '{}' })
      assert.equal(rejected.status, 404)

      const records = server.requestRecords
      assert.equal(records.length, 2)
      assert.equal(records[0]!.path, '/v1/messages')
      assert.equal(records[0]!.method, 'POST')
      // The real credential value never lands in the evidence record.
      assert.equal(records[0]!.authorization, 'present (dsh-poc-synthetic-key)')
      assert.ok(!JSON.stringify(records).includes('super-secret-real-key'))
      // The tool schema the (compromised) request advertised is preserved for
      // the negative-permission evidence.
      assert.deepEqual(records[0]!.advertisedTools, ['bash'])
      assert.equal(records[1]!.path, '/other/path')
    } finally {
      await server.close()
      server = undefined
    }
  })
})

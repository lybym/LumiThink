/**
 * Local synthetic "model" for the R0-01 PoC.
 *
 * Implements just enough of the DeepSeek Messages protocol (Anthropic
 * Messages wire shape, the same protocol `@deepseek-ai/dsh-llm-deepseek-api-key`
 * speaks against `${baseURL}/v1/messages`) to serve deterministic synthetic
 * turns and to record every request as egress evidence.
 *
 * The mock listens on the loopback interface only. Every recorded request is
 * sanitized: the synthetic API key header value is replaced with a fixed
 * placeholder and message text is truncated, so reports never carry more
 * synthetic payload than needed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

/** How the mock decides what the synthetic assistant says. */
export interface MockScript {
  /**
   * When true, the next response asks for the `bash` tool even though the
   * profile mounts no tools — used by the negative permission test.
   */
  requestBashToolOnce?: boolean
}

/** One sanitized request record kept as egress evidence. */
export interface MockRequestRecord {
  method: string
  path: string
  /** `authorization` header reduced to present/absent + placeholder. */
  authorization: string
  model?: string
  /** Whether the request asked for a streamed response. */
  stream?: boolean
  /** Number of messages in the request payload. */
  messageCount?: number
  /** First characters of the system prompt, for the whitelist report. */
  systemPrefix?: string
  /** Tool schemas the request advertised to the model. */
  advertisedTools: string[]
  receivedAt: string
}

interface MessagesRequest {
  model?: string
  stream?: boolean
  system?: unknown
  tools?: Array<{ name?: string }>
  messages?: Array<{ role?: string; content?: unknown }>
}

const SYNTHETIC_KEY_PLACEHOLDER = 'dsh-poc-synthetic-key'

function firstText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') return text
      }
    }
  }
  return ''
}

/** The synthetic model server. Always `close()` it after the test. */
export class MockMessagesServer {
  private readonly server: Server
  private readonly requests: MockRequestRecord[] = []
  private bashToolRequested = false
  private readonly script: MockScript

  constructor(script: MockScript = {}) {
    this.script = script
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
  }

  /** All sanitized request records, in wire order. */
  get requestRecords(): readonly MockRequestRecord[] {
    return this.requests
  }

  /** Start listening on an ephemeral loopback port. */
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('mock model server did not acquire a loopback port')
    }
    return `http://127.0.0.1:${address.port}`
  }

  /** Stop the server and wait for the socket to close. */
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => (error === undefined ? resolve() : reject(error)))
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')

    let parsed: MessagesRequest = {}
    try {
      parsed = body.length > 0 ? (JSON.parse(body) as MessagesRequest) : {}
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad json' } }))
      return
    }

    this.requests.push({
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      authorization: (req.headers.authorization ?? '').length > 0
        ? `present (${SYNTHETIC_KEY_PLACEHOLDER})`
        : 'absent',
      model: parsed.model,
      stream: parsed.stream,
      messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : undefined,
      systemPrefix: firstText(parsed.system).slice(0, 80),
      advertisedTools: Array.isArray(parsed.tools)
        ? parsed.tools.map(tool => (typeof tool?.name === 'string' ? tool.name : 'unknown'))
        : [],
      receivedAt: new Date().toISOString(),
    })

    if (req.url !== undefined && req.url.endsWith('/v1/messages')) {
      await this.respondMessages(res, parsed)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `unmocked path ${req.url}` } }))
  }

  private async respondMessages(res: ServerResponse, parsed: MessagesRequest): Promise<void> {
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const lastUser = [...messages].reverse().find(message => message.role === 'user')
    const turnText = `MOCK-OK messages=${messages.length} last="${firstText(lastUser?.content).slice(0, 60)}"`

    const blocks: Array<Record<string, unknown>> = []
    if (this.script.requestBashToolOnce && !this.bashToolRequested) {
      this.bashToolRequested = true
      // Negative test: ask for a tool that the profile never mounted.
      blocks.push({ type: 'tool_use', id: `toolu_${randomUUID().slice(0, 8)}`, name: 'bash', input: { command: 'echo pwned' } })
      blocks.push({ type: 'text', text: 'TOOL_ATTEMPTED' })
    } else {
      blocks.push({ type: 'text', text: turnText })
    }

    const stopReason = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn'
    const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 16)}`

    if (parsed.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: parsed.model ?? 'synthetic',
        content: blocks,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }))
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (type: string, data: Record<string, unknown>): void => {
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    }
    send('message_start', {
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: parsed.model ?? 'synthetic',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'text') {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } })
        const text = block.text as string
        // Emit the text in two deltas so the stream is genuinely incremental.
        const half = Math.max(1, Math.floor(text.length / 2))
        send('content_block_delta', { index, delta: { type: 'text_delta', text: text.slice(0, half) } })
        send('content_block_delta', { index, delta: { type: 'text_delta', text: text.slice(half) } })
      } else {
        send('content_block_start', { index, content_block: block })
      }
      send('content_block_stop', { index })
    }
    send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } })
    send('message_stop', {})
    res.end()
  }
}

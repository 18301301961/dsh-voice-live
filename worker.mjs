/**
 * Recognition worker: one loopback HTTP endpoint in front of the streaming engine.
 *
 * The Host starts this file as a child process in Node mode, reads the printed
 * `port:<n>` line, and authenticates every request with the argv-supplied token.
 */
import { createServer } from 'node:http'
import { createEngine, SAMPLE_RATE } from './engine.mjs'

/* The Host captures this process's stderr and reports the last lines as diagnostics. */
const fatal = (error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`)
}
process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)

const settings = JSON.parse(process.argv[2] ?? '{}')
const token = settings.token ?? ''

const state = { partial: '', committed: '', error: undefined }
let engine
let lastRequestAt = Date.now()

try {
  engine = createEngine({
    ...settings,
    onPartial(text) {
      state.partial = text
    },
    onCommit(text, committed) {
      state.committed = committed
      state.partial = ''
    },
  })
} catch (error) {
  process.stderr.write(`engine failed: ${error && error.stack ? error.stack : error}\n`)
  process.stdout.write(`error:${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

function reply(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/*
 * Audio is acknowledged before it is decoded: the response reports the latest
 * text, and the queue drains on a later tick so a decode never delays a request.
 */
const queue = []
let draining = false

function schedule() {
  if (draining) return
  draining = true
  setImmediate(() => {
    try {
      while (queue.length > 0) {
        const buffer = queue.shift()
        engine.acceptInt16(buffer)
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    } finally {
      draining = false
    }
  })
}

const server = createServer(async (req, res) => {
  lastRequestAt = Date.now()
  if (req.headers.authorization !== `Bearer ${token}`) {
    reply(res, 401, { error: 'unauthorized' })
    return
  }
  const route = (req.url ?? '/').split('?')[0]
  try {
    if (route === '/audio' && req.method === 'POST') {
      const body = await readBody(req)
      if (body.length > 0) {
        queue.push(body)
        schedule()
      }
      reply(res, 200, { partial: state.partial, committed: state.committed, rev: Date.now(), error: state.error ?? null })
      return
    }
    if (route === '/finish' && req.method === 'POST') {
      while (queue.length > 0) engine.acceptInt16(queue.shift())
      const result = engine.finish()
      reply(res, 200, { text: result.text, stats: result.stats })
      return
    }
    if (route === '/reset' && req.method === 'POST') {
      queue.length = 0
      engine.reset()
      state.partial = ''
      state.committed = ''
      state.error = undefined
      reply(res, 200, { ok: true })
      return
    }
    if (route === '/health' && req.method === 'GET') {
      reply(res, 200, { ok: true, sampleRate: SAMPLE_RATE, stats: engine.stats() })
      return
    }
    reply(res, 404, { error: 'not found' })
  } catch (error) {
    reply(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  process.stdout.write(`port:${port}\n`)
})

/* Never outlive the Session that uses this worker. */
setInterval(() => {
  if (Date.now() - lastRequestAt > 10 * 60_000) process.exit(0)
}, 60_000).unref()

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

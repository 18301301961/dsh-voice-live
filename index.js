/**
 * Voice live: streaming dictation for the Web GUI.
 *
 * The Host owns a child process that runs SenseVoice behind Silero VAD and
 * exposes it over a loopback HTTP port. This plugin turns that worker into
 * same-origin routes the composer streams microphone audio to.
 */
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { polishTranscript } from './polish.mjs'

const ROUTE = '/voice-live'
const SAMPLE_RATE = 16000
const START_TIMEOUT_MS = 90_000
const WORKER_TIMEOUT_MS = 30_000

const defaults = {
  dataRoot: undefined,
  model: undefined,
  tokens: undefined,
  vadModel: undefined,
  language: 'zh',
  threads: 4,
  partialIntervalMs: 480,
  partialWindowSeconds: 6,
  vadThreshold: 0.5,
  minSilenceSeconds: 0.35,
  minSpeechSeconds: 0.25,
  maxSpeechSeconds: 12,
  maxAudioBytes: 32 * 1024 * 1024,
  idleTimeoutMs: 5 * 60_000,
  polish: 'final',
  polishMaxLatencyMs: 8000,
  polishInstructions: undefined,
  vocabulary: [],
}

function homeDir() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/** Resolve the SenseVoice model, tokens and VAD files this engine decodes. */
function resolvePaths(config) {
  const dataRoot = config.dataRoot ?? path.join(homeDir(), 'speech-to-text', 'sensevoice')
  const modelDir = path.join(dataRoot, 'models', 'sensevoice-onnx')
  const candidates = [config.model, path.join(modelDir, 'model.int8.onnx'), path.join(modelDir, 'model.onnx')]
  const model = candidates.find((candidate) => typeof candidate === 'string' && existsSync(candidate))
  return {
    dataRoot,
    model,
    tokens: config.tokens ?? path.join(modelDir, 'tokens.txt'),
    vad: config.vadModel ?? path.join(dataRoot, 'models', 'silero', 'silero_vad.onnx'),
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('音频超过长度限制'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Talk to the warm worker over loopback HTTP without the global fetch stack. */
function requestWorker(port, route, init = {}) {
  return new Promise((resolve, reject) => {
    const payload = init.body === undefined ? undefined : Buffer.from(init.body)
    const headers = {
      authorization: init.authorization ?? '',
      ...(init.headers ?? {}),
      ...(payload === undefined ? {} : { 'content-length': payload.length }),
    }
    const request = httpRequest(
      { host: '127.0.0.1', port, path: route, method: init.method ?? 'GET', headers },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error(`语音引擎返回了无法解析的响应（${response.statusCode}）`))
          }
        })
        response.on('error', reject)
      },
    )
    request.on('error', reject)
    request.setTimeout(WORKER_TIMEOUT_MS, () => {
      request.destroy(new Error('语音引擎响应超时'))
    })
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

/** One warm worker: a child process with the recognition engine and its own loopback port. */
class WorkerRuntime {
  constructor(resolve, config) {
    this.resolve = resolve
    this.config = config
    this.child = undefined
    this.port = undefined
    this.token = undefined
    this.ready = undefined
    this.stderr = ''
    this.failure = undefined
  }

  /** Start the child once and wait until the engine reports its port. */
  ensure() {
    if (this.ready !== undefined) return this.ready
    const paths = this.resolve(this.config)
    if (paths.model === undefined) {
      return Promise.reject(new Error(`未找到 SenseVoice 模型：${path.join(paths.dataRoot, 'models', 'sensevoice-onnx')}`))
    }
    this.token = randomBytes(24).toString('hex')
    this.ready = new Promise((resolve, reject) => {
      const workerPath = path.join(import.meta.dirname, 'worker.mjs')
      const settings = {
        model: paths.model,
        tokens: paths.tokens,
        vad: paths.vad,
        language: this.config.language,
        threads: this.config.threads,
        partialIntervalMs: this.config.partialIntervalMs,
        partialWindowSeconds: this.config.partialWindowSeconds,
        vadThreshold: this.config.vadThreshold,
        minSilenceSeconds: this.config.minSilenceSeconds,
        minSpeechSeconds: this.config.minSpeechSeconds,
        maxSpeechSeconds: this.config.maxSpeechSeconds,
        token: this.token,
      }
      let child
      try {
        child = spawn(process.execPath, [workerPath, JSON.stringify(settings)], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        reject(error)
        return
      }
      this.child = child
      const timer = setTimeout(() => {
        reject(new Error('语音引擎启动超时'))
      }, START_TIMEOUT_MS)
      const settle = (fn, value) => {
        clearTimeout(timer)
        fn(value)
      }
      let buffered = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffered += chunk
        for (;;) {
          const index = buffered.indexOf('\n')
          if (index < 0) break
          const line = buffered.slice(0, index).trim()
          buffered = buffered.slice(index + 1)
          if (line.startsWith('port:')) {
            this.port = Number(line.slice(5))
            settle(resolve, this.port)
          } else if (line.startsWith('error:')) {
            settle(reject, new Error(line.slice(6)))
          }
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        this.stderr = (this.stderr + chunk).slice(-4000)
      })
      child.on('error', (error) => settle(reject, error))
      child.on('exit', (code, signal) => {
        this.child = undefined
        this.port = undefined
        this.ready = undefined
        if (code !== 0 && code !== null) {
          const detail = this.stderr.slice(-400).trim()
          settle(reject, new Error(`语音引擎退出（${code ?? signal}）${detail === '' ? '' : `：${detail}`}`))
        }
      })
    })
    this.ready.catch((error) => {
      this.ready = undefined
      this.failure = error instanceof Error ? error.message : String(error)
    })
    return this.ready
  }

  async call(route, init = {}) {
    const port = await this.ensure()
    return await requestWorker(port, route, { ...init, authorization: `Bearer ${this.token}` })
  }

  dispose() {
    if (this.child !== undefined) {
      try {
        this.child.kill()
      } catch {}
    }
    this.child = undefined
    this.port = undefined
    this.ready = undefined
  }
}

export const inject = ['webServer']

export function apply(ctx, config) {
  const settings = { ...defaults, ...(config ?? {}) }
  const runtime = new WorkerRuntime(resolvePaths, settings)
  const sessions = new Map()
  let activeId = null
  let idleTimer = undefined

  const touch = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (sessions.size === 0) runtime.dispose()
    }, settings.idleTimeoutMs)
    idleTimer.unref?.()
  }

  const session = (id) => sessions.get(id)

  /**
   * Report model availability and, when it is missing, ask the recognition
   * service that owns the download to prepare it.
   */
  const modelState = () => {
    const paths = resolvePaths(settings)
    if (paths.model !== undefined) return { ready: true, phase: 'ready', paths }
    const speech = ctx.get('speechToText')
    if (speech === undefined) return { ready: false, phase: 'unavailable', paths }
    let provider
    try {
      provider = speech.snapshot().providers.find((entry) => entry.id === 'sensevoice-local')
    } catch {
      provider = undefined
    }
    const preparation = provider?.preparation
    const phase = preparation?.phase ?? 'unknown'
    if (phase === 'unprepared' || phase === 'cancelled') {
      try {
        speech.prepare('sensevoice-local')
      } catch {
        /* A concurrent preparation keeps the original task. */
      }
    }
    return { ready: false, phase, preparation, paths }
  }

  async function forwardAudio(target, chunk) {
    const result = await runtime.call('/audio', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: chunk,
    })
    if (result.error !== undefined && result.error !== null) target.error = String(result.error)
    if (typeof result.partial === 'string') target.partial = result.partial
    if (typeof result.committed === 'string') target.committed = result.committed
    target.rev += 1
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(ROUTE.length) || '/'
    const origin = req.headers.origin
    if (origin !== undefined && origin !== '' && req.headers.host !== undefined) {
      const expected = `http://${req.headers.host}`
      if (origin !== expected && origin !== `https://${req.headers.host}`) {
        json(res, 403, { error: '来源被拒绝' })
        return
      }
    }
    if (req.headers['x-voice-live'] !== '1') {
      json(res, 403, { error: '缺少语音输入请求标记' })
      return
    }
    try {
      if (route === '/status' && req.method === 'GET') {
        const state = modelState()
        const ready = runtime.port !== undefined
        json(res, 200, {
          phase: state.ready ? (ready ? 'ready' : 'standby') : state.phase === 'preparing' || state.phase === 'checking' || state.phase === 'loading' || state.phase === 'downloading' ? 'preparing' : state.phase === 'unprepared' ? 'unprepared' : 'unavailable',
          model: state.paths.model ?? null,
          dataRoot: state.paths.dataRoot,
          preparation: state.preparation ?? null,
          language: settings.language,
          sampleRate: SAMPLE_RATE,
          active: activeId !== null,
          warming: runtime.ready !== undefined && runtime.port === undefined,
          failure: runtime.failure ?? null,
          polish: settings.polish,
          polishAvailable: ctx.get('llm') !== undefined,
        })
        return
      }
      if (route === '/warm' && req.method === 'POST') {
        if (resolvePaths(settings).model !== undefined) {
          touch()
          runtime.ensure().catch(() => {})
        }
        json(res, 200, { warming: runtime.port === undefined, failure: runtime.failure ?? null })
        return
      }
      if (route === '/start' && req.method === 'POST') {
        const id = randomUUID()
        sessions.clear()
        sessions.set(id, { committed: '', partial: '', rev: 0, buffered: [], error: null })
        activeId = id
        touch()
        if (resolvePaths(settings).model === undefined) {
          const state = modelState()
          json(res, 409, {
            error: state.phase === 'unprepared' || state.phase === 'unavailable' ? '未找到本地识别模型' : '识别模型正在准备中',
            phase: state.phase,
            preparation: state.preparation ?? null,
          })
          return
        }
        /* Warm the engine in the background so the first words are not lost. */
        runtime.ensure().catch(() => {})
        if (runtime.port !== undefined) await runtime.call('/reset', { method: 'POST' }).catch(() => {})
        json(res, 200, { id, sampleRate: SAMPLE_RATE, warming: runtime.port === undefined })
        return
      }
      if (route === '/audio' && req.method === 'POST') {
        const target = session(url.searchParams.get('id') ?? '')
        if (target === undefined) {
          json(res, 409, { error: '会话已结束' })
          return
        }
        const body = await readBody(req, settings.maxAudioBytes)
        touch()
        if (body.length > 0) {
          if (runtime.port === undefined) {
            /* The engine may still be warming: keep audio queued and retry the start. */
            runtime.ensure().catch(() => {})
            target.buffered.push(body)
            const bufferedBytes = target.buffered.reduce((total, chunk) => total + chunk.length, 0)
            if (bufferedBytes > settings.maxAudioBytes) target.buffered = target.buffered.slice(-8)
            json(res, 200, { rev: target.rev, committed: target.committed, partial: target.partial, warming: true })
            return
          }
          if (target.buffered.length > 0) {
            const queued = target.buffered
            target.buffered = []
            for (const chunk of queued) await forwardAudio(target, chunk)
          }
          await forwardAudio(target, body)
        }
        json(res, 200, {
          rev: target.rev,
          committed: target.committed,
          partial: target.partial,
          warming: false,
          error: target.error ?? null,
        })
        return
      }
      if (route === '/finish' && req.method === 'POST') {
        const id = url.searchParams.get('id') ?? ''
        const target = session(id)
        if (target === undefined) {
          json(res, 409, { error: '会话已结束' })
          return
        }
        sessions.delete(id)
        if (activeId === id) activeId = null
        if (runtime.port === undefined) {
          /* A short dictation may end before the engine is ready: join it, then flush. */
          try {
            await runtime.ensure()
          } catch {
            json(res, 200, { text: target.committed, stats: null })
            return
          }
        }
        for (const chunk of target.buffered) await forwardAudio(target, chunk)
        target.buffered = []
        const result = await runtime.call('/finish', { method: 'POST' })
        const raw = typeof result.text === 'string' ? result.text : target.committed
        let text = raw
        let polish = settings.polish === 'final' ? { status: 'skipped', reason: 'empty' } : { status: 'skipped', reason: 'disabled' }
        if (settings.polish === 'final' && raw.trim() !== '') {
          polish = await polishTranscript({
            ctx,
            text: raw,
            language: settings.language,
            vocabulary: Array.isArray(settings.vocabulary) ? settings.vocabulary : [],
            instructions: settings.polishInstructions,
            sessionId: url.searchParams.get('session') ?? undefined,
            maxLatencyMs: settings.polishMaxLatencyMs,
          })
          if (typeof polish.text === 'string') text = polish.text
        }
        json(res, 200, {
          text,
          raw,
          polished: polish.status === 'applied',
          polish: { status: polish.status, reason: polish.reason ?? null, model: polish.model ?? null },
          stats: result.stats ?? null,
        })
        touch()
        return
      }
      if (route === '/abort' && req.method === 'POST') {
        const id = url.searchParams.get('id') ?? ''
        sessions.delete(id)
        if (activeId === id) activeId = null
        if (runtime.port !== undefined) await runtime.call('/reset', { method: 'POST' }).catch(() => {})
        touch()
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { error: '未知的语音接口' })
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler })
  ctx.effect(() => () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    for (const id of [...sessions.keys()]) sessions.delete(id)
    activeId = null
    disposeRoute()
    runtime.dispose()
  })
}

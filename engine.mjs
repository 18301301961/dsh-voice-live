/**
 * Streaming recognition engine: Silero VAD segmentation plus SenseVoice decoding.
 *
 * The engine keeps every decoded utterance and returns incremental text so a
 * caller can show words while the speaker is still talking.
 */
import { createRequire } from 'node:module'
import path from 'node:path'

export const SAMPLE_RATE = 16000
const WINDOW = 512

/**
 * Resolve sherpa-onnx from the running installation: the Desktop build keeps its
 * copy inside app.asar, a CLI installation resolves it from node_modules.
 */
export function loadSherpa() {
  const failures = []
  const roots = []
  if (process.env.DSH_VOICE_LIVE_SHERPA) roots.push(process.env.DSH_VOICE_LIVE_SHERPA)
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'app.asar', 'dsh'))
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'dsh'))
  for (const root of roots) {
    try {
      const req = createRequire(path.join(root, 'voice-live-resolver.cjs'))
      return req('sherpa-onnx-node')
    } catch (error) {
      failures.push(`${root}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    const req = createRequire(import.meta.url)
    return req('sherpa-onnx-node')
  } catch (error) {
    failures.push(`package: ${error instanceof Error ? error.message : String(error)}`)
  }
  throw new Error(`本地识别引擎不可用（${failures.join(' | ')}）`)
}

function concat(target, extra) {
  if (extra.length === 0) return target
  const merged = new Float32Array(target.length + extra.length)
  merged.set(target, 0)
  merged.set(extra, target.length)
  return merged
}

/**
 * @param {object} settings
 * @param {string} settings.model           SenseVoice ONNX file
 * @param {string} settings.tokens          tokens file
 * @param {string} settings.vad             Silero VAD ONNX file
 * @param {string} [settings.language]      auto | zh | en | yue | ja | ko
 * @param {number} [settings.threads]
 * @param {number} [settings.partialIntervalMs]
 * @param {number} [settings.partialWindowSeconds]
 * @param {number} [settings.vadThreshold]
 * @param {number} [settings.minSilenceSeconds]
 * @param {number} [settings.minSpeechSeconds]
 * @param {number} [settings.maxSpeechSeconds]
 * @param {(text: string) => void} [settings.onPartial]
 * @param {(text: string, committed: string) => void} [settings.onCommit]
 */
export function createEngine(settings) {
  const options = {
    language: 'auto',
    threads: 4,
    partialIntervalMs: 480,
    partialWindowSeconds: 6,
    vadThreshold: 0.5,
    minSilenceSeconds: 0.35,
    minSpeechSeconds: 0.25,
    maxSpeechSeconds: 12,
    onPartial() {},
    onCommit() {},
    ...settings,
  }

  const sherpa = loadSherpa()
  const loadedAt = Date.now()
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: options.model,
        language: options.language,
        useInverseTextNormalization: 1,
      },
      tokens: options.tokens,
      numThreads: options.threads,
      provider: 'cpu',
      debug: 0,
    },
  })
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: options.vad,
        threshold: options.vadThreshold,
        minSilenceDuration: options.minSilenceSeconds,
        minSpeechDuration: options.minSpeechSeconds,
        maxSpeechDuration: options.maxSpeechSeconds,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    30,
  )

  let pending = new Float32Array(0)
  let speech = new Float32Array(0)
  let committed = ''
  let lastPartialAt = 0
  let interval = 0
  let closed = false
  const stats = { decodes: 0, decodeMs: 0, loadMs: Date.now() - loadedAt }

  function decode(samples) {
    const stream = recognizer.createStream()
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
    const started = Date.now()
    recognizer.decode(stream)
    const text = recognizer.getResult(stream).text.trim()
    const ms = Date.now() - started
    stats.decodes += 1
    stats.decodeMs += ms
    return { text, ms }
  }

  function emitPartial() {
    if (speech.length < SAMPLE_RATE * options.minSpeechSeconds) return
    const window = Math.min(speech.length, Math.floor(options.partialWindowSeconds * SAMPLE_RATE))
    const result = decode(speech.subarray(speech.length - window))
    lastPartialAt = Date.now()
    /* Partial decoding must stay far cheaper than speaking: follow the measured cost. */
    interval = Math.min(2400, Math.max(options.partialIntervalMs, Math.round(result.ms * 2.2)))
    if (result.text !== '') options.onPartial(result.text)
  }

  function commitSegment(samples) {
    if (samples.length < SAMPLE_RATE * 0.12) return
    const result = decode(samples)
    speech = new Float32Array(0)
    options.onPartial('')
    if (result.text !== '') {
      committed = committed === '' ? result.text : `${committed}${result.text}`
      options.onCommit(result.text, committed)
    }
  }

  function drain() {
    while (!vad.isEmpty()) {
      const segment = vad.front(false)
      const copy = new Float32Array(segment.samples.length)
      copy.set(segment.samples)
      vad.pop()
      commitSegment(copy)
    }
  }

  function accept(samples) {
    if (closed) return
    const cap = Math.floor(SAMPLE_RATE * (options.partialWindowSeconds + 6))
    pending = concat(pending, samples)
    while (pending.length >= WINDOW) {
      const window = pending.subarray(0, WINDOW)
      pending = pending.subarray(WINDOW)
      vad.acceptWaveform(window)
      speech = concat(speech, window)
      drain()
    }
    if (speech.length > cap) speech = concat(new Float32Array(0), speech.subarray(speech.length - cap))
    if (vad.isDetected() && Date.now() - lastPartialAt >= interval) emitPartial()
  }

  /** Convert one int16 little-endian buffer into samples and feed it. */
  function acceptInt16(buffer) {
    const samples = new Float32Array(buffer.length >> 1)
    for (let index = 0; index < samples.length; index++) samples[index] = buffer.readInt16LE(index * 2) / 32768
    accept(samples)
  }

  function finish() {
    if (closed) return { text: committed, stats }
    closed = true
    const rest = pending.length === 0
      ? pending
      : (() => {
          const padded = new Float32Array(Math.ceil(pending.length / WINDOW) * WINDOW)
          padded.set(pending, 0)
          return padded
        })()
    pending = new Float32Array(0)
    for (let start = 0; start < rest.length; start += WINDOW) {
      const window = rest.subarray(start, start + WINDOW)
      vad.acceptWaveform(window)
      speech = concat(speech, window)
      drain()
    }
    vad.flush()
    drain()
    if (speech.length >= SAMPLE_RATE * 0.15) commitSegment(speech)
    speech = new Float32Array(0)
    options.onPartial('')
    return { text: committed, stats }
  }

  /** Clear the utterance state so the warm engine can serve the next dictation. */
  function reset() {
    closed = false
    pending = new Float32Array(0)
    speech = new Float32Array(0)
    committed = ''
    lastPartialAt = 0
    interval = 0
    vad.reset()
  }

  return {
    accept,
    acceptInt16,
    finish,
    reset,
    stats: () => ({ ...stats, committed }),
    get committed() {
      return committed
    },
  }
}

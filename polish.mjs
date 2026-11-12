/**
 * Transcript polishing: a cheap, bounded second pass that repairs the mistakes a
 * streaming recognizer makes most often — homophones, English spellings, digits
 * and punctuation — without rewriting what the speaker said.
 */

const SYSTEM = [
  '你是听写校对器。输入是一段语音识别转写文本，可能含同音字、错别字、术语、数字或标点错误。',
  '只做最小必要修改：',
  '1) 修正明显的同音字或错别字，例如把“查件”改成“插件”；',
  '2) 修正专有名词、产品名与英文单词的拼写，例如把“拼森”改成“Python”；',
  '3) 修正数字写法，以及缺失或明显错误的标点。',
  '严禁改写措辞：正确但表达不同的词保持原样，不替换同义词，不增删内容，不合并或拆分句子，不改变语气。',
  '无法确定时保持原文。不要解释，不要加引号或任何前后缀，只输出校对后的正文。',
].join('')

const MAX_INPUT_CHARS = 1500

function sanitize(text) {
  let value = text.trim()
  if (value.startsWith('```')) {
    value = value.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim()
  }
  if (value.length > 1) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === '“' && last === '”') || (first === "'" && last === "'")) {
      value = value.slice(1, -1).trim()
    }
  }
  return value
}

/**
 * Keeps a plausible correction and rejects a rewrite: the text must stay close
 * in length and still share most of its characters with the raw transcript.
 */
function plausible(raw, polished) {
  if (polished === '') return false
  const ratio = polished.length / Math.max(1, raw.length)
  if (ratio < 0.6 || ratio > 1.5) return false
  const counts = new Map()
  for (const char of raw) counts.set(char, (counts.get(char) ?? 0) + 1)
  let shared = 0
  for (const char of polished) {
    const left = counts.get(char) ?? 0
    if (left > 0) {
      counts.set(char, left - 1)
      shared += 1
    }
  }
  return shared / Math.max(1, raw.length) >= 0.55
}

function buildPrompt({ text, language, vocabulary }) {
  const lines = [`语言提示：${language}。`]
  if (vocabulary.length > 0) lines.push(`参考词表（出现时按此写法）：${vocabulary.join('、')}。`)
  lines.push(
    '示例：',
    '输入：这个查件里的语音输如我看过了',
    '输出：这个插件里的语音输入我看过了',
    '输入：这个方案是我创造的吗',
    '输出：这个方案是我创造的吗',
    '',
    '听写文本：',
    '<<<',
    text,
    '>>>',
  )
  return lines.join('\n')
}

/**
 * Ask the configured model for one bounded correction.
 * @returns `{ status, text, model? }`: `applied` or `unchanged` when the model
 *          answered, otherwise a diagnostic `status` and `reason` so callers keep
 *          the raw transcript and can explain why nothing was corrected.
 */
export async function polishTranscript(options) {
  const { ctx, text, language = 'zh', vocabulary = [], sessionId, maxLatencyMs = 8000, instructions } = options
  if (text.trim() === '') return { status: 'skipped', reason: 'empty' }
  if (text.length > MAX_INPUT_CHARS) return { status: 'skipped', reason: 'too-long' }
  const llm = ctx.get('llm')
  if (llm === undefined) return { status: 'skipped', reason: 'no-llm' }

  const target = resolveModel(ctx, sessionId)
  if (target === undefined) return { status: 'skipped', reason: 'no-model' }

  /* Correction needs no deliberation: pick the cheapest reasoning effort the model accepts. */
  let reasoningEffort
  try {
    const info = await llm.resolveModelInfo(target.provider, target.model)
    const efforts = info?.reasoning?.efforts ?? []
    const cheapest = ['off', 'none', 'minimal', 'low']
      .map((preferred) => efforts.find((effort) => String(effort.id).toLowerCase() === preferred))
      .find((effort) => effort !== undefined)
    if (cheapest !== undefined) reasoningEffort = cheapest.id
  } catch {
    /* An adapter that cannot describe its model runs with its own default. */
  }

  const system = instructions === undefined || instructions.trim() === '' ? SYSTEM : `${SYSTEM}${instructions.trim()}`
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('polish timeout'))
  }, maxLatencyMs)
  let output = ''
  let reasoning = ''
  try {
    const stream = llm.stream({
      provider: target.provider,
      model: target.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt({ text, language, vocabulary }) }] }],
      temperature: 0,
      maxTokens: Math.min(1600, Math.max(600, Math.ceil(text.length * 1.8) + 240)),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      signal: controller.signal,
      ...(sessionId === undefined ? {} : { sessionId }),
    })
    let finishKind = 'stop'
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') output += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      else if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }
    if (finishKind !== 'stop') return { status: 'failed', reason: `finish:${finishKind}`, reasoning: reasoning.length, output: output.length, effort: reasoningEffort ?? null }
  } catch (error) {
    return { status: 'failed', reason: timedOut ? 'timeout' : `error:${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
  }

  const polished = sanitize(output)
  if (!plausible(text, polished)) return { status: 'failed', reason: 'implausible' }
  if (polished === text.trim()) return { status: 'unchanged', text: polished, model: target }
  return { status: 'applied', text: polished, model: target }
}

/** Prefer the model the Session last routed a request to; fall back to the default selection. */
function resolveModel(ctx, sessionId) {
  if (sessionId !== undefined && sessionId !== '') {
    const agents = ctx.get('agents')
    const agent = agents?.get?.(sessionId)
    const config = agent?.session?.requestHeader?.()?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
    return { provider: selection.provider, model: selection.model }
  }
  return undefined
}

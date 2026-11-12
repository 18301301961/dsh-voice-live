window.__ModuleLoader__.load({
  id: '@local/voice-live',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'voice-live'
    const ENDPOINT = '/voice-live'
    const SAMPLE_RATE = 16000
    const FRAME_SAMPLES = 1600
    const MAX_SECONDS = 300

    const zh = {
      start: '语音输入：实时转写',
      stop: '停止语音输入',
      listening: '正在听…',
      warming: '正在加载识别模型…',
      finishing: '正在整理文字…',
      hint: '开始说话，文字会实时出现',
      finish: '完成',
      cancel: '取消',
      dismiss: '关闭',
      insert: '插入到输入框',
      empty: '没有识别到语音',
      conflict: '输入框内容已改变，文字已保留',
      failed: '识别失败：{message}',
      unsupported: '当前浏览器不支持麦克风采集',
      permission: '麦克风权限被拒绝，请在系统或浏览器设置中允许',
      offline: '语音服务未就绪：{message}',
      preparing: '正在准备识别模型（首次使用需要下载）…',
      preparingHint: '模型准备好后会自动开始，请稍等',
      unavailable: '语音服务不可用',
      noModel: '未找到本地识别模型',
      level: '输入音量',
    }
    const en = {
      start: 'Voice input: live transcription',
      stop: 'Stop voice input',
      listening: 'Listening…',
      warming: 'Loading recognition model…',
      finishing: 'Finalizing text…',
      hint: 'Start speaking — words appear as you talk',
      finish: 'Done',
      cancel: 'Cancel',
      dismiss: 'Dismiss',
      insert: 'Insert into composer',
      empty: 'No speech recognized',
      conflict: 'The composer changed; the transcript was kept',
      failed: 'Recognition failed: {message}',
      unsupported: 'This browser cannot capture audio',
      permission: 'Microphone access is blocked. Allow it in the system or browser settings.',
      offline: 'Voice service unavailable: {message}',
      preparing: 'Preparing the recognition model (first use downloads it)…',
      preparingHint: 'Dictation starts automatically once the model is ready',
      unavailable: 'Voice service unavailable',
      noModel: 'Local recognition model not found',
      level: 'Input level',
    }

    /* ---------------------------------------------------------------- store */

    const initial = {
      phase: 'idle',
      committed: '',
      partial: '',
      level: 0,
      elapsed: 0,
      conflictText: null,
      notice: null,
    }

    const store = {
      state: initial,
      listeners: new Set(),
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
      getSnapshot() {
        return store.state
      },
      set(patch) {
        store.state = { ...store.state, ...patch }
        for (const listener of store.listeners) listener()
      },
      reset(patch) {
        store.state = { ...initial, ...patch }
        for (const listener of store.listeners) listener()
      },
    }

    function useLiveState() {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    /* -------------------------------------------------------------- capture */

    const WORKLET = `
      class DshVoiceLiveCapture extends AudioWorkletProcessor {
        constructor() {
          super()
          this.parts = []
          this.length = 0
        }
        process(inputs) {
          const channel = inputs[0] && inputs[0][0]
          if (channel === undefined || channel === null) return true
          this.parts.push(new Float32Array(channel))
          this.length += channel.length
          if (this.length >= ${FRAME_SAMPLES}) {
            const merged = new Float32Array(this.length)
            let offset = 0
            for (const part of this.parts) {
              merged.set(part, offset)
              offset += part.length
            }
            this.parts = []
            this.length = 0
            this.port.postMessage(merged, [merged.buffer])
          }
          return true
        }
      }
      registerProcessor('dsh-voice-live', DshVoiceLiveCapture)
    `

    /** Resample to 16 kHz with linear interpolation, carrying state across blocks. */
    function createResampler(from, to) {
      if (from === to) return (samples) => samples
      const ratio = from / to
      let carry = new Float32Array(0)
      let position = 0
      return (samples) => {
        const input = new Float32Array(carry.length + samples.length)
        input.set(carry, 0)
        input.set(samples, carry.length)
        const outputLength = Math.max(0, Math.floor((input.length - position - 1) / ratio))
        const output = new Float32Array(outputLength)
        let cursor = position
        for (let index = 0; index < outputLength; index++) {
          const left = Math.floor(cursor)
          const frac = cursor - left
          const a = input[left] ?? 0
          const b = input[left + 1] ?? a
          output[index] = a + (b - a) * frac
          cursor += ratio
        }
        const consumed = Math.floor(cursor)
        carry = input.slice(Math.min(consumed, input.length))
        position = cursor - consumed
        return output
      }
    }

    function toInt16(samples) {
      const pcm = new Int16Array(samples.length)
      for (let index = 0; index < samples.length; index++) {
        const value = samples[index]
        pcm[index] = value < -1 ? -32768 : value > 1 ? 32767 : Math.round(value * 32767)
      }
      return pcm
    }

    function levelOf(samples) {
      let sum = 0
      for (let index = 0; index < samples.length; index++) sum += samples[index] * samples[index]
      return Math.sqrt(sum / Math.max(1, samples.length))
    }

    class Capture {
      constructor() {
        this.context = null
        this.stream = null
        this.node = null
        this.gain = null
        this.source = null
        this.workletUrl = null
        this.onSamples = null
      }

      async start(onSamples) {
        if (navigator.mediaDevices === undefined) throw new Error('unsupported')
        this.onSamples = onSamples
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        })
        this.context = (() => {
          try {
            return new AudioContext({ sampleRate: SAMPLE_RATE })
          } catch {
            return new AudioContext()
          }
        })()
        if (this.context.state === 'suspended') await this.context.resume()
        this.source = this.context.createMediaStreamSource(this.stream)
        const resample = createResampler(this.context.sampleRate, SAMPLE_RATE)
        const deliver = (samples) => {
          if (this.onSamples === null) return
          const converted = resample(samples)
          if (converted.length > 0) this.onSamples(converted)
        }
        if (this.context.audioWorklet !== undefined && typeof AudioWorkletNode === 'function') {
          this.workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
          await this.context.audioWorklet.addModule(this.workletUrl)
          this.node = new AudioWorkletNode(this.context, 'dsh-voice-live', { numberOfOutputs: 1 })
          this.node.port.onmessage = (event) => deliver(event.data)
          this.source.connect(this.node)
          this.gain = this.context.createGain()
          this.gain.gain.value = 0
          this.node.connect(this.gain)
          this.gain.connect(this.context.destination)
          return
        }
        /* Older Chromium: fall back to a main-thread ScriptProcessor buffer. */
        const processor = this.context.createScriptProcessor(2048, 1, 1)
        processor.onaudioprocess = (event) => deliver(event.inputBuffer.getChannelData(0).slice(0))
        this.source.connect(processor)
        this.gain = this.context.createGain()
        this.gain.gain.value = 0
        processor.connect(this.gain)
        this.gain.connect(this.context.destination)
        this.node = processor
      }

      stop() {
        this.onSamples = null
        try {
          this.stream?.getTracks().forEach((track) => track.stop())
        } catch {}
        try {
          this.node?.disconnect()
        } catch {}
        try {
          this.gain?.disconnect()
        } catch {}
        try {
          this.source?.disconnect()
        } catch {}
        const close = this.context?.close?.()
        if (close !== undefined) close.catch(() => {})
        if (this.workletUrl !== null) URL.revokeObjectURL(this.workletUrl)
        this.stream = null
        this.context = null
        this.node = null
        this.gain = null
        this.source = null
        this.workletUrl = null
      }
    }

    /* ----------------------------------------------------------------- api */

    async function request(route, init) {
      const response = await fetch(`${ENDPOINT}${route}`, {
        ...init,
        headers: { 'x-voice-live': '1', ...(init?.headers ?? {}) },
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {}
      if (!response.ok) {
        const error = new Error(payload?.error ?? `${response.status}`)
        error.payload = payload
        throw error
      }
      return payload
    }

    /* ----------------------------------------------------------- controller */

    let controller = null
    let starting = false
    let warmed = false
    let retryTimer = null
    let retries = 0

    /** Retry while a first-run model download is still in progress. */
    function scheduleRetry(inputActions, t, sessionId) {
      if (retryTimer !== null) return
      if (retries >= 100) {
        retries = 0
        return
      }
      retries += 1
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (controller === null) begin(inputActions, t, sessionId)
      }, 3000)
    }

    /** Ask the Host to load the recognition engine before the first click. */
    function warm() {
      if (warmed) return
      warmed = true
      request('/warm', { method: 'POST' }).catch(() => {
        warmed = false
      })
    }

    function failureText(error, t) {
      if (error instanceof Error && error.message === 'unsupported') return t('unsupported')
      if (error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) return t('permission')
      return t('failed', { message: error instanceof Error ? error.message : String(error) })
    }

    class Session {
      constructor(id, inputActions, span, t, sessionId) {
        this.id = id
        this.inputActions = inputActions
        this.span = span
        this.t = t
        this.sessionId = sessionId
        this.capture = new Capture()
        this.accumulator = new Float32Array(0)
        this.busy = false
        this.pending = false
        this.closed = false
        this.startedAt = Date.now()
        this.lastLevelAt = 0
        this.ticker = setInterval(() => {
          store.set({ elapsed: Math.floor((Date.now() - this.startedAt) / 1000) })
          if (Date.now() - this.startedAt > MAX_SECONDS * 1000) this.finish()
        }, 500)
      }

      append(samples) {
        if (this.closed) return
        const merged = new Float32Array(this.accumulator.length + samples.length)
        merged.set(this.accumulator, 0)
        merged.set(samples, this.accumulator.length)
        this.accumulator = merged
        const now = Date.now()
        if (now - this.lastLevelAt > 100) {
          this.lastLevelAt = now
          store.set({ level: levelOf(samples) })
        }
        if (this.accumulator.length >= FRAME_SAMPLES) this.flush()
      }

      flush() {
        if (this.busy) {
          this.pending = true
          return
        }
        if (this.accumulator.length === 0) return
        const chunk = toInt16(this.accumulator)
        this.accumulator = new Float32Array(0)
        this.busy = true
        request(`/audio?id=${encodeURIComponent(this.id)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: chunk,
        })
          .then((snapshot) => {
            if (this.closed || snapshot === null) return
            if (typeof snapshot.committed === 'string') {
              store.set({
                committed: snapshot.committed,
                partial: typeof snapshot.partial === 'string' ? snapshot.partial : '',
                phase: snapshot.warming === true ? 'warming' : 'listening',
              })
            }
          })
          .catch((error) => {
            if (!this.closed) this.fail(error)
          })
          .finally(() => {
            this.busy = false
            if (this.pending) {
              this.pending = false
              this.flush()
            }
          })
      }

      release() {
        this.closed = true
        clearInterval(this.ticker)
        this.capture.stop()
        if (controller === this) controller = null
      }

      fail(error) {
        this.release()
        store.reset({ notice: failureText(error, this.t) })
      }

      finish() {
        if (this.closed) return
        const rest = this.accumulator
        this.release()
        store.set({ phase: 'finishing', partial: '', level: 0 })
        const chain = rest.length === 0
          ? Promise.resolve()
          : request(`/audio?id=${encodeURIComponent(this.id)}`, {
              method: 'POST',
              headers: { 'content-type': 'application/octet-stream' },
              body: toInt16(rest),
            })
        chain
          .then(() => request(`/finish?id=${encodeURIComponent(this.id)}${this.sessionId === undefined ? '' : `&session=${encodeURIComponent(this.sessionId)}`}`, { method: 'POST' }))
          .then((result) => {
            const value = String(result?.text ?? '').trim()
            if (value === '') {
              store.reset({ notice: this.t('empty') })
              return
            }
            if (this.inputActions !== undefined && this.inputActions.insertText(value, this.span)) {
              store.reset()
              return
            }
            store.reset({ conflictText: value })
          })
          .catch((error) => store.reset({ notice: failureText(error, this.t) }))
      }

      cancel() {
        if (this.closed) return
        this.release()
        store.reset()
        request(`/abort?id=${encodeURIComponent(this.id)}`, { method: 'POST' }).catch(() => {})
      }
    }

    async function begin(inputActions, t, sessionId) {
      if (controller !== null || starting) return
      starting = true
      let created
      try {
        created = await request('/start', { method: 'POST' })
      } catch (error) {
        const payload = error?.payload
        const phase = payload?.phase
        if (phase === 'preparing' || phase === 'checking' || phase === 'downloading' || phase === 'loading') {
          store.reset({ notice: t('preparing') })
          scheduleRetry(inputActions, t, sessionId)
          return
        }
        const message = phase === 'unprepared' || phase === 'unavailable' ? t('noModel') : (error instanceof Error ? error.message : String(error))
        store.reset({ notice: t('offline', { message }) })
        return
      } finally {
        starting = false
      }
      const session = new Session(created.id, inputActions, inputActions?.captureInsertion?.(), t, sessionId)
      controller = session
      retries = 0
      store.reset({ phase: created.warming === true ? 'warming' : 'listening' })
      try {
        await session.capture.start((samples) => session.append(samples))
      } catch (error) {
        session.release()
        store.reset({ notice: failureText(error, t) })
        request(`/abort?id=${encodeURIComponent(session.id)}`, { method: 'POST' }).catch(() => {})
        return
      }
      session.flush()
    }

    /* ------------------------------------------------------------------ ui */

    function MicIcon({ size = 18 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M12 3.5a2.6 2.6 0 0 0-2.6 2.6v5.4a2.6 2.6 0 1 0 5.2 0V6.1A2.6 2.6 0 0 0 12 3.5Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M6.2 11.3a.85.85 0 0 1 1.7 0 4.1 4.1 0 0 0 8.2 0 .85.85 0 0 1 1.7 0 5.8 5.8 0 0 1-4.95 5.7v2.2a.85.85 0 0 1-1.7 0v-2.2a5.8 5.8 0 0 1-4.95-5.7Z',
          fill: 'currentColor',
        }),
      )
    }

    function StopIcon({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2.4, fill: 'currentColor' }),
      )
    }

    function CloseIcon({ size = 14 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M7 7l10 10M17 7L7 17', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' }),
      )
    }

    const styles = `
      .dvl-trigger { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px;
        border-radius:8px; border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary);
        cursor:pointer; padding:0; transition: color .15s, background .15s, border-color .15s; }
      .dvl-trigger:hover:not(:disabled) { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); }
      .dvl-trigger:disabled { opacity:.4; cursor:default; }
      .dvl-trigger[data-active="true"] { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary);
        background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
      .dvl-card { display:flex; flex-direction:column; gap:6px; margin-top:6px; padding:8px 10px; border-radius:10px;
        border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary);
        font-size:12px; line-height:1.5; }
      .dvl-head { display:flex; align-items:center; gap:8px; }
      .dvl-dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); flex:0 0 auto; }
      .dvl-dot[data-phase="listening"] { background:var(--dsw-alias-state-error-primary); animation:dvl-pulse 1.1s ease-in-out infinite; }
      .dvl-dot[data-phase="warming"], .dvl-dot[data-phase="finishing"] { background:var(--dsw-alias-state-warn-primary); animation:dvl-pulse 1.4s ease-in-out infinite; }
      @keyframes dvl-pulse { 0%,100% { opacity:1 } 50% { opacity:.25 } }
      .dvl-label { color:var(--dsw-alias-label-secondary); white-space:nowrap; }
      .dvl-bars { display:inline-flex; align-items:flex-end; gap:2px; height:12px; }
      .dvl-bars > i { width:2px; border-radius:1px; background:var(--dsw-alias-state-idle-primary); transition:height .08s linear; }
      .dvl-bars > i[data-on="true"] { background:var(--dsw-alias-brand-primary); }
      .dvl-spacer { flex:1 1 auto; }
      .dvl-time { color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
      .dvl-icon { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:6px;
        border:none; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; padding:0; }
      .dvl-icon:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
      .dvl-primary { display:inline-flex; align-items:center; gap:4px; height:22px; padding:0 10px; border-radius:6px;
        border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary);
        cursor:pointer; font-size:12px; white-space:nowrap; }
      .dvl-primary:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
      .dvl-primary:disabled { opacity:.55; cursor:default; }
      .dvl-text { min-height:18px; max-height:120px; overflow-y:auto; white-space:pre-wrap; word-break:break-word; }
      .dvl-partial { color:var(--dsw-alias-label-secondary); }
      .dvl-partial::after { content:''; display:inline-block; width:1px; height:1em; margin-left:2px; vertical-align:-2px;
        background:var(--dsw-alias-brand-primary); animation:dvl-blink .9s step-end infinite; }
      @keyframes dvl-blink { 0%,100%{opacity:1} 50%{opacity:0} }
      .dvl-hint { color:var(--dsw-alias-label-secondary); }
      .dvl-notice { margin-top:2px; color:var(--dsw-alias-state-warn-primary); }
      .dvl-row { display:flex; align-items:center; gap:8px; }
    `

    function Styles() {
      return h('style', { dangerouslySetInnerHTML: { __html: styles } })
    }

    function LevelBars({ level, label }) {
      const nodes = []
      for (let index = 0; index < 7; index++) {
        const threshold = 0.006 + index * 0.016
        nodes.push(h('i', { key: index, 'data-on': String(level > threshold), style: { height: `${3 + index * 1.3}px` } }))
      }
      return h('span', { className: 'dvl-bars', role: 'img', 'aria-label': label }, nodes)
    }

    function MicButton(props) {
      const state = useLiveState()
      const active = state.phase !== 'idle'
      const toggle = () => {
        if (controller !== null) controller.finish()
        else {
          warm()
          begin(props.inputActions, props.t, props.sessionId)
        }
      }
      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'button',
          {
            type: 'button',
            className: 'dvl-trigger',
            'data-active': String(active),
            title: active ? props.t('stop') : props.t('start'),
            'aria-label': active ? props.t('stop') : props.t('start'),
            'aria-pressed': active,
            disabled: props.locked === true,
            onMouseDown: (event) => event.preventDefault(),
            onPointerEnter: () => warm(),
            onFocus: () => warm(),
            onClick: toggle,
          },
          active ? h(StopIcon) : h(MicIcon),
        ),
      )
    }

    function LivePanel(props) {
      const state = useLiveState()
      const live = state.phase === 'listening' || state.phase === 'warming' || state.phase === 'finishing'
      React.useEffect(() => {
        const escape = (event) => {
          if (event.key === 'Escape' && controller !== null) {
            event.preventDefault()
            controller.cancel()
          }
        }
        document.addEventListener('keydown', escape)
        return () => document.removeEventListener('keydown', escape)
      }, [])
      if (!live && state.conflictText === null && state.notice === null) return null

      const label = state.phase === 'warming'
        ? props.t('warming')
        : state.phase === 'finishing'
          ? props.t('finishing')
          : props.t('listening')
      const minutes = Math.floor(state.elapsed / 60)
      const seconds = String(state.elapsed % 60).padStart(2, '0')

      const head = live
        ? h(
            'div',
            { className: 'dvl-head' },
            h('span', { className: 'dvl-dot', 'data-phase': state.phase }),
            h('span', { className: 'dvl-label' }, label),
            h(LevelBars, { level: state.level, label: props.t('level') }),
            h('span', { className: 'dvl-spacer' }),
            h('span', { className: 'dvl-time' }, `${minutes}:${seconds}`),
            h(
              'button',
              {
                type: 'button',
                className: 'dvl-icon',
                title: props.t('cancel'),
                'aria-label': props.t('cancel'),
                onClick: () => controller?.cancel(),
              },
              h(CloseIcon),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dvl-primary',
                disabled: state.phase === 'finishing',
                onClick: () => controller?.finish(),
              },
              props.t('finish'),
            ),
          )
        : null

      const body = live
        ? h(
            'div',
            { className: 'dvl-text' },
            state.committed === '' && state.partial === ''
              ? h('span', { className: 'dvl-hint' }, props.t('hint'))
              : [
                  h('span', { key: 'committed' }, state.committed),
                  h(
                    'span',
                    { key: 'partial', className: 'dvl-partial' },
                    state.committed !== '' && state.partial !== '' ? ' ' : '',
                    state.partial,
                  ),
                ],
          )
        : null

      const notice = state.notice === null
        ? null
        : h(
            'div',
            { className: 'dvl-row' },
            h('span', { className: 'dvl-notice', role: 'status' }, state.notice),
            h('span', { className: 'dvl-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dvl-icon',
                title: props.t('dismiss'),
                'aria-label': props.t('dismiss'),
                onClick: () => store.reset(),
              },
              h(CloseIcon),
            ),
          )

      const conflict = state.conflictText === null
        ? null
        : h(
            'div',
            { className: 'dvl-row' },
            h('div', { className: 'dvl-text' }, state.conflictText),
            h('span', { className: 'dvl-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dvl-primary',
                onClick: () => {
                  if (props.inputActions?.insertText(state.conflictText, props.inputActions.captureInsertion())) store.reset()
                },
              },
              props.t('insert'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dvl-icon',
                title: props.t('dismiss'),
                'aria-label': props.t('dismiss'),
                onClick: () => store.reset(),
              },
              h(CloseIcon),
            ),
          )

      return h(
        React.Fragment,
        null,
        h(Styles),
        h('div', { className: 'dvl-card', role: 'group', 'aria-label': props.t('start') }, head, body, notice, conflict),
      )
    }

    const dictionaries = { zh, en, ja: en, es: en, fr: en, de: en, ru: en, pt: en }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries))
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'voice-live', order: 12, locale: NS },
            MicButton,
          ),
        )
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'voice-live', order: 2, locale: NS },
            LivePanel,
          ),
        )
        ctx.effect(() => () => {
          if (retryTimer !== null) clearTimeout(retryTimer)
          retryTimer = null
          if (controller !== null) controller.cancel()
        })
      },
    }
  },
})

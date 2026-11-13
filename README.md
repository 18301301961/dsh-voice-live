# dsh-voice-live

Live streaming voice input for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web composer.

Speak, and words appear while you talk; press Done and the transcript is corrected once, then inserted into your draft.
Recognition runs on your machine — audio never leaves the computer.

[中文说明](README.zh.md) · [Releases](https://github.com/18301301961/dsh-voice-live/releases)

> The live caption card sits above the composer: settled sentences in normal color, the sentence being recognized in grey.

## Features

- **Streaming captions** — the sentence in progress is re-decoded on a sliding window every ~0.5–0.8 s.
- **Sentence-level final decode** — when Silero VAD detects an endpoint, the complete sentence is decoded again, so final quality equals whole-clip decoding.
- **Clean audio path** — 16 kHz PCM straight from the microphone with browser echo cancellation, noise suppression and AGC disabled; SenseVoice ITN (digits) and punctuation enabled.
- **Optional model-assisted correction** — a minimal-edit pass fixes homophones (查件 → 插件), product names (拼森 → Python), digits and punctuation. It keeps your wording, and silently falls back to the local transcript on timeout or implausible output.
- **No manual model setup** — the first use asks DSH's own speech service to prepare the SenseVoice model, shows progress, then starts recording automatically.

## Requirements

- DSH Desktop `0.2.2-rc.1` or newer. Tested on Windows x64; macOS and Linux are expected to work because the engine is resolved from the installation, but are untested.
- No npm dependencies: `sherpa-onnx` comes from the DSH installation and the model from DSH's speech service.
- About 240 MB of model on disk and ~400 MB RAM while the engine is warm (released after `idleTimeoutMs`).

## Install

### From npm (after the first publish)

Install the bundle by its package name — in the Plugins page, or by asking your agent to install it:

```text
@your-scope/dsh-voice-live
```

> Placeholder: replace the scope with the published name. The browser module id in `client.js` must stay equal to the package name.

### From this repository

```text
git clone https://github.com/18301301961/dsh-voice-live.git
```

Then install that directory as a DSH bundle — either through the plugin manager with the absolute path, or by asking your agent to install it.

### From a git source

```text
github:18301301961/dsh-voice-live#v1.1.0
```

Reload the page once after installing; the microphone button appears to the left of the send button. See [PUBLISH.md](PUBLISH.md) for the full distribution guide.

## Usage

1. Hover the microphone to warm the engine (~3–4 s, once per idle period).
2. Click it and speak: settled sentences render in normal color, the sentence in progress in grey with a caret.
3. **Done** inserts the text at the cursor; **✕** or `Esc` discards it.
4. If the composer changed during dictation, the transcript stays on the card and **Insert into composer** writes it at the current cursor.

## Configuration

The bundle row lives in `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `language` | `zh` | `auto`, `zh`, `en`, `yue`, `ja`, `ko` |
| `threads` | `4` | ONNX Runtime threads |
| `partialIntervalMs` | `480` | Minimum live-caption refresh interval; widens automatically with decode cost |
| `partialWindowSeconds` | `6` | Audio window used for the sentence in progress |
| `vadThreshold` | `0.5` | Silero VAD threshold; raise it in noisy rooms |
| `minSilenceSeconds` | `0.35` | Silence that ends a sentence |
| `maxSpeechSeconds` | `12` | Longest continuous sentence before a forced break |
| `idleTimeoutMs` | `300000` | Release the engine after this idle time |
| `polish` | `final` | `final` corrects the transcript once at the end; `off` keeps the local text |
| `vocabulary` | `[]` | Terms the recognizer tends to misspell, for example `[DSH, Cordis]` |
| `polishInstructions` | empty | One extra sentence appended to the correction prompt |
| `polishMaxLatencyMs` | `8000` | Correction timeout; on timeout the local text is used |

## How it works

- `engine.mjs` — Silero VAD segmentation plus SenseVoice decoding; the in-progress sentence is re-decoded on a sliding window, the finished sentence once on its complete audio.
- `worker.mjs` — a child process (Electron Node mode) hosting the engine on a random loopback port with a per-process token, so model loading never blocks the Host.
- `index.js` — the `/voice-live/*` routes (same-origin and `x-voice-live` checks), sessions, warm-up, model preparation, audio forwarding and finish handling.
- `polish.mjs` — the correction pass: cheapest reasoning effort, temperature 0, hard timeout, and two guards (length ratio and character overlap) that reject rewrites.
- `client.js` — AudioWorklet capture (linear resampling to 16 kHz when needed), the caption card and draft insertion.

## Privacy

Audio is decoded locally and never uploaded. With `polish: final`, only the finished text is sent to the model configured in DSH — which is where that text was headed anyway.

## Limitations

- The recognition model is shared with DSH's built-in voice input; this plugin ships no model of its own.
- Uninterrupted speech is split at `maxSpeechSeconds`; the correction pass usually repairs the punctuation seam.
- The composer integration depends on DSH client slots and is untested against future releases.

## License

MIT — see [LICENSE](LICENSE).

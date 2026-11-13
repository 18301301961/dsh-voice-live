# dsh-voice-live

[![npm](https://img.shields.io/npm/v/dsh-voice-live.svg)](https://www.npmjs.com/package/dsh-voice-live)
[![license](https://img.shields.io/npm/l/dsh-voice-live.svg)](LICENSE)

DeepSeek Harness 的**实时语音输入**插件：在输入框旁提供「边说边出字」的听写。

说话时文字实时出现；点「完成」后，转写再做一次最小必要的校对，然后写入草稿。识别在本机完成，音频不上传。

[English](README.md) · [版本发布](https://github.com/18301301961/dsh-voice-live/releases)

> 字幕条在输入框上方：已定稿的句子用正常颜色，正在识别的这一句用灰色＋光标。

## 特性

- **实时字幕**：正在说的这一句按滑动窗口每 ~0.5–0.8 秒重新解码一次，边说边出字。
- **整句定稿**：Silero VAD 判定一句结束后，对该句完整音频重新解码一次，最终质量等于整段批量识别。
- **干净的音频链路**：浏览器直接采集 16 kHz PCM，关闭回声消除／降噪／自动增益；开启 SenseVoice 的数字规整（ITN）与标点。
- **可选的模型校对**：最小修改原则，修同音字（查件→插件）、产品名（拼森→Python）、数字与标点；保持你的措辞，超时或返回不可信时静默回退到本地结果。
- **无需手动准备模型**：首次使用时通过 DSH 自带的语音服务下载模型、显示进度，完成后自动开始录音。

## 环境要求

- DSH Desktop `0.2.2-rc.1` 或更新版本。Windows x64 已实测；macOS / Linux 理论上可用（引擎从安装目录解析），但未实测。
- 无 npm 依赖：识别引擎 `sherpa-onnx` 来自 DSH 安装目录，模型来自 DSH 的语音服务。
- 模型约占 240 MB 磁盘；引擎常驻时约占 400 MB 内存（空闲 `idleTimeoutMs` 后释放）。

## 安装

### 从 npm 安装

用包名安装（插件页，或让智能体安装）：

```text
dsh-voice-live
```

### 从仓库安装

```text
git clone https://github.com/18301301961/dsh-voice-live.git
```

然后把该目录作为 DSH bundle 安装（插件管理器传绝对路径，或让智能体安装）。

### 从 git 源安装

```text
github:18301301961/dsh-voice-live#v1.1.0
```

安装后刷新一次页面，麦克风按钮出现在发送按钮左侧。完整分发说明见 [PUBLISH.zh.md](PUBLISH.zh.md)。

## 使用

1. 鼠标悬停麦克风即开始预热（每次空闲后约 3–4 秒）。
2. 点击开始说话：已定稿句子用正常色，正在识别的句子用灰色＋光标。
3. **完成**把文字写到光标处；**✕** 或 `Esc` 丢弃。
4. 若识别期间草稿被改动，文字会留在字幕卡上，点 **插入到输入框** 写到当前光标。

## 配置

配置行在 `cordis.patch.yml`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `language` | `zh` | `auto` / `zh` / `en` / `yue` / `ja` / `ko` |
| `threads` | `4` | ONNX Runtime 线程数 |
| `partialIntervalMs` | `480` | 实时字幕最小刷新间隔（会按解码耗时自动放宽） |
| `partialWindowSeconds` | `6` | 当前句参与实时解码的窗口 |
| `vadThreshold` | `0.5` | Silero VAD 阈值，嘈杂环境可调高 |
| `minSilenceSeconds` | `0.35` | 判定一句结束的最短静音 |
| `maxSpeechSeconds` | `12` | 连续说话超过此时长强制断句 |
| `idleTimeoutMs` | `300000` | 空闲多久释放识别进程 |
| `polish` | `final` | `final` 收尾时用模型校对一次；`off` 只用本地结果 |
| `vocabulary` | `[]` | 供校对使用的专有名词表，如 `[DSH, Cordis]` |
| `polishInstructions` | 空 | 追加到校对提示词的一句话 |
| `polishMaxLatencyMs` | `8000` | 校对超时，超时直接用本地结果 |

## 实现

- `engine.mjs`：Silero VAD 流式分段 + SenseVoice 解码；当前句滑窗反复解码、结束句整段解码一次。
- `worker.mjs`：独立子进程（Electron Node 模式）承载引擎，监听随机回环端口并用一次性 token 鉴权，模型加载不阻塞主进程。
- `index.js`：`/voice-live/*` 路由（同源校验 + `x-voice-live` 请求头）、会话、预热、模型准备、音频转发与收尾。
- `polish.mjs`：校对通道，强制最低推理档、`temperature: 0`、硬超时，并用长度比例与字符重合率两道校验拒绝改写。
- `client.js`：AudioWorklet 采集（必要时线性重采样到 16 kHz）、字幕卡与写入草稿。

## 隐私

音频只在本机解码，从不上传。开启 `polish: final` 时，只有最终的**文字**会发给你在 DSH 里配置的模型——这段文字本来也是要发给它的。

## 已知限制

- 识别模型复用 DSH 内置语音输入的那一份，本插件不自带、也不训练模型。
- 连续不停顿的说话会在 `maxSpeechSeconds` 处切分，切口通常由校对通道补回标点。
- 输入框集成依赖 DSH 客户端插槽，未来版本可能需要适配。

## 许可证

MIT，见 [LICENSE](LICENSE)。

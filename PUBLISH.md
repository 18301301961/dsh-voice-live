# 发布与分发

当前包名是 `@local/voice-live`（`private: true`），只用于本机安装。要让别人安装，按下面任一条路走。

## 一、直接分发（最快，无需账号）

1. 打包目录：把整个 `voice-live/` 压成 zip 发给对方。
2. 对方解压后，在 DSH 里安装这个目录（插件管理器 `install_bundle`，target 传目录绝对路径），或用对话让智能体安装。
3. 对方首次点麦克风时，插件会请求 DSH 自带的语音服务下载 SenseVoice 模型（约 240 MB），下载完成后自动开始，不需要手动操作。

## 二、发布到 npm（别人一条命令安装）

1. 改包名：`package.json` 的 `name` 换成自己的作用域，例如 `@yourname/dsh-voice-live`；同时把 `"private": true` 去掉。
2. 客户端注册 id 必须跟着改：`client.js` 第一行 `id: '@local/voice-live'` 要等于新的包名。
3. 首次发布：

   ```bash
   npm login
   npm publish --access public
   ```

4. 别人安装：插件管理器里用 `@yourname/dsh-voice-live` 这个 spec 安装，或者从 GitHub 地址安装。

## 三、进入「发现」页的插件索引

DSH 的 Discover 页读取外部插件索引（默认 `https://cdn.dsh.so/market/index.json`）。要让插件出现在那里，需要索引维护方收录；常见做法是把包发布到 npm 后，向索引仓库提 PR 或 issue，附上包名、标题、描述与图标。

## 发布前自检清单

- [ ] `package.json`：`name` / `version` / `license` / `engines.dsh` / `files` 与实际文件一致
- [ ] `client.js` 的模块 id 与包名一致（不一致会导致客户端模块加载不出来）
- [ ] `locale/en.json`、`locale/zh.json` 的 `meta.title` / `meta.description` 已本地化
- [ ] `icon.svg` 有效、小于 256 KiB
- [ ] 没有把本机路径、token、个人词表写进代码或 patch
- [ ] 只声明运行时真实需要的依赖（本包无 npm 依赖）
- [ ] 在另一台机器上从零安装并完成一次「模型下载 → 说话 → 写入草稿」

## 送上游 PR（可选）

如果想进 DSH 官方插件集，做法是在 DSH 仓库新增一个 `packages/experimental/<name>` 包：Host 入口、`dsh.client` 客户端入口、`cordis.patch.yml`、locale、icon，并补 README 与测试；然后提 PR。本包的四个文件（`index.js`、`client.js`、`engine.mjs`、`worker.mjs`、`polish.mjs`）可以几乎原样搬过去，只需要按仓库规范拆成 `src/*.ts`。

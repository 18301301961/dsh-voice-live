# 发布与分发

当前包名是 `@local/voice-live`（`private: true`），从本地目录安装。要让别人用上，按下面任一条路走。

## 一、直接分发（最快，不需要账号）

1. 把 `dsh-voice-live/` 打包成 zip 发出去。
2. 对方把它作为 DSH bundle 安装（插件管理器 `install_bundle` 传目录绝对路径，或直接让智能体装）。
3. 对方首次使用时，插件会请求 DSH 自带的语音服务下载 SenseVoice 模型（约 240 MB），显示进度，完成后自动开始录音。

## 二、发布到 npm（别人一条命令安装）

1. 把 `package.json` 里的 `name` 换成自己的作用域，例如 `@yourname/dsh-voice-live`，并去掉 `"private": true`。
2. **客户端模块 id 必须与包名一致**：`client.js` 第一行要是 `id: '@yourname/dsh-voice-live'`，不一致会导致浏览器模块加载不出来。
3. 发布：

   ```bash
   npm login
   npm publish --access public
   ```

4. 别人用这个包名安装（插件页或让智能体安装）。

记得让 `git tag v<version>`、`package.json` 的 `version` 和 Release 说明保持一致。

## 三、从 git 源安装

DSH 安装器也接受 git 风格的安装 spec，不经过 npm 也能装：

```text
github:18301301961/dsh-voice-live#v1.1.0
```

这种方式会拉源码再装依赖，比 npm 慢，在网络受限的环境里也更脆弱。

## 四、进入 Discover 页的插件索引

默认索引（`https://cdn.dsh.so/market/index.json`）是 **DSH.SO 安装验证与安全审计插件市场**：只收录通过真实沙盒安装验证（L4/L5）、且安全结论为低风险的条目。每条记录包含 `name`、本地化的 `title` / `description`、`author`、`repository.url`、分类与关键词，以及 `versions[]`（`source.type` 为 `npm` 或 `git`，可带 commit）。先发布，再走 dsh.so 上给出的提交入口——索引本身没有公开的 PR 流程。

## 发布前自检清单

- [ ] `package.json`：`name` / `version` / `license` / `engines.dsh` / `files` 与仓库一致
- [ ] `client.js` 的模块 id 等于包名
- [ ] `locale/en.json`、`locale/zh.json` 的 `meta.title` / `meta.description` 已本地化
- [ ] `icon.svg` 有效且小于 256 KiB
- [ ] 代码与 patch 里没有本机路径、token、个人词表
- [ ] 没有用不到的 npm 依赖（本包为零依赖）
- [ ] 在一台干净机器上从零走通：下载模型 → 说话 → 文字进入草稿

## 送上游 PR（可选）

想进 DSH 官方包集合，就在 DSH 仓库新增 `packages/experimental/<name>`：Host 入口、`dsh.client` 客户端入口、`cordis.patch.yml`、locale、icon、README 与测试，然后提 PR。本包的五个运行文件（`index.js`、`client.js`、`engine.mjs`、`worker.mjs`、`polish.mjs`）几乎可以原样搬过去，只需按仓库规范拆成 `src/*.ts`。

[English](PUBLISH.md)

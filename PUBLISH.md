# Publishing and distribution

The package is currently `@local/voice-live` (`private: true`) and installed from a local directory. Pick one of the paths below to let other people use it.

## 1. Hand the folder over (fastest, no account needed)

1. Zip `dsh-voice-live/` and send it.
2. The recipient installs that directory as a DSH bundle — plugin manager `install_bundle` with the absolute path, or simply asks their agent to install it.
3. On first use the plugin asks DSH's own speech service to download the SenseVoice model (~240 MB), shows progress, then starts recording by itself.

## 2. Publish to npm (one-line install for everyone)

1. Rename the package in `package.json` to your own scope, for example `@yourname/dsh-voice-live`, and remove `"private": true`.
2. **Keep the client module id equal to the package name.** Line 1 of `client.js` must read `id: '@yourname/dsh-voice-live'`; a mismatch makes the browser module fail to load.
3. Publish:

   ```bash
   npm login
   npm publish --access public
   ```

4. Others install the bundle by that package name, in the Plugins page or by asking their agent.

Keep `git tag v<version>` in step with `package.json` so the repository, the npm tarball and the release notes agree.

## 3. Install from a git source

A DSH installer also accepts git-like installation specs, so a repository can be installed without npm:

```text
github:18301301961/dsh-voice-live#v1.1.0
```

That pulls the sources and installs their dependencies, so it is slower and more fragile than npm in restricted networks.

## 4. Getting listed in the Discover page

The default index (`https://cdn.dsh.so/market/index.json`) is the **DSH.SO install-verified and security-audited market**: it only lists entries that passed a real sandbox install verification (L4/L5) with a low-risk security verdict. Each entry carries `name`, localized `title`/`description`, `author`, `repository.url`, a category plus keywords, and `versions[]` whose `source.type` is `npm` or `git` (optionally with a commit). Publish first, then use the submission path described on dsh.so — the index itself advertises no public PR process.

## Pre-publish checklist

- [ ] `package.json`: `name`, `version`, `license`, `engines.dsh`, `files` match the repository
- [ ] `client.js` module id equals the package name
- [ ] `locale/en.json` and `locale/zh.json` have localized `meta.title` / `meta.description`
- [ ] `icon.svg` is valid and under 256 KiB
- [ ] No machine paths, tokens or personal vocabulary lists in code or patch
- [ ] No npm dependencies that are not actually used (this package has none)
- [ ] Install from zero on a clean machine: model download → speak → text in the draft

## Contributing upstream (optional)

To become part of the official package set, add `packages/experimental/<name>` to the DSH repository: a Host entry, a `dsh.client` entry, `cordis.patch.yml`, locale files, an icon, a README and tests; then open a pull request. The five runtime files here (`index.js`, `client.js`, `engine.mjs`, `worker.mjs`, `polish.mjs`) port over almost unchanged — they only need splitting into `src/*.ts` following the repository conventions.

[中文版](PUBLISH.zh.md)

# 贡献指南

感谢参与 AppCenter。本文说明本地开发、测试与提交约定。

## 环境

- Node.js >= 24（直接用 `--experimental-transform-types` 跑 TS，无构建步骤）
- Windows 上才有的能力：注册表清单、`reg.exe`、WinForms 托盘、安装执行。
  纯逻辑与测试可在任意平台运行。

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test
```

## 目录约定

- `packages/core` — 领域引擎，零 UI 框架依赖；所有系统交互走可注入接口。
- `packages/server` — 目录 / 评分 / 审批 / 鉴权 HTTP 服务 + SQLite。
- `packages/app` — 本地 Web 客户端（bridge + SSE）、WinForms 托盘宿主。
- `packages/cli` — 无头壳，JSON Lines IPC，与 Web 桥共用同一张 dispatch 方法表。

## 提交前检查

1. `npm run typecheck` 干净。
2. `npm test` 全绿；新增行为请补对应测试。
3. 不提交运行时产物：`local-repo/`、`*.db`、`*.log`、`.shots/` 已在 `.gitignore`。
4. 不提交任何第三方专有二进制或安装包。

## 提交信息

使用语义化前缀：`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`。
正文说明「为什么」，而非逐行复述改动。

## 设计约束

- **引擎与 UI 分离**：UI 宿主只实现 `WindowHost` 并订阅 `onJob`，不把业务塞进前端。
- **副作用可注入**：注册表、文件系统、下载、执行器都通过接口注入，测试不触达真实系统。
- **默认安全**：清理类操作默认 `dryRun`；安装包搬运只复制不执行。

## 许可

贡献即同意以 [MIT](LICENSE) 许可发布。

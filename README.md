# AppCenter

[![CI](https://github.com/wakawakalululu/appcenter/actions/workflows/ci.yml/badge.svg)](https://github.com/wakawakalululu/appcenter/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/wakawakalululu/appcenter)](https://github.com/wakawakalululu/appcenter/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

企业「应用中心 / 软件商店」客户端引擎 + 目录服务端。TypeScript 实现，零构建步骤（Node 直接跑 TS）。

![应用中心首页](docs/assets/screenshots/home.png)

覆盖软件分发全链路：目录与分类检索、本机已装清单、卸载残留扫描与清理、断点续传下载与校验、
多类型安装执行计划、批量安装与升级、申请审批、皮肤与主题、客户端自升级、系统托盘与多窗口。

> 本项目为独立实现的开源软件。终端管控类能力（行为采集、Web 中间人、锁屏、远程桌面、
> 驱动级进程拦截、静默保活）不在设计范围内。

## 目录结构

```
packages/core      领域引擎，无框架依赖，Windows 交互全部走可注入接口
  catalog/         目录、分类树、中文搜索、贝叶斯评分
  inventory/       注册表卸载项清单（HKLM 64/32 + HKCU）、图标缓存、清单落盘缓存
  leftover/        卸载残留扫描与清理计划（只读扫描 + 白名单删除）
  download/        Range 断点续传下载器，sha256 校验后才落地
  runner/          MSI / NSIS / Inno / MSIX / 归档 / 脚本的执行计划
  orchestrator/    安装状态机、批量队列、装后版本回读、卸载后残留扫描
  upgrader/        版本比较与升级计划
  selfupdate/      客户端自升级：暂存、校验、换版、失败回滚
  approval/        申请审批生命周期与安装凭证
  runtime/         跨进程运行配置、开机自启
  theme/           皮肤 token 注册表与校验
  windows/         多窗口与单实例锁
  tray/            托盘状态机与菜单
  localrepo/       真机安装包发现与本地仓库镜像
  facade.ts        面向 UI 宿主的统一入口
packages/server    目录 / 评分 / 审批 / 鉴权 / 审计 / 自升级清单 HTTP 服务 + SQLite + Range 下载
packages/app       本地 Web 客户端（bridge + SSE）、WinForms 托盘宿主、桌面 UI
packages/cli       无头壳：JSON Lines IPC，可对接任意 UI 宿主
```

## 运行

需要 Node >= 24（用 `--experimental-transform-types` 直接跑 TS，无需构建步骤）。

```bash
npm install

# 服务端：建库 + 灌演示数据
node --experimental-transform-types packages/server/src/main.ts --seed

# 客户端壳（另开一个终端）
node --experimental-transform-types packages/cli/src/main.ts search wps
node --experimental-transform-types packages/cli/src/main.ts demo

# 手工喂一条 IPC 指令，协议每行一个 JSON
node --experimental-transform-types packages/cli/src/main.ts shell
{"id":1,"method":"catalog.search","params":{"text":"wps"}}
{"id":2,"method":"upgrade.plan"}
{"id":3,"method":"ui.skin","params":{"id":"cny"}}
{"id":4,"method":"ui.tray"}

# 端到端冒烟：服务端 + CLI + 本机注册表清单
node --experimental-transform-types scripts/smoke.mts

# 校验
npm run typecheck
npm test
```

部署服务端时用 `ADMIN_TOKEN` 保护发布与审批接口，并可按需签发用户/角色令牌：

```bash
ADMIN_TOKEN=xxx DB_FILE=/var/lib/appcenter/catalog.db PACKAGE_ROOT=/srv/packages \
  node --experimental-transform-types packages/server/src/main.ts
```

## 设计要点

1. **引擎与 UI 分离**。`@appcenter/core` 是纯逻辑，不含任何 UI 框架依赖；UI 宿主只需实现
   `WindowHost`（create/show/hide/close/focus）并订阅 `onJob`，即可接 Web、Electron、Tauri 或原生壳。
2. **注册表读写分级**。清单读取走 `reg.exe` 只读查询（`RegClient` 接口，测试注入内存实现）；
   任何写入与删除只发生在显式清理计划里，且必须同时满足：风险被勾选、路径在 `allowWriteRoots` 内、
   确认串正确。`C:\Windows`、盘根、白名单外路径一律拒绝，默认 `dryRun`。
3. **下载即校验**。`AppVersion` 必须带 `sha256` + `sizeBytes`；`.part` + `.part.json` 支撑续传，
   校验不过不进安装态，体积不符保留断点，和校验失败区别处理。
4. **审批是安装前置闸门**。`requiresApproval` 的应用在拿到有效凭证前停在 `awaiting_approval`，
   不会先下载再拦。凭证由服务端签发；客户端默认不内置签发密钥（把密钥打进安装包等于没有校验），
   真实性由签发方保证，本地校验归属、有效期与吊销状态。
5. **装后校验与失败清理**。安装进程退出后回读注册表确认真实已装版本写回任务；无论成功、失败还是
   异常，都按 `installerCleanup` 开关清理已下载的安装包。
6. **首屏不卡**。已装清单落盘缓存（原子写 + TTL），命中即返回；过期走「先 `queryChildren` 发现子键、
   再按 regDir 窄查询」的增量刷新；三个卸载根并行扫描。
7. **鉴权与审计**。服务端以「用户 / 角色令牌」取代单一静态令牌（`users`、`api_tokens` 表），
   管理员操作校验角色，关键动作写入 `audit_log`；目录支持按部门下发可见范围。
8. **皮肤是 token 而不是散落色值**。新增皮肤只需注册一份 token 覆盖表，缺失项回落基础主题并被显式记录，
   未通过 `validateTokens` 的皮肤会被拒绝。
9. **自升级可回滚**。暂存包校验通过后写 pending 标记，换版由独立进程完成；
   启动时若 pending 未 commit，视为新版没起来，自动回滚备份。

## 状态

已完成：目录 / 分类 / 搜索 / 评分 / 清单（含缓存与增量刷新）/ 残留扫描 / 清理计划与备份撤销 /
断点续传下载 / 多类型安装执行计划 / 装后版本回读 / 编排与批量队列 / 升级计划 / 自升级 /
审批与通知回路 / 皮肤 / 窗口 / 托盘 / 开机自启开关 / 真机安装包发现与本地仓库镜像 /
服务端（鉴权、审计、部门目录、捆绑包、运营位、机群资产心跳与离线判定）/ CLI 与桌面 UI，共 127 项测试。

目录应用支持 `installMode: silent | manual`——手动安装弹真实安装向导（执行计划剥掉静默参数）。

发现与镜像用两条脚本即可复现：`npm run discover`（只发现并落 `discover-report.json`）、
`npm run build:real-catalog`（发现 → 替换演示目录 → 镜像到 `local-repo/`）。

未完成（需要真实环境或额外决策）：
- 打包为可双击安装的桌面产物：`packages/app/src-tauri/` 的 Tauri v2 骨架已入库，
  但**尚未在本仓库编译验证**，构建需要 Rust + MSVC + WebView2 工具链（`npm run icons` 后 `npm run tauri build`）
- MSIX / 归档安装的实机端到端验证
- 真实升级链路与真实安装包的端到端演练
- 开机自启与托盘图标在真实桌面会话下的验收

## 文档与站点

- 架构与 API 文档站（GitHub Pages）：<https://wakawakalululu.github.io/appcenter/>
- 使用与协议说明（Wiki）：<https://github.com/wakawakalululu/appcenter/wiki>
- 变更记录：[CHANGELOG.md](CHANGELOG.md)

## 桌面 UI（packages/app）

`packages/app/web` 是本地 Web 客户端，`packages/app/src/bridge.ts` 把它接到引擎：只监听 127.0.0.1，
`POST /rpc` 走与 CLI 完全相同的 `dispatch` 方法表，`GET /events` 用 SSE 推送任务与托盘状态。

```bash
# 一条命令拉起目录服务 + UI（演示数据）
CATALOG_PORT=7991 UI_PORT=8080 node --experimental-transform-types scripts/ui-demo.mts
# 打开 http://127.0.0.1:8080

# 或者分开跑
npm run server -- --seed
npm run ui
```

界面包含：推荐、分类（含子分类聚合）、搜索、已安装（读本机注册表）、升级与批量升级、
我的申请（提交/取凭证/重试安装）、卸载与残留清理（分段耗时、风险勾选、计划与试运行、CONFIRM 确认串）、
客户端更新、皮肤切换、开机自启、窗口与托盘面板。

## 系统托盘与窗口宿主

不依赖 Electron/Tauri，直接用 Windows 自带的 WinForms 起真实托盘与窗口；
菜单项与状态来自引擎（`ui.tray`），点击菜单把动作回传给 `ui.trayAction`：

```bash
# 先起目录服务 + UI 桥（演示数据）
CATALOG_PORT=8005 UI_PORT=8094 node --experimental-transform-types scripts/ui-demo.mts
# 另开终端：常驻托盘用 TRAY_SECONDS=0，自检用比如 4 秒
UI_PORT=8094 TRAY_SECONDS=4 node --experimental-transform-types packages/app/src/tray.ts
```

开机自启是设置项里用户可见、可关闭的开关（写入 `HKCU\...\CurrentVersion\Run`），不做静默保活。

## 清理备份与撤销

注册表类清理在执行前会导出所属键的 `.reg` 并写 `backup-manifest.json`；没有备份目录会被直接拦截，
导出失败的那一项不会被删除。撤销：

```bash
# 界面里有「从备份撤销」按钮；也可走 RPC
curl -s -X POST http://127.0.0.1:8080/rpc -H "content-type: application/json" \
  -d '{"method":"cleanup.restore","params":{"backupDir":"<上一步返回的目录>"}}'

# 真机自检：自建 HKCU 测试键 → 扫描 → 备份 → 删除 → 还原 → 清理，全程自动
node --experimental-transform-types scripts/verify-cleanup.mts
```

## 许可

[MIT](LICENSE)

# 项目情况固化成果

> 本文档用于**冻结当前项目状态**：记录已交付能力、质量基线、量化指标与已验证/待验证边界。
> 后续演进请以 [roadmap.md](roadmap.md) 为准，新增功能/重构先回 [SRS](../spec/srs.md) 这一唯一对外契约。
>
> 固化基准日：2026-10-08 · 版本线：`0.1.0`（已发布）→ `Unreleased`（当前 HEAD）
> 进度快照（同日起已推进）：**P1-4 审计导出**、**P1-2 审批工作台（后端+前端）** 已交付并测试钉住，见 §3.1。

---

## 1. 一句话定位

**AppCenter** 是面向企业「应用中心 / 软件商店」的**客户端引擎 + 目录服务端**，纯 TypeScript
实现、**零构建步骤**（Node ≥ 24 直接跑 TS）。覆盖软件分发全链路：目录检索、本机已装清单、
卸载残留扫描与清理、断点续传下载与校验、多类型安装执行计划、批量安装与升级、申请审批、
皮肤主题、客户端自升级、系统托盘与多窗口、机群资产心跳。

设计边界（明确不做，见 SRS §5）：行为采集、Web 中间人、锁屏、远程桌面、驱动级进程拦截、
静默保活、软件黑白名单强制下发、多租户 SaaS、移动端、插件市场。

---

## 2. 架构与包划分

依赖只能向下：`cli → app/server → core`。`core` 不 import 任何宿主或网络栈，可在 Linux 上
跑同一套断言。

| 包 | 角色 | 关键模块 |
|---|---|---|
| `packages/core` | 纯领域引擎，无框架依赖 | `facade.ts` 统一入口；`catalog` / `inventory` / `leftover` / `download` / `runner` / `orchestrator` / `upgrader` / `selfupdate` / `localrepo` / `approval` / `theme` / `tray` / `windows` / `runtime` / `heartbeat` |
| `packages/server` | 目录 / 鉴权 / 审计 / 部门目录 / 机群心跳 HTTP 服务 | `main.ts` + SQLite + Range 下载 + extras（运营位/捆绑包/安装回执） |
| `packages/app` | 宿主侧：RPC 桥(SSE) + Web UI + 桌面壳 + WinForms 托盘 | `bridge.ts`（监听 127.0.0.1）、`web/`、`desktop.ts`、`tray.ts`、`src-tauri/`（Tauri v2 骨架，待编译） |
| `packages/cli` | 无头壳：JSON Lines IPC，复用同一张 dispatch 方法表 | `main.ts` |

**可注入端口（可测试性的结构性前提）**：`runner` / `registryKeys` / `webRoot` / `iconsDir` /
`ScanEnv`（环境根）/ `WindowHost` 与托盘宿主全部可注入。注入缝双向钉——注入时只见假数据，
不注入时仍走真实路径（以耗时指纹等可观测量证明真跑了）。

**关键不变量**（来自 `spec/architecture.md`）：按根/按段隔离、实例定位唯一化、名字判据只有一把
（`nameMatchQuality`）、原子写、凭证即边界、本地服务只此一处（回环 + `Origin` 校验）。

---

## 3. 已交付能力（对照 SRS 需求）

下表按 SRS F1–F11 逐条固化。`[完成]`=已交付且被自动化测试覆盖；`[部分]`=已交付但仅部分真机验证。

| 编号 | 能力 | 交付要点 | 状态 |
|---|---|---|---|
| F1 | 目录与检索 | 分类树（子分类聚合）、中文/拼音搜索、贝叶斯评分、运营位、专属应用、捆绑包 | [完成] |
| F2 | 本机已装清单 | HKLM 64/32 + HKCU 卸载项；三卸载根并行；落盘缓存(原子写+TTL)；增量刷新与上一轮指纹合并；同名多实例按 `regDir` 区分 | [完成] |
| F3 | 升级计划 | 与目录共用名字判据；按最低版本同名实例决策；空白版本不参与升级 | [完成] |
| F4 | 残留扫描与清理 | 只读扫描产出计划；注册表类先导出 `.reg` 备份并支持撤销；默认 `dryRun`；文件类可移动回收（非不可逆删除）+ 保留策略；按根隔离进 `gaps` | [完成] |
| F5 | 下载 | Range 断点续传 + `If-Range`；瞬时故障重试；落地失败原地重试不重下整包；`.part`+`.part.json` 续传；sha256+体积双校验 | [完成] |
| F6 | 安装/卸载编排 | 多类型执行计划（MSI/INNO/NSIS/MSIX/归档/脚本）；卸载串正确分词（含空格路径）；MSI 产品码取法；任务终态守护；装后回读注册表确认真实已装版本；成功/失败/异常统一清理安装包 | [完成] |
| F7 | 申请与审批 | 凭证绑定应用**与版本**；有效期不可解析即无效；吊销对已签发生效；申请人不可自报他人身份；驳回结果闭环进通知 | [完成] |
| F8 | 本地应用包仓库 | 目录镜像 + `manifest.json`（含全量目录快照）；`size`+`sha256` 校验；缓存命中不发请求；失败逐包重试；`status` 按磁盘事实重算；离线安装接通（`file://` 复制复用） | [完成] |
| F9 | 自升级 | 发布→检查→暂存→提交四态；应用前校验签名证据；换版由独立进程完成；pending 未 commit 自动回滚备份 | [完成] |
| F10 | UI 与皮肤 | 皮肤=token 覆盖表，缺省回落显式记录；托盘状态机与菜单；多窗口与单实例锁；窗口生命周期可回收；Web UI 三层同源（浏览器/桌面 `--app` 窗口/Tauri 骨架） | [完成] |
| F11 | 心跳与机群汇总 | 客户端上报资产摘要（收敛在软件清单内，不采集终端行为）；服务端幂等 upsert + 时序快照剪枝；离线判定 `?staleAfterHours`；`/api/admin/fleet` 全局与单机视图 | [完成] |

### 服务端安全与运营能力
- 鉴权：由单一静态令牌升级为「用户 / 角色令牌」，库内只存令牌哈希；管理员操作校验角色。
- 审计：关键管理动作写入 `audit_log`。
- 部门目录：支持按部门下发可见范围。
- extras：运营位、捆绑包、安装回执、Range 下载、心跳机群侧。

### 运营治理能力（P1 推进成果 · 已交付并测试钉住）

以下为 P1 运营闭环中**已落地**的能力（非仅设计），均含服务端 + 回归测试，前端视图逻辑已接入（真实桌面渲染验收见 §6 待验证）。

| 能力 | 端点 / RPC | 交付要点 | 测试 |
|---|---|---|---|
| P1-4 审计导出 | `GET /api/admin/audit`、`GET /api/admin/audit/export?format=csv\|json` | 按时间窗 / action 子串 / actor 过滤、分页；CSV 严格转义（逗号/引号/换行）；`extras.ts` 的 banners / bundles 写入已补 `recordAudit`，消除「关键动作不漏记」 | `server/test/audit.test.ts`（6） |
| P1-2 审批工作台 | `approval.listAll` / `approval.decide` / `approval.revoke`；`POST /api/approvals/:id/revoke` | 管理员全量工单（投影补全 `appVersion`/`applicant`/`decidedBy`/`expiresAt`）；受理/驳回/吊销闭环；吊销使已发凭证失效并写审计；**修正 `approvalRequests()` 改以服务端为权威源**（管理员已批准/驳回状态回流，根治「我的申请」长期停在 pending） | `server/test/approvals-admin.test.ts`（5） |

> 注：P1-1 机群运营面板、P1-3 部门目录治理的数据通路均已就绪（端点/facade/dispatch/类型齐备），尚未补管理端视图，列为 roadmap 后续项。

---

## 4. 质量基础设施（CI 强制门禁）

`npm run ci` 顺序串起以下门禁；任一红线即拒合（[CONTRIBUTING.md](../CONTRIBUTING.md) 详述）。

| 门禁 | 命令 | 判据 |
|---|---|---|
| 静态检查 | `npm run typecheck` | `tsc -p tsconfig.json` 全仓严格 |
| 脚本类型 | `npm run check:scripts` | 脚本同样走 `tsc` 范围检查 |
| **Emoji 基线** | `npm run check:emoji` | 全仓文本源零 emoji，Web UI 零字符图形图标（一律内联 SVG）；违规即红 |
| 文档引用落地 | `npm run check:links` | 公开文档/Web 根/wiki 的本地引用必须能在发布树落地 |
| 依赖许可自审 | `npm run check:licenses` | 直接依赖 license 须在宽松白名单；缺字段或含 copyleft 即拒 |
| 覆盖只增不减 | `npm run check:coverage` | 比较父提交测试文件数，下降即红并点名；浅克隆也算红 |
| 提交信息禁词 | `npm run check:commits` | 提交信息禁词表与文件级同尺，由测试钉住 |
| 单测/集成 | `npm test` | 引擎/服务端/bridge/图标/端到端；CI 另断言**用例数下限**（防 `node --test` glob 退化到 0 条仍绿） |
| 冒烟 | `npm run smoke` | 真机注册表清单扫描 + CLI IPC 链路 |
| 演示与截图 | `npm run demo` / `npm run shots` | 本地复现 CI 截图产物（fresh 皮肤 1237×762） |

CI 双 job 均跑 `windows-latest`（注册表/托盘/GDI+ 图标为 Windows 专属），同分支并发取消 +
job 级 `timeout-minutes`；截图 artifact 保留 14 天。另有 `check:delivery` 列出未 `git add` 的文件，
防止漏提交导致 CI 假绿。

---

## 5. 量化指标（基准日实测）

| 指标 | 数值 |
|---|---|
| 源码 TS 文件数（packages，不含测试） | 47 |
| 源码总行数（packages，不含测试） | ~10,085 |
| 测试文件数 | 92（+2：`audit.test.ts` / `approvals-admin.test.ts`） |
| `test()` 用例调用（含嵌套） | ~455 |
| 规格 + Wiki 文档 | 636 行（4 份 spec + 6 份 wiki） |
| 对外 RPC 方法 | 11 组、60+ 方法（见 `spec/interfaces.md`） |
| 交付版本 | `0.1.0`（2026-10-06）+ `Unreleased` |

> 注：CHANGELOG `Unreleased` 段落标注「137 项自动化测试全部通过」，而当前 HEAD 实测
> `test()` 调用约 451（含嵌套子测试），二者口径不同（前者为顶层用例/里程碑计数）。
> 以 `npm test` 实际通过数为准；门禁已断言用例数下限，不会退化成零用例仍报绿。

---

## 6. 已验证 vs 待验证（明确边界）

### 已通过自动化验证（含真机取证）
- 真机注册表清单（141 个应用）：缓存命中 1ms；过期增量刷新 ~1.3s（原逐子键点查 ~6.0s/174 次进程启动）。
- 右键菜单残留扫描提速：854ms → 193ms（CLSID 有界并发解析），整段 ~1.3s → ~0.76s。
- 版本比较四段支持：修正 `12.1.0.28488` vs `12.1.0.30100` 等误判。
- 计划任务残留 UTF-16LE BOM 解码：真机 221 个 `System32\Tasks` 文件此前命中 0 个，现已能检出。
- 装后版本回读去臆测：`resolveInstalledVersion` 只在唯一命中或用请求版本唯一定位时回读。
- 本地仓库：落盘与清单结构、缓存命中不发请求、失败重试累计、status 按磁盘重算、sha256 识破篡改、
  真 HTTP 端到端镜像与全版本落盘。

### 待真机/决策验证（来自 README「未完成」清单）
- [待办] 桌面产物打包：Tauri v2 骨架已入库，**尚未在本仓库编译验证**（需 Rust + MSVC + WebView2）。
- [待办] MSIX / 归档安装的实机端到端验证。
- [待办] 真实升级链路与真实安装包的端到端演练。
- [待办] 开机自启与托盘图标在真实桌面会话下的验收。
- [待办] **前端管理视图的真实桌面渲染验收**：P1-4 审计导出、P1-2 审批工作台的 Web 视图逻辑已落地并通过后端契约测试，但「审批工作台」「机群面板」等管理端页面尚未在真实桌面窗口（`--app` 壳或 Tauri）下做交互验收（属 P0-5 缺口的延伸）。

---

## 7. 关键设计决策记录（已落定，不可静默回退）

1. 引擎与 UI 分离：`@appcenter/core` 纯逻辑，UI 宿主只需实现 `WindowHost` + 订阅 `onJob`。
2. 注册表读写分级：读取走 `reg.exe` 只读查询；任何写入/删除只发生在显式清理计划，且须同时满足
   风险勾选 + 路径在 `allowWriteRoots` + 确认串正确；`C:\Windows`、盘根、白名单外一律拒绝，默认 `dryRun`。
3. 下载即校验：`sha256`+`sizeBytes` 缺失不得落地；校验不过不进安装态。
4. 审批是安装前置闸门：未拿有效凭证停在 `awaiting_approval`，不会先下载再拦；密钥不内置客户端。
5. 自升级可回滚：pending 未 commit 视为新版没起，自动回滚备份。
6. 皮肤是 token 而非散落色值：`validateTokens` 不通过即拒绝。
7. 审批状态以服务端为权威源：`approvalRequests()` 不再只读本机内存，拉取服务端工单并回流本地工作流，使管理员已批准/驳回的状态不再长期停在 pending（根治「我的申请」幽灵态）。

以上均由回归用例钉住；改动把它们放开会让测试变红（如 `facade-host-safety`、`emoji-gate-scope`、
`local-dir-guard`、`cleanup-guard` 等）。

---

## 8. 文档资产清单

- 对外契约（P4 单向阀，先回这里）：`spec/srs.md`、`spec/architecture.md`、`spec/interfaces.md`、`spec/data-model.md`
- 使用与协议说明：`wiki/`（Home / Getting-Started / Server-API / RPC-Protocol / Architecture / FAQ / _Sidebar）
- 站点：`docs/*.html`（index / architecture / server / rpc / contributing）、`docs/assets/`
- 仓库根：`README.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、`LOCAL-REPO.md`、`LICENSE`

---
*本文档为状态快照，不替代 SRS。任何功能增删请先更新 SRS 与 CHANGELOG，再据此推进 [roadmap.md](roadmap.md)。*

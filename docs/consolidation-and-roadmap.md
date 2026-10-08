# 成果固化与后续推进文档

> 范围：AppCenter 项目（企业应用中心 / 软件商店客户端引擎 + 目录服务端）。
> 目的：系统性总结已完成工作，归档沉淀关键交付物、技术方案与经验教训；给出下一阶段的阶段划分、
> 里程碑、责任分工与时间安排；确保成果**可复用、可追溯**。
>
> 配套详档：[project-status.md](project-status.md)（成果固化快照）、[roadmap.md](roadmap.md)（推进路线），
> 对外契约为 [spec/srs.md](../spec/srs.md)、[spec/architecture.md](../spec/architecture.md)、
> [spec/interfaces.md](../spec/interfaces.md)、[spec/data-model.md](../spec/data-model.md)。

| 项 | 内容 |
|---|---|
| 文档版本 | v1.0 |
| 编制日期 | 2026-10-08 |
| 基线 | `0.1.0`（2026-10-06 已发布）→ `Unreleased`（当前 HEAD） |
| 数据口径 | 源码/测试/文档规模为编制日实测；真机读数为历史取证值 |
| 维护约定 | 需求/接口变更**先**更新 SRS 三件套 → CHANGELOG → 再合入（P4 单向阀） |

---

## 1. 成果概述

### 1.1 项目定位与目标

AppCenter 是面向企业「应用中心 / 软件商店」的**客户端引擎 + 目录服务端**：纯 TypeScript、**零构建**
（Node ≥ 24 直接跑 TS），覆盖软件分发全链路——目录检索、本机已装清单、卸载残留扫描与清理、
断点续传下载与校验、多类型安装执行计划、批量安装与升级、申请审批、皮肤主题、客户端自升级、
系统托盘与多窗口、机群资产心跳。

阶段目标（本阶段）：**把软件分发全链路的逻辑做对、做全、并被自动化测试钉死**，同时建立可运营
的服务端底座与三条同源的客户端外壳。

设计边界（明确不做，见 SRS §5）：行为采集、Web 中间人、锁屏、远程桌面、驱动级进程拦截、静默保活、
软件黑白名单强制下发、多租户 SaaS、移动端、插件市场。

### 1.2 目标达成情况

| 目标 | 达成 | 证据 |
|---|---|---|
| SRS 功能需求 F1–F11 全覆盖 | **11/11 [完成]** | 见 [project-status.md §3](project-status.md) 映射表 |
| 端到端软件分发链路（下载→校验→安装→回读） | [完成] 逻辑闭环 | `install-lifecycle` / `installer-paths` / `install-version` 等用例 |
| 卸载残留扫描与安全清理 | [完成] 只读扫描 + 备份 + `dryRun` + 回收 | `residue*` / `cleanup-guard` / `recycle-retention` 等 |
| 申请审批前置闸门 | [完成] 凭证即边界 | `approval-workflow` / `approval-grant-scope` |
| 本地应用包仓库与离线安装 | [完成] 接通 | `repo*` / `install-offline` |
| 客户端自升级可回滚 | [完成] 四态 + 回滚备份 | `selfupdate-apply` / `selfupdate-swap` |
| 机群资产心跳与汇总 | [完成] 服务端侧 | `heartbeat` 用例 + `/api/admin/fleet` |
| 质量门禁全链路 | [完成] CI 强制 | `npm run ci` + CI 三作业 |
| 运营治理：审计导出（P1-4） | [完成] 已交付 | `server/test/audit.test.ts`（6） |
| 运营治理：审批工作台（P1-2） | [完成] 已交付（前端视图待真机验收） | `server/test/approvals-admin.test.ts`（5） |
| 真机「双击即用」成品交付 | [待办] **未达成**（P0 硬门槛） | 见 §4 风险 R2 |

**结论**：逻辑与治理能力已可信并测试钉住；**唯一未达成的是目标环境下的真机端到端闭环**（P0），
构成下一阶段的最高优先项。

### 1.3 核心指标（编制日实测）

| 指标 | 数值 | 说明 |
|---|---|---|
| 源码 TS 文件数（不含测试） | 47 | packages 下 |
| 源码总行数（不含测试） | ~10,085 | |
| 测试文件数 | **92** | 本阶段新增 `audit.test.ts`、`approvals-admin.test.ts` |
| `test()` 用例调用（含嵌套） | ~455 | CI 另断言用例数**下限**（`check-test-count.mjs 100`） |
| 规格 + Wiki 文档 | 636 行 | 4 份 spec + 6 份 wiki |
| 对外 RPC 方法 | 11 组、60+ 方法 | `spec/interfaces.md` |
| CI 作业 | 3（Windows 全链 / Linux 平台无关 / 合规） | `.github/workflows/ci.yml` |
| 交付版本 | `0.1.0` + `Unreleased` | 语义化版本 |

---

## 2. 固化内容清单

> 本节回答「沉淀了什么、在哪里、如何复用」。所有路径均相对仓库根。

### 2.1 流程规范（可复用的协作规程）

| 规范 | 载体 | 要点 |
|---|---|---|
| **P4 单向阀** | [CONTRIBUTING.md](../CONTRIBUTING.md) + spec 目录 | 需求/接口变更先改 SRS → CHANGELOG，再改代码 |
| 提交前检查 | CONTRIBUTING.md §提交前检查 | `npm run ci` 干净；新增行为补测试；`check:delivery` 防漏 `git add` |
| 提交信息规范 | CONTRIBUTING.md §提交信息 | 语义化前缀 `feat/fix/docs/refactor/test/chore`；正文写「为什么」；禁词由 `check-commit-msg.mjs` 拦 |
| CI 门禁 | [package.json](../package.json) `scripts.ci` + `ci.yml` | 见 §2.3 |
| 设计约束 | CONTRIBUTING.md §设计约束 | 引擎与 UI 分离、副作用可注入、默认安全 |
| 完成定义（DoD） | 本文档 §3.5 | 落库、测试、文档、CHANGELOG 四齐 |

### 2.2 代码资产（架构与模块）

依赖方向只向下：`cli → app/server → core`。`core` 不 import 任何宿主或网络栈，可在 Linux 跑同一套断言。

| 包 | 角色 | 关键模块 |
|---|---|---|
| `packages/core` | 纯领域引擎，零框架依赖 | `facade.ts`（统一入口）、`catalog`、`inventory`、`leftover`、`download`、`runner`、`orchestrator`、`upgrader`、`selfupdate`、`localrepo`、`approval`、`theme`、`tray`、`windows`、`runtime`、`heartbeat` |
| `packages/server` | 目录/鉴权/审计/部门目录/机群心跳 HTTP 服务 | `main.ts`、`server.ts`（CatalogDb + API）、`auth.ts`、`audit.ts`（本阶段新增）、`extras.ts`（运营位/捆绑包/回执/心跳侧），SQLite + Range 下载 |
| `packages/app` | 宿主侧：RPC 桥(SSE) + Web UI + 桌面壳 + WinForms 托盘 | `bridge.ts`（监听 127.0.0.1）、`src/dispatch.ts`、`web/`（`index.html`/`app.js`/`app.css`）、`desktop.ts`、`tray.ts`、`src-tauri/`（Tauri v2 骨架，待编译） |
| `packages/cli` | 无头壳：JSON Lines IPC，复用同一张 dispatch 方法表 | `main.ts` |

**关键不变量**（架构契约，改动会触发回归变红）：按根/按段隔离、实例定位唯一化、名字判据只有一把
（`nameMatchQuality`）、原子写、凭证即边界、本地服务只此一处（回环 + `Origin` 校验）。

**可注入端口**：`runner` / `registryKeys` / `webRoot` / `iconsDir` / `ScanEnv` / `WindowHost` / 托盘宿主
全部可注入——是可测试性的结构性前提。

### 2.3 配置标准（工程基线）

| 类别 | 标准 | 载体 |
|---|---|---|
| 运行时 | Node ≥ 24；`type: module`；零构建（`--experimental-transform-types`） | `package.json` |
| 工作区 | npm workspaces：core / server / cli / app | `package.json` |
| 类型检查 | 全仓 `tsc -p tsconfig.json`；脚本 `tsc -p tsconfig.scripts.json` | `tsconfig*.json` |
| 门禁脚本 | `check:emoji` / `check:links` / `check:licenses` / `check:coverage` / `check:commits` / `check:delivery` | `scripts/*.mjs` |
| 许可策略 | 直接依赖 license 须在宽松白名单，缺字段或含 copyleft 即拒 | `scripts/check-licenses.mjs` |
| 忽略产物 | `local-repo/`、`*.db`、`*.log`、`.shots/` | `.gitignore` |
| CI 结构 | verify(Windows 全链) + verify-linux(平台无关) + 合规作业；同分支并发取消；作业级 timeout | `.github/workflows/ci.yml` |

`npm run ci` 顺序：`typecheck → check:scripts → check:emoji → check:links → check:licenses → test → smoke`。

### 2.4 知识库与文档资产

| 类别 | 文件 |
|---|---|
| 对外契约（P4 单向阀） | `spec/srs.md`、`spec/architecture.md`、`spec/interfaces.md`、`spec/data-model.md` |
| 使用与协议 | `wiki/`（Home / Getting-Started / Server-API / RPC-Protocol / Architecture / FAQ / _Sidebar） |
| 站点 | `docs/*.html`（index / architecture / server / rpc / contributing）、`docs/assets/` |
| 仓库根文档 | `README.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、`LOCAL-REPO.md`、`LICENSE` |
| 本阶段新增 | `docs/project-status.md`、`docs/roadmap.md`、本文档；`LOCAL-REPO.md`（本地仓库说明） |

### 2.5 数据与样例资产

| 资产 | 说明 | 位置 |
|---|---|---|
| 演示目录与封装 | `seedDemo` + `materializeDemoPackages`（确定性生成真实包并回写真 sha256/体积） | `packages/server` |
| 真机取证读数 | 清单缓存命中、增量刷新、残留提速、版本比较修正、计划任务编码 | `CHANGELOG.md` 记录 |
| 截图产物 | fresh 皮肤 1237×762（本地 `npm run shots` 复现 CI 产物） | `.shots/`（gitignore） |
| 本地仓库镜像 | `LocalRepo` 目录镜像 + `manifest.json` | 运行时产物 |

### 2.6 本阶段新增交付（需一并归档）

| 交付 | 代码 | 测试 | 文档 |
|---|---|---|---|
| **P1-4 审计导出** | `packages/server/src/audit.ts`；`server.ts` 两端点；`extras.ts` 补 banners/bundles 审计 | `audit.test.ts`（6） | CHANGELOG + 本文档 |
| **P1-2 审批工作台** | `server.ts`（admin 全量列表 + `revoke` 端点 + 工单投影）；`remote.ts` / `facade.ts` / `dispatch.ts` admin 动作；`facade.approvalRequests` 回源；`web/index.html` + `web/app.js` 工作台视图 | `approvals-admin.test.ts`（5） | CHANGELOG + 本文档 |

---

## 3. 后续推进计划

### 3.1 阶段划分

| 阶段 | 主题 | 出口（Gate） |
|---|---|---|
| **P0 真机端到端闭环** | 让核心链路在真实 Windows 环境跑通一次 | P0-1~P0-5 全有真机验收记录 + 回归用例进 `npm test` |
| **P1 可运营闭环** | 补齐运营/治理闭环，可长期用 | 机群面板、部门治理视图交付；审计/审批已交付 |
| **P2 工程化与体验** | 覆盖率、跨平台、性能预算、a11y | 各专项达阈值且不破坏现有门禁 |

（P1-4 审计导出、P1-2 审批工作台**已完成**；P1-1 机群面板、P1-3 部门目录治理数据通路已就绪，仅缺管理端视图。）

### 3.2 里程碑节点

| 里程碑 | 内容 | 交付物 | 验收标准 | 依赖 |
|---|---|---|---|---|
| **M0 基线固化** | 本次成果归档 | 本文档 + `project-status.md`/`roadmap.md` + CHANGELOG | 文档与代码一致；`npm run ci` 绿 | 无 |
| **M1 工具链就绪** | Rust/MSVC/WebView2 + 测试机与真实安装包样本 | 工具链清单、样本库 | Tauri 可编译；样本含 MSIX 一例 | 环境申请 |
| **M2 桌面产物** | Tauri v2 换壳 + 打包 | 自有 exe / 安装包 | 窗口渲染、RPC 桥连通 | M1 |
| **M3 真机分发闭环** | P0-2/P0-3/P0-4 演练 | 真机验收报告 + 回归用例 | 下载/校验/安装/回读/升级链路真机通过 | M2 |
| **M4 桌面体验验收** | P0-5 + 管理视图真机验收 | 托盘/自启/审批工作台/机群面板验收 | 真实桌面会话下交互正确 | M2 |
| **M5 运营闭环达标** | P1-1 机群面板、P1-3 部门治理视图 | 管理端视图 + 回归用例 | 看板数据正确、越权 fail-closed | M2 |
| **M6 版本发布** | `Unreleased` → `0.2.0` | CHANGELOG 切版 + tag | DoD §3.5 全满足 | M3/M4/M5 |

### 3.3 责任分工（角色制，人员由项目组指派）

| 角色 | 职责 | 主责里程碑 |
|---|---|---|
| 引擎负责人（Core） | 领域逻辑、可注入端口、引擎回归 | M3 真机链路 |
| 服务端负责人（Server） | 目录/鉴权/审计/审批/机群 API | M5 运营闭环 |
| 客户端负责人（App/UI） | Web UI、桌面壳、托盘、管理视图 | M2/M4/M5 |
| 质量与发布（QA/Release） | CI 门禁、真机验收用例、版本发布 | M1/M3/M6 |
| 产品/运营（PM/Ops） | 需求优先级、部门目录策略、部署拓扑决策 | M0/M5/M6 |

> 建议每项 P0/P1 任务设「主责 + 备份」两人，避免单点；跨包改动由引擎负责人做接口评审。

### 3.4 时间安排（相对周次，具体日期由项目组确认）

| 周次 | 里程碑 | 关键活动 |
|---|---|---|
| W1 | M0 | 成果归档、门禁复核、工具链与样本申请 |
| W2–W3 | M1 | 工具链就绪；Tauri 首次编译 |
| W3–W4 | M2 | 换壳 + 打包 + 桌面窗口打通 |
| W4–W6 | M3 | 真实包端到端 + MSIX/归档 + 升级链路演练 |
| W5–W7 | M4/M5 | 托盘/自启验收；机群面板、部门治理视图（可与 M3 并行） |
| W8 | M6 | 切版 `0.2.0`、CI 全绿、发布 |

> 说明：M3 与 M4/M5 可部分并行（后者多为平台无关代码）；P2 专项贯穿进行，不占用里程碑主窗口。

### 3.5 完成定义（DoD / 出口准则）

一项工作视为「完成」当且仅当满足：

1. **代码**：实现落地并通过 `npm run typecheck` + `npm run check:scripts`；
2. **测试**：新增行为有对应自动化用例，`npm test` 全绿且用例数不低于门禁下限；
3. **文档**：SRS/接口/数据模型（若涉及契约）已同步，`CHANGELOG` 已记录；
4. **门禁**：`npm run ci` 干净（含 emoji/链接/许可）；
5. **真机（P0/P1 项）**：有真机验收记录，且回归用例已进 `npm test`。

---

## 4. 风险与应对措施

| 编号 | 风险 | 类别 | 概率 | 影响 | 等级 | 应对措施 | 预警信号 |
|---|---|---|---|---|---|---|---|
| R1 | 工具链缺位（Rust/MSVC/WebView2）致桌面产物无法产出 | 环境 | 中 | 高 | **高** | 提前申请并锁定版本；保留 `--app` 窗口方案作降级路径 | M1 前未就绪 |
| R2 | 真机验证缺口：安装/升级/自升级的「真实路径」未跑过 | 质量 | 高 | 高 | **高** | 建立真实安装包样本库；把真机验收用例纳入 `npm test`；不做「模拟器即通过」的结论 | 长期只有 `SimulatedRunner` |
| R3 | 许可白名单收紧，引入新依赖被 `check:licenses` 拒 | 合规 | 中 | 中 | 中 | 新增依赖前先确认白名单；优先零依赖实现 | CI 许可作业变红 |
| R4 | 文档/代码漂移（改代码未回流 SRS/CHANGELOG） | 流程 | 中 | 中 | 中 | 严格执行 P4 单向阀；里程碑评审核对一致性 | 评审发现契约与实现不符 |
| R5 | 演示数据以占位为主，真实包未入库致链路「假跑」 | 质量 | 中 | 中 | 中 | `materializeDemoPackages` 保证 demo 真跑；真实样本单独归档 | 演示无法复现真实边界 |
| R6 | 前端管理视图缺乏真实桌面渲染验收 | 质量 | 中 | 中 | 中 | 纳入 M4 验收；桌面壳下走查审批工作台/机群面板 | 仅后端契约测试通过 |
| R7 | 用例数门禁退化（glob 匹配不到 → 仍绿） | 工程 | 低 | 高 | 中 | 已有 `check-test-count` 下限 + `check:coverage` 跨提交比较双保险 | 测试骤降但门禁绿 |
| R8 | 关键人员单点 | 组织 | 中 | 中 | 中 | 每任务主责+备份；知识库沉淀到 spec/wiki | 假期/交接期无替补 |

---

## 5. 跟踪与复盘机制

### 5.1 指标看板（过程 + 结果）

| 维度 | 指标 | 目标 | 采集 |
|---|---|---|---|
| 质量 | `npm run ci` 通过率 | 100% | CI |
| 质量 | 测试文件数（只增不减） | 单调不减 | `check:coverage` |
| 质量 | 真机验收用例数 | 随 P0/P1 递增 | `npm test` |
| 交付 | 里程碑按期率 | ≥ 目标 | 里程碑评审 |
| 运营 | 管理视图可用项 | P1-1/P1-3 达成 | M5 验收 |
| 合规 | 许可/emoji/链接门禁 | 全绿 | CI |

### 5.2 跟踪节奏

| 周期 | 形式 | 内容 |
|---|---|---|
| 每日 | 站会 / 提交 | 阻塞同步；每个 PR 必须 `npm run ci` 绿 |
| 每周 | 周会 | 看板走查、风险登记册刷新、下周计划 |
| 每里程碑 | 评审（M0–M6） | 对照出口准则与 DoD，签核进入下一里程碑 |
| 每季度 | 复盘 | 成果/教训归档，更新本推进文档 |

### 5.3 变更控制

- 契约变更走 **P4 单向阀**：SRS 三件套 → CHANGELOG → 代码；
- 版本语义化：功能增量切 minor（如 `0.2.0`），修缺陷切 patch；
- 门禁只增不减（`check:coverage` 结构上强制）。

### 5.4 追溯矩阵（需求 → 代码 → 测试 → 文档）

| 需求 | 代码 | 测试 | 文档 |
|---|---|---|---|
| F1–F11 | `packages/core/*` + `packages/server/*` | `packages/**/test/*.test.ts` | `spec/srs.md` + `wiki/` |
| P1-4 审计导出 | `server/src/audit.ts`、`server.ts` | `server/test/audit.test.ts` | CHANGELOG + 本文档 |
| P1-2 审批工作台 | `server.ts`、`remote.ts`、`facade.ts`、`dispatch.ts`、`web/` | `server/test/approvals-admin.test.ts` | CHANGELOG + 本文档 |

> 追溯路径：`SRS 条目 → facade/RPC 方法名 → 测试用例标题 → CHANGELOG 条目`，四者可相互检索。

### 5.5 复盘模板（每次里程碑后填写）

1. **目标 vs 结果**：计划交付 vs 实际交付，偏差与原因；
2. **做对了什么**：可复用的做法（沉淀到规范/知识库）；
3. **做错了什么**：问题根因，是否触发风险登记册项；
4. **改进项**：下一阶段的具体行动（负责人 + 期限）；
5. **指标变化**：关键指标前后对比。

---

## 附录：术语与参考

- **P0/P1/P2**：本推进计划的阶段编号（真机闭环 / 可运营闭环 / 工程化）。
- **P4 单向阀**：需求变更只能「规格 → 代码」单向流动的流程约束。
- **门禁（Gate）**：CI 中任一红线即拒合的检查项集合。
- **参考**：[project-status.md](project-status.md)、[roadmap.md](roadmap.md)、[spec/srs.md](../spec/srs.md)、
  [CONTRIBUTING.md](../CONTRIBUTING.md)、[CHANGELOG.md](../CHANGELOG.md)、[README.md](../README.md)。

---
*本文档为成果固化与推进的总纲，随里程碑滚动更新；每次状态变更请同步 [project-status.md](project-status.md) 与 [CHANGELOG.md](../CHANGELOG.md)。*

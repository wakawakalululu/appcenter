# Changelog

本项目遵循语义化版本（semver）。

## Unreleased

### 引擎（packages/core）

- 机群资产心跳：客户端把「本机目录应用的安装态摘要」（应用 id / 版本、可升级、待审批、计数）上报服务端，供管理端统计覆盖率与到达率。上报面严格收敛在软件清单内，不采集任何终端行为数据。
- 定时检查在升级 / 通知之后附带一次心跳上报；上报失败独立吞掉，不污染检查状态（`ScheduleState.lastHeartbeatAt` 可见）。
- 已装清单刷新改为「与旧缓存合并」：过期时按每根一次递归批处理重扫，再与上一轮缓存按指纹合并（未变对象复用、变更取新值、消失即视为卸载），并在整体读空时保留最后已知清单，不会因一次读失败把列表清空。
- 修正清单缓存指纹键：由 regDir 叶子改为完整 canonical 路径，避免同名叶子在 HKLM 64/32 与 HKCU 之间相互覆盖。
- 真机取证（141 个应用）：首屏命中缓存 1ms；过期刷新从逐子键点查的 ~6.0s（174 次进程启动）收敛为每根一次递归的 ~1.3s，与冷扫描同量级且结果与全量一致。
- 右键菜单残留扫描提速：真机归因（`npm run measure:contextmenu`）显示该段 ~0.8s 的 78% 来自「逐个 CLSID 串行递归解析」的 fan-out，而非五个挂载根的递归。改为两趟——先按原序收集候选并汇总去重的唯一 CLSID、有界并发解析，再按完全相同的顺序出结果。实测该段 854ms → 193ms，单应用整段残留扫描 ~1.3s → ~0.76s，命中判定 / 去重 / 顺序不变。
- 右键菜单残留去重修正：命中项此前以 `(挂载根, 值名)` 去重，会把同一挂载根下两个都把 CLSID 写进 `(Default)` 的处理子键吞成一个（漏报）。改按「处理子键路径 + 值名」这一真实残留身份去重后，同根多个命中处理程序都能报出；不误删、只增不漏。
- 装后版本回读去臆测（P3 安全子集）：`readInstalledVersion` 之前用 `.find()` 按 displayName 取首条，真机存在同名多条（如 `Universal CRT Redistributable` 有 10.0.26624 与 10.1.26100.7705 两条），会把「装上了哪个版本」读成别的实例的版本。改为纯函数 `resolveInstalledVersion`：只在唯一命中或用请求版本唯一定位时才回读，多义且无法定位时判为未命中；升级前置改用 `selectPriorInstall` 取同名里版本最高的一条。真机测量（`npm run measure:readback`）同时表明大小写/空白归一化对本机 0 额命中，故不做模糊匹配以免误判。
- 版本比较支持 Windows 的四段版本号：`compare` 此前只比前三段，会把仅第四段不同的版本判为相等——`12.1.0.28488` vs `12.1.0.30100`、`6.9.1.868` vs `6.9.1.9999`、VC++ `14.40.x` vs `14.42.x` 都会被误判「无需升级」。改为按完整数字核心逐段比较（缺段补零），并保留预发布/构建元数据规则。这条同时修正了目录联表的「可升级」判定、升级计划排序、自升级版本闸门与上面的回读取最高。
- 计划任务残留按 BOM 正确解码（真机取证的严重漏报）：真机 `System32\Tasks` 里 221 个任务定义文件全部是 UTF-16LE（BOM `FF FE`），而残留扫描固定按 UTF-8 读文本，`"<Task"` 命中 0 个——等于整类高风险的「计划任务残留」在真机上从不触发。新增按 BOM 识别编码的 `decodeTextWithBom`（UTF-16LE/BE/UTF-8-BOM），文件读取统一走它；端到端测试断言 UTF-16LE 任务残留现能被检出。

### 服务端（packages/server）

- 新增 `POST /api/heartbeat`：按 machineId 幂等 upsert，只保留每台机器最近一次摘要与首末上报时间。
- 新增 `GET /api/admin/fleet`：管理员鉴权，返回逐机记录与全局计数（在册机器 / 已装 / 可升级 / 待审批）。
- 心跳时序留存：每次上报追加一条计数快照，按机器保留最近 100 条并自动剪枝。
- 离线判定：`GET /api/admin/fleet` 支持 `?staleAfterHours=`（默认 24h），逐机返回 `stale` / `lastSeenAgeMs`，`totals` 增加 `stale` 计数。
- 新增 `GET /api/admin/fleet/:machineId`：单机详情（最近快照 + 时序历史，按上报时间倒序）。

### 引擎（packages/core）

- 本地应用包仓库（`localrepo/repo.ts`）：`LocalRepo.sync` 把目录里所有应用的安装包（默认最新版，`allVersions` 可选全部历史）经断点续传下载、sha256+体积双校验后持久化到 `<root>/<appId>/<version><ext>`，并生成自描述 `manifest.json`（逐包索引 + 全量目录快照）；缓存命中跳过下载、失败逐包记录下一轮自动重试（`attempts` 累计）、`status` 按磁盘事实重算 saved/failed/pending、清单原子写。`verify:"sha256"` 档位可识破同长度篡改的缓存文件。相对 `downloadUrl` 由 facade 以 `serverUrl` 补全。
- `facade` 新增 `syncLocalRepo` / `localRepoStatus`；`installMode: silent | manual` 贯通 types → apps 表（旧库自动补列）→ 视图 → RPC：手动安装的执行计划剥掉静默参数（MSI 只留 `/i`+包路径、NSIS/Inno 弹向导，卸载语义不变）。

### 服务端（packages/server）

- 新增 `materializeDemoPackages(db, packageRoot)`：把演示目录每个版本物化成确定性生成的真实安装包文件并回写真 sha256/体积，让「下载 → 续传 → 校验 → 落地 → 入清单」整条链路在 demo/测试里可真跑。

### 宿主与工具

- **Emoji 基线（CI 强制）**：`scripts/check-emoji.mjs` + `npm run check:emoji`——全仓文本源零 emoji，Web UI 源额外禁止字符图形当图标（星形、叉形、等号、放大镜、方框、下载符等字符码点在禁列，箭头 U+2192 保留给文案）；基线当前为零违规，CI verify 阶段跑红即拒合。
- UI 图标全面内联 SVG 化：顶栏返回/菜单/下载/最小化/最大化/关闭、搜索放大镜、空态图形、评分星标（实心/描边两态）全部改为矢量图标，跨平台渲染一致且可随皮肤取色。
- Pages 站点专业化：首页嵌入实拍截图与画廊、新增「设计对标」章节（VS Code 文档结构 / Microsoft Store 布局 / Ant Design token 化 / Tauri 轻量分发 / Homebrew 清单思想）、测试数与已交付能力刷新（141 项→218 项随并行工作流推进）、全站 favicon；架构页以 Mermaid 嵌入总览图/安装状态机/按钮决策树。
- CI：verify 阶段新增「Emoji baseline」独立步骤；截图 artifact 增加保留期（14 天）。
- 桌面壳契约补齐：`waitForPort` TCP 探测替代日志字面匹配、`session.close()` 回收目录服务与浏览器 profile、`serverEntry/workarea/envExtras` 可注入（生命周期测试可注入假服务端）；`npm test` 加 `--test-force-exit` 收口持有 OS 句柄的测试进程。

- 桌面应用窗口（`packages/app/src/desktop.ts`，`npm run desktop`）：一条命令拉起目录服务 + 引擎 + 桥并打开 Edge/Chrome `--app` **独立桌面窗口**——无标签页/地址栏、任务栏独立图标、品牌 favicon 作窗口图标，窗口初始几何取工作区的 60.4% × 66.1%（最小 900×600，居中），独立 user-data-dir 不复用日常浏览器会话；`?shell=app` 时 UI 隐藏自绘窗口控制按钮交给 OS 标题条。作为「网页 → 桌面端」迁移的第 2 层，Tauri（第 3 层）待 Rust 工具链就绪后换壳即可，UI 代码三层同源。
- bridge 新增 `/favicon.svg` 品牌图标（云 + 购物袋，自绘原创），`index.html` 挂 `<link rel="icon">`。
- dispatch 新增 `heartbeat.report`、`fleet.summary`（支持 `staleAfterHours`）与 `fleet.detail`，Web 桥与 CLI 同源可用。
- dispatch 新增 `repo.sync` / `repo.status`；CLI 新增 `repo-sync [--all-versions] [--dir=PATH]` 与 `repo-status`；设置页新增「本地应用包仓库」卡片（同步最新版/全部版本、状态盘点、逐包路径清单）。
- 首屏骨架屏：banner 与分类卡在数据到达前给 shimmer 占位（`prefers-reduced-motion` 下停用动画）。
- 生成式演示图标路由 `/icons/gen/<seed>.svg`（哈希色相 + 首字母瓷贴）；行内按钮三态语义（打开/一键安装▾/手动安装）、行名称区可点开详情、必备应用条无标签图标墙、细滚动条。
- 新增 `scripts/capture-window.ps1`：按窗口标题 PrintWindow 截真实桌面窗口，供桌面壳取证。

### 质量

- CI 重写（`.github/workflows/ci.yml`）：`windows-latest` 跑全链（typecheck + 全部测试 + 真机冒烟，注册表/托盘能力在 ubuntu 上跑不全）、`npm ci` + 依赖缓存、同分支并发取消、job 级 timeout；新增 demo job 起演示环境并用无头浏览器逐视图截图，截图随 artifact 产出。`package.json` 新增 `ci` / `demo` / `shots` 单一入口。
- 文档：README 补 Mermaid 架构/安装状态机/本地仓库/流水线图与截图墙、设计对标说明；新增 [LOCAL-REPO.md](LOCAL-REPO.md)。
- 137 项自动化测试全部通过（在资产摘要范围边界、离线判定阈值、机群汇总往返、时序留存与剪枝、鉴权闸门之外，新增本地仓库的落盘与清单结构、缓存命中不发请求、失败记录与重试累计、status 按磁盘重算、sha256 识破篡改，以及真 HTTP 端到端镜像与全版本落盘用例），类型检查干净。

## 0.1.0 - 2026-10-06

首个公开版本。

### 引擎（packages/core）

- 目录与检索：分类树、子分类聚合、中文搜索、贝叶斯评分、运营位、专属应用、捆绑包。
- 本机清单：HKLM 64/32 + HKCU 卸载项读取；三个卸载根并行扫描；readKey 单键窄查询原语。
- 清单缓存：落盘缓存（原子写 + TTL + 指纹），命中即返回，首屏不阻塞；缓存过期走增量刷新。
- 残留清理：只读扫描产出清理计划，注册表类先导出 .reg 备份，支持撤销，默认 dryRun。
- 下载：Range 断点续传，sha256 + 体积双校验，校验不过不进安装态。
- 执行计划：MSI / NSIS / Inno / MSIX / 归档 / 脚本；修正 MSIX cmdlet、归档 7z 路径注入、脚本解释器前缀；静默与手动双模式。
- 安装编排：状态机与批量队列；装后回读注册表确认真实已装版本；成功/失败/异常统一清理安装包。
- 升级与自升级：版本比较、升级计划；暂存校验、换版、失败回滚。
- 审批：安装前置闸门、凭证签发与校验、通知回路。
- 运行时：跨进程运行配置；开机自启开关（写入 HKCU Run 键，可关闭）。
- 外壳能力：多窗口、单实例锁、托盘状态机与菜单、皮肤 token 注册表。

### 服务端（packages/server）

- 目录 / 分类 / 评分 / 审批 / 自升级清单 HTTP 服务，SQLite 存储。
- 鉴权：由单一静态令牌升级为「用户 / 角色令牌」，库内只存令牌哈希。
- 审计：关键管理动作写入 audit_log。
- 部门目录：支持按部门下发可见范围。
- 安装回执、运营位、捆绑包、Range 下载。
- 修复：审批「驳回」结果此前不会出现在申请人通知中，现已闭环。

### 宿主与工具

- 本地 Web 客户端（bridge + SSE，只监听 127.0.0.1）。
- WinForms 托盘 / 窗口宿主。
- 无头 CLI（JSON Lines IPC），与 Web 桥共用同一张 dispatch 方法表。

### 真机安装包发现与本地仓库

- 自动识别安装包来源位置：从环境变量推导 5 个来源根（下载 / 公共下载 / 包缓存 / 更新缓存 / 本地缓存），不写死盘符，只认用户与系统级的公共落点。
- 自动识别语义：递归扫描 + PowerShell 批量读 PE 版本资源；综合扩展名 / 文件名 / PE / 路径打分，低于阈值的应用本体、卸载器、解压器临时壳一律不入目录。
- 真实替代：`scripts/build-real-catalog.mts` 删除演示假应用、把本机发现的真实安装包发布到目录（downloadUrl 用 `file://` 指回原文件，带真实体积与 sha256）。
- 本地保存：`localFileDownloader`（`file://` 复制 + 校验，不联网）配合 `LocalRepo.sync` 把安装包镜像进 `local-repo/`，生成含目录快照的 `manifest.json`。
- 安全边界：只镜像本机已有的安装包文件，不下载、不执行；不搬运任何第三方专有二进制；UI 演示仍由 `simulateInstalls` 保证占位包绝不在真机跑。
- 脚本：`npm run discover`（仅发现并落 discover-report.json）、`npm run build:real-catalog`（发现 → 删假 → 灌真 → 镜像）。

### 质量

- 76 项自动化测试全部通过（含 `discover.test.ts` 8 项纯逻辑用例），类型检查干净。
- 全部系统副作用可注入，测试无需真实注册表与安装包。

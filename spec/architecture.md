# 架构设计

## 1. 包划分与依赖方向

```
packages/core    纯引擎：目录、清单、残留、下载、编排、升级、审批、皮肤、心跳摘要
packages/server  目录服务端与机群侧：HTTP API、extras、本地仓库镜像
packages/app     宿主侧：RPC 桥(dispatch)、Web UI、桌面壳与托盘、自升级
packages/cli     命令行入口，只调 core/server 的公开导出
```

依赖只能向下：`cli → app/server → core`。`core` 不 import 任何宿主或网络栈，因此可在 Linux 上跑同一套断言。

## 2. 可注入端口（这是"可测试"的结构性前提）

引擎的外部接触面一律以端口形式注入，测试与演示通过替换端口来构造状态，而不是改生产代码：

| 端口 | 作用 | 注入点 |
|---|---|---|
| `runner` | 执行安装/卸载命令 | `AppCenterFacade` 构造参数（演示走 `SimulatedRunner`） |
| `registryKeys` | 已装清单的注册表来源 | `startUi({ registryKeys })`；给了就完全不扫真机 |
| `webRoot` / `iconsDir` | 静态资源与图标目录 | `createBridge` 选项 |
| 环境根（`programData`/`appData`/`systemRoot`/`temp`） | 残留扫描的搜索根 | `ScanEnv`，由 `defaultScanEnv()` 从环境变量派生，可整体替换 |
| `WindowHost` / 托盘宿主 | 窗口与托盘动作 | 桌面壳适配层；无宿主时用记录型实现 |

**判据要求**：注入缝必须双向钉——注入时必须只见假数据，不注入时必须仍走真实路径（用耗时指纹等可观测量证明它真跑了）。

## 3. 关键不变量

- **按根/按段隔离**：单个注册表根或扫描段失败只记 `gaps`，不得让整份清单或整类结果消失，也不得被误判成"已卸载"。
- **实例定位唯一化**：残留报告选择与卸载执行共用同一个 `resolveInstalledInstance`，同名多实例歧义时显式拒绝而不是挑一个。
- **名字判据只有一把**：目录视图、升级计划、安装包发现共用 `nameMatchQuality`（同一阈值），避免三处结论互相矛盾。
- **原子写**：清单缓存、manifest、镜像 staging 全部"唯一临时名 + 校验 + 有界重试改名"，失败清残骸。
- **凭证即边界**：审批凭证签名载荷包含版本；不可解析的有效期按无效处理；吊销对已签发凭证生效。
- **本地服务只此一处**：RPC 桥监听回环；跨源请求与无 `Origin` 的写操作被拒。

## 4. 运行时拓扑

```
Web UI ──HTTP/RPC──> bridge(dispatch) ──> facade ──> core 引擎 ──> 注册表 / 文件系统 / 子进程
                          │                              │
                          └── 静态资源(webRoot)          └── 目录服务端(HTTP) ──> SQLite
桌面壳(托盘/多窗口) ──IPC──> 同一 dispatch 面
```

宿主异常不得泄漏成服务进程崩溃：所有 spawn 挂 `error` 监听，异步失败必须有终态，未处理拒绝视为缺陷。

## 5. 平台边界

Windows 专属：注册表读写（`reg.exe`）、计划任务/右键菜单残留、托盘与窗口宿主、UAC 提权。
平台无关：目录与检索、评分、下载与校验、执行计划**生成**、审批与凭证、皮肤 token、协议与 CLI。
依赖 Windows 的测试自带平台跳过，Linux 作业跑同一套断言。

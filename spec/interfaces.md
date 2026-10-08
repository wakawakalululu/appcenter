# 接口契约

## 1. 传输层

- **RPC 桥（宿主侧）**：`POST /rpc`，请求体 `{"method": string, "params": object}`，响应 `{"ok": boolean, "result"?, "error"?}`。
  只绑 `127.0.0.1`；写操作校验 `Origin`，缺失或跨源即拒（历史上 `text/plain` 简单请求可绕过，已封）。
- **目录服务端**：`GET /api/apps`、`GET /api/apps/:id` 等公开读端点；管理端点（灌数据、改运营位等）要求管理员令牌，缺令牌 fail-closed。
- **安装包下载**：支持 `Range` 与 `If-Range`；`sha256` 与 `size` 是契约的一部分，校验不过不得落地。
- **CLI/IPC**：每行一个 JSON 报文，便于手工注入与冒烟。

## 2. RPC 方法分组（当前实现的全部面）

| 组 | 方法 |
|---|---|
| 目录 | `catalog.view` `catalog.home` `catalog.categories` `catalog.search` `catalog.detail` `catalog.exclusive` `catalog.refresh` `catalog.rate` `catalog.rating` |
| 已装清单 | `installed.list` `jobs.list` |
| 升级 | `upgrade.plan` |
| 残留与清理 | `residue.report` `cleanup.plan` `cleanup.apply` `cleanup.restore` `cleanup.recycle` `cleanup.recyclePrune` `cleanup.recyclePurge` |
| 安装/卸载 | `app.install` `app.uninstall` `app.bulkInstall` `app.open` |
| 捆绑包 | `bundle.list` `bundle.run` `bundle.install` `bundle.progress` |
| 审批 | `approval.request` `approval.list` `approval.attachGrant` |
| 回执/通知 | `receipt.report` `receipt.list` `notification.list` `notification.done` |
| 本地仓库 | `repo.sync` `repo.status` `icons.sync` |
| 自升级 | `selfupdate.check` `selfupdate.stage` `selfupdate.apply` `selfupdate.commit` `selfupdate.pending` `selfupdate.recover` |
| 运行时 | `runtime.config` `runtime.updateConfig` `runtime.dirs` `runtime.startChecks` `runtime.stopChecks` |
| 心跳/机群 | `heartbeat.report` `fleet.summary` `fleet.detail` |
| UI/窗口 | `ui.setSkin` `ui.skin` `ui.skins` `ui.tray` `ui.trayAction` `ui.window` `ui.windows` `ui.closeToTray` `window.control` |

**兼容性要求**：方法名与出入参形状属于对外契约，删除或改名必须同步 [SRS](srs.md) 的互操作边界一节并有回归用例；
新增方法不得改变既有方法的默认语义（例如不得让"该申请"状态在界面上显示成"可升级"）。

## 3. 错误语义

- 失败以 `{"ok": false, "error": string}` 返回，不抛裸异常给宿主；分类要可判别（网络 / 校验 / 落地 / 执行 / 拒绝）。
- 落地失败保留已校验的 `.part`，目标位腾开后原地补落地，不重下整包。
- 任务必须有终态；子进程 `spawn` 失败要能被发现（无 `error` 监听会直接打死宿主）。
- HTTP 入口对请求体设传输层上限（1 MiB）：先看 `Content-Length` 就拒，流式累加时也判；超限返回 `413` 且**绝不落库**。
  业务层的条数上限是"读完之后"才起作用，挡不住单个字段过大；被拒的请求也不能当成空体继续处理，那会把一次攻击变成一条正常记录。

## 4. 演示与测试入口

- `npm run demo`：本地演示（真机注册表可选）。
- `UI_DEMO_FAKE_INVENTORY=1`：注入虚构已装清单，公开配图必须走这条路径。
- `npm run shots`：`scripts/reshoot.mts`，自带假清单 + `?mask=1` + 端口 0 + 只认自己子进程的端口持有者，产物落在临时目录。
- `npm run smoke`：起真实服务 + CLI 端到端；就绪判据是"自己子进程 announce 的端口"，不是"端口能连上"。

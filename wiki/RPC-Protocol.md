# RPC 协议

## 传输方式

同一张 dispatch 方法表暴露在三个前端：

| 宿主 | 方式 |
| --- | --- |
| CLI 无头壳 | stdin / stdout，JSON Lines，每行一个请求 |
| 本地 Web 桥 | POST /rpc + JSON |
| 事件流 | GET /events，Server-Sent Events |

本地 Web 桥只监听 127.0.0.1，不对外暴露。

## 请求与响应

```json
// 请求
{"id":1,"method":"catalog.search","params":{"text":"wps"}}

// 成功
{"id":1,"result":{ "...": "..." }}

// 失败
{"id":1,"error":"unknown method: foo"}
```

每条请求带 id，响应原样回带，便于并发匹配。

## 事件订阅

GET /events 持续推送任务状态与托盘状态。任务状态机：

```
queued -> downloading -> installing -> succeeded
```

另有 awaiting_approval、needs_reboot、failed、cancelled 分支。
宿主订阅 onJob 即可驱动进度条与角标，无需轮询。

## 方法分组

| 前缀 | 用途 | 示例 |
| --- | --- | --- |
| catalog.* | 目录、分类、搜索、评分 | catalog.search |
| inventory.* | 本机已装清单 | inventory.installed |
| residue.* | 残留扫描与清理 | residue.scan、cleanup.restore |
| install.* | 安装任务与队列 | install.enqueue、install.cancel |
| upgrade.* | 升级计划 | upgrade.plan |
| approval.* | 申请审批与凭证 | approval.request、approval.attachGrant |
| ui.* | 窗口、托盘、皮肤 | ui.tray、ui.trayAction、ui.skin |
| selfUpdate.* | 客户端自升级 | selfUpdate.check |
| config.* | 运行配置（含自启开关） | config.updateRuntime |

方法名以仓库 packages/app/src/dispatch.ts 为准；新增方法请同步更新本表。
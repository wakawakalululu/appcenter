# 服务端 API

## 启动与配置

```bash
ADMIN_TOKEN=xxx \
DB_FILE=/var/lib/appcenter/catalog.db \
PACKAGE_ROOT=/srv/packages \
  node --experimental-transform-types packages/server/src/main.ts --seed
```

| 环境变量 | 作用 |
| --- | --- |
| ADMIN_TOKEN | 管理员令牌；不配置时为开放模式，仅适合本地演示 |
| DB_FILE | SQLite 路径，默认内存库 |
| PACKAGE_ROOT | 安装包存放根目录 |

## 令牌与角色

管理类接口需要 `Authorization: Bearer <token>`。令牌有两种来源：

- 静态管理员令牌：直接使用 ADMIN_TOKEN 的值。
- 用户令牌：POST /api/login 签发，携带 role（user / admin）。库内只存令牌哈希。

```bash
curl -X POST http://127.0.0.1:7991/api/login \
  -H "content-type: application/json" \
  -d '{"userId":"alice","role":"user"}'
```

## 公开接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/apps | 应用列表，支持 ?department= 过滤可见范围 |
| GET | /api/apps/:id | 应用详情（含版本与安装参数） |
| GET | /api/categories | 分类树 |
| GET | /api/ratings | 各应用评分分布 |
| GET | /api/banners | 运营位 |
| GET | /api/bundles | 捆绑包（装机套装） |
| GET | /api/self-update | 已发布的客户端新版本清单 |
| POST | /api/apps/:id/receipt | 客户端上报安装回执 |
| POST | /api/heartbeat | 客户端上报本机资产心跳（按 machineId 幂等） |

## 审批与通知

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/approvals | 提交安装申请 |
| GET | /api/approvals?applicant= | 我的申请列表 |
| POST | /api/approvals/:id/decide | 审批（需管理员） |
| POST | /api/approvals/:id/grant | 取安装凭证（签名、限时、一次性） |
| GET | /api/notifications?applicant= | 通知（含通过与驳回结果） |
| POST | /api/notifications/:id/done | 通知回执 |

## 管理接口

以下接口均需管理员角色，成功后写入 audit_log：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/admin/apps | 发布 / 更新应用 |
| DELETE | /api/admin/apps/:id | 下架应用（连带版本） |
| POST | /api/admin/categories | 分类维护 |
| POST | /api/admin/self-update | 发布客户端新版本 |
| POST | /api/admin/banners、/api/admin/bundles | 运营位与捆绑包 |
| GET | /api/admin/fleet | 机群资产汇总（逐机最近心跳 + 全局计数） |

## 机群资产心跳

客户端周期性把「本机目录应用的安装态摘要」上报到 `POST /api/heartbeat`，管理端用
`GET /api/admin/fleet` 汇总查看覆盖率与到达率。

```bash
curl -X POST http://127.0.0.1:7991/api/heartbeat \
  -H "content-type: application/json" \
  -d '{"machineId":"pc-01","appVersion":"1.0.0",
       "installed":[{"appId":"wps-office","version":"12.1.0","upgradable":false}],
       "needsApproval":["vpn-client"],
       "counts":{"installed":1,"upgradable":0,"needsApproval":1,"pendingApprovals":0}}'
```

服务端按 `machineId` 幂等 upsert，只保留每台机器最近一次摘要，并记录首次 / 最近上报时间。
`fleet` 返回 `{ agents: [...], totals: { agents, installed, upgradable, needsApproval } }`。

**范围边界**：心跳只回答「分发下去的软件在这台机器上是什么状态」，上报面严格收敛在
目录内应用的身份与版本（appId + version）与计数量；不采集进程列表、窗口、浏览记录、
屏幕或任何终端行为数据。`buildAssetSummary` 是纯函数，其输出字段集合就是客户端愿意
告诉服务端的全部信息，并有单元测试锁定该边界。

## 安装包下载

GET /dl/<file> 提供安装包，支持 Range 断点续传（返回 206 与 Content-Range，
并始终带 Accept-Ranges: bytes）。客户端下载完成后必须校验 sha256 与体积才会进入安装态。
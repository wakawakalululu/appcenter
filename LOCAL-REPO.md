# 本地应用包仓库（LocalRepo）：安装包落盘 + 自描述清单

> 需求：把目录里**所有应用的安装包保存到本地**，并生成**相应的应用清单**。
> 设计取向：安装包**持久化留底**而非临时中转。常见的「装完即删」做法不留底、不可审计，
> 无法支撑离线复用；本项目因此逐包做 sha256 校验、生成带目录快照的清单，
> 形成一个可离线复用的镜像。

## 1. 能力

| 能力 | 说明 |
| --- | --- |
| `LocalRepo.sync()` | 对目录里每个应用（默认最新版，`allVersions` 可选全部历史版本）下载安装包，sha256 + 体积双校验后才落到 `<root>/<appId>/<version><ext>` |
| `manifest.json` | 仓库的**应用清单**：逐包记录 appId/名称/版本/相对路径/大小/sha256/来源 URL/状态/尝试次数，并内嵌**目录快照**（全部应用摘要 + 分类树）——清单脱离服务端也能说明「这些包是什么」 |
| 缓存命中 | 文件已存在且大小（或 sha256）匹配 → `cached`，不发请求；被篡改的文件在 `verify:"sha256"` 档位会被识破并重新下载覆盖 |
| 失败可续 | 单包失败只记入 `failed`（带原因），不中断整轮；下一轮同步自动重试，`attempts` 累计 |
| `LocalRepo.status()` | 只读盘点：按当前磁盘事实重算每条目的 saved/failed/pending，文件被手动删除会从 saved 落回 pending |
| 原子写 | 清单先写 `.tmp` 再改名，不会留下半截 JSON |
| `localFileDownloader` | url 为 `file://` 或本地路径时走复制 + 校验，真机发现出来的安装包用同一套链路镜像进仓库 |

## 2. 接口与入口

同一能力三个入口，全部走 `facade.syncLocalRepo / localRepoStatus`：

```bash
# CLI
APPCENTER_API=http://127.0.0.1:7991 node --experimental-transform-types packages/cli/src/main.ts repo-sync [--all-versions] [--dir=PATH]
APPCENTER_API=http://127.0.0.1:7991 node --experimental-transform-types packages/cli/src/main.ts repo-status [--dir=PATH]

# RPC（UI 与 shell 同源方法表）
repo.sync   { allVersions?: boolean, dir?: string, verify?: "size" | "sha256" }
repo.status { dir?: string }

# 界面：设置 → 本地应用包仓库 → 同步最新版 / 同步全部版本 / 刷新状态
```

默认落盘位置：`<dataDir>/local-repo/`（facade 配置），RPC/CLI 可用 `dir` 覆盖。
目录里的 `downloadUrl` 通常是相对路径（`/dl/...`），facade 会用 `serverUrl` 补全成绝对 URL。

## 3. 数据格式

```json
{
  "formatVersion": 1,
  "generatedAt": "2026-10-07T03:08:00.000Z",
  "root": "C:\\…\\local-repo",
  "catalog": { "apps": [ "…AppSummary 全量摘要" ], "categories": [ "…分类树" ] },
  "items": [
    {
      "appId": "wps-office", "name": "WPS Office", "publisher": "金山办公",
      "categoryId": "office-doc", "tags": ["文档", "表格", "演示"],
      "version": "12.1.0", "fileName": "wps-12.1.0.msi",
      "relativePath": "wps-office/12.1.0.msi",
      "sizeBytes": 481280, "sha256": "<64 hex>", "url": "http://…/dl/wps-12.1.0.msi",
      "status": "saved", "savedAt": "…", "attempts": 1
    }
  ]
}
```

## 4. 演示环境的端到端复现

演示目录的安装包默认是占位声明（假 sha256）。`materializeDemoPackages(db, packageRoot)`
把每个版本物化成**确定性生成的真实文件**并把真 sha256/体积回写版本表，于是
「下载 → 续传 → 校验 → 落地 → 入清单」整条链路可以真跑通（`npm run demo` 已自动执行）：

```bash
npm run demo                     # 起目录 API(7991) + UI(8080)，物化 90 个演示包
# 另开终端
APPCENTER_API=http://127.0.0.1:7991 node --experimental-transform-types packages/cli/src/main.ts repo-sync
# → synced: 21 saved, 0 failed, ~6 MB
APPCENTER_API=http://127.0.0.1:7991 node --experimental-transform-types packages/cli/src/main.ts repo-sync
# → 21 cached（命中缓存，不再发请求）
```

## 5. 测试覆盖

- `packages/core/test/repo.test.ts`（6 项）：全量落盘与清单结构、allVersions、缓存命中不发请求、
  失败记录与重试累计、status 按磁盘事实重算、sha256 档位识破同长度篡改。
- `packages/server/test/repo.test.ts`（2 项）：真 HTTP 端到端——物化包 → `syncLocalRepo` 走真实
  `/dl` 下载 → 落盘字节 sha256 与清单一致 → 二次同步全命中；allVersions 全版本落盘。

## 6. 边界与后续

- 清单只追加目录里存在的条目；应用下架后，旧的落盘文件不会被删除（保留镜像语义），`status` 会把它们原样列出。
- `size` 档位默认（大文件友好）；要防篡改用 `verify:"sha256"`，代价是逐字节读一遍缓存文件。
- 尚未做：按 manifest 的离线安装（`app.install` 直接吃本地包）、仓库目录的锁与多客户端并发写。

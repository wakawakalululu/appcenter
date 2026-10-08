# 数据模型

## 1. 目录侧

- `Category`：`id`、`name`、`parentId`（可空）、`sortOrder`。分类是树，视图按子分类聚合。
- `AppSummary`：列表用投影（`id`/`name`/`publisher`/`categoryId`/`iconUrl`/`latestVersion`/`downloadCount`/`badge`/`tags`/`requiresApproval`/`sizeBytes`）。
- `AppDetail extends AppSummary`：加 `description`、`screenshots`、`versions[]`。
- `AppVersion`：`version`、`releasedAt`、`sizeBytes`、`sha256`、`downloadUrl`、`releaseNotes`、`silent`、`minUpgradeFrom`。
- `SilentSpec`：安装类型与参数（MSI/INNO/NSIS/脚本），决定执行计划怎么生成。
- `RatingInput` / `RatingDistribution`：评分条目与 1..5 星分布（含均值与计数）。

**语义约束**：演示数据里的占位 `sha256`（全等字符重复）必须可被识别为占位，不得被当成真实校验值参与比对。

## 2. 已装清单侧

- `InstalledApp`：`displayName`、`displayVersion`、`publisher`、`regDir`（**实例身份的一部分**）、`installLocation`、`regKey` 来源根。
- 去重键的语义是"仅当主键为空/null 才回落"（`??`，不是 `||`）：空字符串是有效的不同来源信息，不能被静默替换。
- 版本比较按四段（`a.b.c.d`）而非三段，缺段按 0 处理；空白 `DisplayVersion` 不参与升级判断。
- 缓存条目携带每根的成功/失败状态；某根失败时该根的结果保持上一次已知值并记入缺口，不得整体判空。

## 3. 残留报告

```
ResidueReport {
  items: { kind, path, risk, detail }[]
  counts: Record<kind, number>
  durationMs: Record<phase, number>
  gaps: { kind, source, error }[]     // 关键：少扫一段与"真没有残留"必须可区分
}
```

`gaps` 非空时清理计划必须拒绝执行；风险分级决定默认勾选（低风险默认选中，高风险需显式确认）。

## 4. 审批与凭证

- 审批单：`appId`、`appVersion`、`applicant`、`reason`、`status`、`decidedBy`、`note`、时间戳。
- 凭证载荷**同时绑定应用与版本**，两侧签名载荷字段顺序一致；有效期不可解析按无效处理；吊销对已签发凭证生效。
- 申请人身份取自会话主体，不接受请求体自报（否则可替别人申请/查看）。

## 5. 本地仓库 manifest

```
manifest.json {
  generatedAt, root,
  entries: { appId, version, file, size, sha256, sourceUrl, cachedAt }[]
}
```

`status` 按磁盘实际内容重算（文件被删则不算已缓存）；缓存命中不发网络请求；镜像写入用唯一临时名 + 独占校验 + `EPERM` 有界重试。

## 6. 皮肤与运行时配置

- 皮肤 = token 覆盖表；缺省回落必须被显式记录（校验错误数可观测），不允许静默用错值。
- 运行配置（下载目录、并发、检查周期等）写在共享数据目录，跨进程访问走唯一临时名 + 原子替换。

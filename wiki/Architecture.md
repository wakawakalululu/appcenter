# 架构

## 分层

| 层 | 位置 | 约束 |
| --- | --- | --- |
| 领域引擎 | packages/core | 不依赖 UI 框架；系统交互经接口注入，测试可整体替换 |
| 目录服务端 | packages/server | 纯 Node HTTP + SQLite；只暴露 JSON API 与 Range 下载 |
| UI 宿主 | packages/app、packages/cli | 实现 WindowHost、订阅 onJob、调用 dispatch |

引擎对外的唯一门面是 AppCenterFacade；CLI、Web 桥与桌面壳走同一张 dispatch 方法表，
因此三种宿主行为一致。

## 可注入端口

| 接口 | 生产实现 | 测试实现 |
| --- | --- | --- |
| RegClient | reg.exe 只读查询 | InMemoryRegClient |
| ProcessRunner | ChildProcessRunner | fakeRunner |
| WindowHost | WinForms 宿主 / Tauri | FakeHost |
| AutoStartBackend | 写 HKCU Run 键 | MemoryAutoStartBackend |

## 清单读取与缓存

已装清单来自三个卸载根（HKLM 64 位、HKLM 32 位、HKCU）。为避免首屏被真实注册表扫描阻塞：

1. **并行**：三个根用 Promise.all 同时查询，而非串行累加。
2. **缓存**：结果落盘为 inventory-cache.json（临时文件 + rename 原子替换），带 TTL 与指纹，命中即返回。
3. **增量刷新**：缓存过期时先 queryChildren 拿到直接子键，再对单个 regDir 做窄查询（readKey），避免递归整棵树。

## 执行计划

defaultSilent(kind) 为每种安装器给出默认静默参数，buildPlan() 把模板展开为可执行计划，
并处理两个易错点：

- NSIS 的 /D= 必须是最后一个参数，否则安装目录不生效。
- 脚本类安装包需要解释器前缀（.ps1 走 PowerShell，.bat/.cmd 走 cmd），否则会因「不是可执行程序」失败。

编排器在安装进程退出后回读注册表确认真实已装版本；无论成功、失败还是异常，
都按 installerCleanup 开关删除已下载的安装包。

## 清理与回滚

残留清理是「只读扫描 → 生成计划 → 显式确认 → 执行」的流程，注册表类操作会先导出 .reg
备份并写 backup-manifest.json；没有备份目录会被直接拦截，导出失败的条目不删除，
撤销走 cleanup.restore。

## 鉴权与审计

服务端以「用户 / 角色令牌」取代单一静态令牌：users 与 api_tokens 两张表承载身份与令牌
（库内只存令牌哈希），管理类路由校验角色，关键动作写入 audit_log。
目录可按 department 下发可见范围。

注意：未配置 ADMIN_TOKEN 时服务以开放模式运行，便于本地演示；对外部署务必配置令牌或签发用户令牌。
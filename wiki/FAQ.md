# 常见问题

## 需要 Windows 吗？

服务端是纯 Node HTTP + SQLite，可在任意平台运行。客户端侧涉及注册表清单、
`reg.exe`、WinForms 托盘，因此完整功能需要 Windows；引擎本身通过接口抽象，
在其它平台可注入替身实现。

## 为什么没有构建步骤？

项目直接用 Node 的 `--experimental-transform-types` 执行 TypeScript。
好处是克隆即可运行、没有产物与源码漂移；代价是启动有少量编译开销。

## 首屏卡顿怎么解决？

已装清单读取做了三层处理：三个卸载根并行扫描、结果落盘缓存（TTL + 指纹）、
缓存过期时按 regDir 增量窄查询。命中缓存时不触达注册表。

## 安装失败后安装包会残留吗？

不会。成功、失败、异常、以及升级前卸载失败四条路径都会按 installerCleanup
开关删除已下载的安装包。

## 清理会不会误删系统文件？

清理默认 dryRun，且写入必须同时满足：风险被勾选、路径在 allowWriteRoots 内、
确认串正确。C:\Windows、盘根、白名单外路径一律拒绝。注册表类操作在删除前
先导出 .reg 备份，可用 cleanup.restore 撤销。

## 为什么服务端不配置 ADMIN_TOKEN 也能改数据？

不配置时为开放模式，方便本地演示。对外部署务必配置 ADMIN_TOKEN，
或通过 /api/login 签发带角色的用户令牌。

## 支持哪些安装包类型？

MSI、NSIS、Inno、MSIX、归档（7z）、脚本（.ps1/.bat/.cmd/可执行文件）。
目录应用可用 installMode 声明 silent 或 manual；manual 会剥掉静默参数，
弹真实安装向导由用户完成。

## 项目范围边界

不包含终端管控类能力（行为采集、Web 中间人、锁屏、远程桌面、驱动级进程拦截、
静默保活），也不包含任何绕过授权或许可校验的实现。
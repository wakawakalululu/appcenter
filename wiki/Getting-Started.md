# 快速开始

## 环境

- Node >= 24（项目用 `--experimental-transform-types` 直接执行 TypeScript，无构建步骤）
- Windows（客户端侧；服务端可在任意平台运行）

```bash
git clone <repo-url>
cd appcenter
npm install
```

## 跑通最小闭环

```bash
# 1) 启动目录服务端（建库 + 灌演示数据）
node --experimental-transform-types packages/server/src/main.ts --seed

# 2) 另开终端，跑无头壳
node --experimental-transform-types packages/cli/src/main.ts search wps
node --experimental-transform-types packages/cli/src/main.ts demo
```

## 拉起桌面 UI

```bash
# 一条命令拉起目录服务 + UI（演示数据）
CATALOG_PORT=7991 UI_PORT=8080 node --experimental-transform-types scripts/ui-demo.mts
# 浏览器打开 http://127.0.0.1:8080
```

## 提交前检查

```bash
npm run typecheck
npm test
```

## 下一步

- 想了解内部结构 → [Architecture](Architecture.md)
- 想接入自己的 UI → [RPC-Protocol](RPC-Protocol.md)
- 想部署服务端 → [Server-API](Server-API.md)
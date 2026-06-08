# AGENTS.md

本文件为 AI 代理提供架构与开发指导。

## 项目概述

`llm-proxy-ts` 是 `llm-proxy`（Python/FastAPI）的 TypeScript 迁移版本。本地优先的 LLM 反向代理，暴露 OpenAI Chat Completions 兼容 API，通过 Vercel AI SDK 转发到上游 OpenAI-compatible provider。

**原始行为参考：** `D:\code\github\llm-proxy`（本机 Python 版本）。

## Monorepo 结构

```
llm-proxy-ts/
├── apps/core/     @llm-proxy/core   — 配置、Provider 工厂、CLI
├── apps/server/   @llm-proxy/server — Hono HTTP 服务器
├── plugins/       示例外部插件（auth-demo）
├── config/        示例配置 + JSON Schema
└── tsconfig.base.json
```

`server` 依赖 `core`（`workspace:*`）。各包有独立的 `AGENTS.md` 描述模块细节。

## 通用命令

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖 |
| `pnpm dev` | 启动开发服务器（`tsx watch`） |
| `pnpm test` | 运行全部测试（Vitest，无网络） |
| `pnpm typecheck` | `tsc --noEmit` |

运行单个测试：`pnpm --filter <pkg> test test/xxx.test.ts`

## TypeScript 配置

`tsconfig.base.json` 启用严格选项：`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`verbatimModuleSyntax`。所有本地导入必须使用 `.js` 扩展名（ESM + `NodeNext`）。

## 当前范围（v0）

- 仅支持 `openai-compatible` provider 类型。
- 不做下游客户端鉴权、计费、配额、多租户、数据库或 Web UI。
- 响应形状以 OpenAI Chat Completions 兼容为目标，不保证逐字段原样透传上游响应。

## 迁移原则

- 先迁移行为和测试，再做 TypeScript 生态优化。
- 保持 OpenAI-compatible API 的客户端兼容性。
- 本地配置和密钥只保留在未提交文件中。

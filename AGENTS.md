# 仓库贡献指南

## 项目结构与模块组织

`llm-proxy-ts` 是本地优先的 TypeScript LLM 协议转换代理。主要源码在 `src/`：`server/` 放 Hono 应用、协议处理、日志和启动入口；`providers/` 放上游 provider 工厂与下游协议策略/渲染；`cli/` 放 Commander 命令；`oauth/` 和 `plugins/` 分别处理 token 与插件。测试在 `test/`，按功能域镜像源码结构。配置示例和 schema 在 `config/`，示例插件在 `plugins/`，设计/计划文档在 `docs/superpowers/`。临时调试产物放 `temp/`。

## 构建、测试与开发命令

- `bun install`：安装依赖。
- `bun dev serve`：启动本地服务；需要热重载时加 `--watch`。
- `bun dev models list`：列出已配置模型。
- `bun dev models sync --dry-run`：预览模型同步变更，不写配置。
- `bun run test`：运行全部 Vitest 测试；可追加路径运行单文件，如 `bun run test test/server/app.test.ts`。
- `bun run typecheck`：执行 `tsc --noEmit`。
- `bun run format:check` / `bun run format`：检查或写入 Prettier 格式。
- `bun run generate:schema`：配置 schema 变更后重新生成 `config/settings.schema.json`。

## 代码风格与命名约定

项目使用严格 TypeScript、ESM 与 `NodeNext`。本地导入必须写生成后的 `.js` 扩展名。业务代码保持 Node 兼容，不导入 `bun:*`，不使用 `Bun.*`；Bun 只作为运行与包管理工具。Prettier 为格式基准：无分号、单引号、尾随逗号、`printWidth` 100。文件名按功能命名，如 `handle-protocol.ts`、`models-sync.test.ts`。错误分支必须记录完整错误对象和堆栈，避免只记录 `err.message`。

## 测试指南

Vitest 使用 Node 环境，匹配 `test/**/*.test.ts`。优先覆盖协议映射、路由、配置校验、流式响应、OAuth、插件和错误处理等业务行为。复用 `test/helpers/` 中的辅助工具，默认保持测试无网络依赖；只有明确做集成验证时才接入外部服务。

## Commit 与 Pull Request 规范

提交历史主要使用 Conventional Commits，例如 `fix(models-sync): ...`、`feat: ...`、`refactor: ...`、`docs: ...`、`chore: ...`。PR 应说明行为变更、列出验证命令、关联 issue，并明确配置、schema、日志或安全影响。提交前检查 `git status` 和 diff，只纳入本次任务相关文件。

## 安全与配置提示

不要提交真实密钥、`config/settings.jsonc`、`config/auth.json`、`.env*`、日志或本地缓存。JSONC 配置中的密钥使用 `${ENV_NAME}` 占位符。公开配置发生变化时，同步更新 `config/settings.example.jsonc`，并运行 `bun run generate:schema` 更新 schema。

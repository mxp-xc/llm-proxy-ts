# 迁移到 bun（包管理 + 运行时）设计

## Context

项目当前以 pnpm 管理依赖、以 node + tsx 运行 TS。`package.json` 的 `dev` 脚本已切到 `bun`，但 `generate:schema`/`models:sync` 仍用 `tsx`，`serve.ts` 保留 `hasBun()` + tsx 回退逻辑，依赖 `pnpm-lock.yaml` / `pnpm-workspace.yaml`。

目标：**bun 作为唯一的包管理器与运行时**，移除 pnpm 与 tsx 痕迹，统一工具链。不做向前兼容。

迁移深度定为**纯工具链切换**：代码层面继续使用 Node 兼容 API（bun 全兼容 `node:*` 模块与 `@hono/node-server`），不引入 `bun:*` 内置模块或 `Bun` 全局，不动 `@hono/node-server` 与 `NodeNext` tsconfig。收益是工具链统一、依赖精简（移除 tsx），风险最低。

## 迁移边界

**改**：包管理器（pnpm→bun）、脚本运行器（tsx→bun）、`serve.ts` 的 tsx 回退、lockfile/workspace、文档与忽略文件。

**不改**：`@hono/node-server`、`NodeNext` + `.js` 扩展名、vitest、`dotenv`、`@types/node`、`undici`、`pino`、所有 `node:*` 导入、历史文档（`docs/superpowers/` 下的 plans/specs 保留原样）。

## 命令约定

文档统一采用以下写法：

- `bun install` — 装依赖（内置命令）
- `bun dev <command>` — 跑 CLI（`dev` 为 package.json 入口 script，等价 `bun src/cli/cli.ts <command>`）
- `bun dev serve --watch` — 热重载
- `bun run test` / `bun run typecheck` / `bun run generate:schema` / `bun run format` / `bun run format:check` — **必须带 `run`**

> 陷阱：`bun test`（不带 `run`）会触发 bun 原生 test runner，找不到 vitest 测试。故测试相关命令一律写 `bun run test`。

## 改动清单

### 代码（2 个文件）

| 文件               | 改动                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`     | `generate:schema` / `models:sync` 的 `tsx`→`bun`；devDeps 移除 `tsx`；加 `"packageManager": "bun@1.3.14"`                                                                            |
| `src/cli/serve.ts` | 移除 `hasBun()` 与 tsx 回退分支，`runner` 直接为 `'bun'`，`args` 简化为 `opts.watch ? ['--watch', serverPath] : [serverPath]`；移除 `spawnSync` 导入，保留 `spawn`（CLI 子进程隔离） |

### 配置（5 项）

- 删 `pnpm-workspace.yaml`、`pnpm-lock.yaml`
- 删 `node_modules/`，`bun install` 重建（生成 `bun.lock`）
- `.gitignore`：移除 `.pnpm-store/`、`pnpm-debug.log*`、`yarn-debug.log*`、`yarn-error.log*`
- `.prettierignore`：`pnpm-lock.yaml` → `bun.lock`
- `.codex/environments/environment.toml`：`pnpm install`→`bun install`；`node scripts/setup-settings.mjs`→`bun scripts/setup-settings.mjs`

### 文档（4 个文件）

- `README.md`：所有 `pnpm`→`bun`（按命令约定）；去掉「tsx watch」描述改 `bun --watch`
- `AGENTS.md`：命令表格全表替换；「运行时」章节重写为「包管理与运行时统一用 bun … 代码仍以 Node 兼容 API 为目标，禁止 `bun:*` / `Bun` 全局」；移除「serve.ts 优先 bun 回退 tsx」；`pnpm dev codex install`→`bun dev codex install`；TypeScript 章节不动
- `CLAUDE.local.md`：`pnpm dev serve`→`bun dev serve`；`tsx watch`→`bun --watch`
- `config/settings.example.jsonc` 行 33 注释：`pnpm dev codex install`→`bun dev codex install`

## 验证（按序自主执行）

1. `bun install` — 确认生成 `bun.lock`、无依赖解析错误
2. `bun run typecheck` — `tsc --noEmit` 通过
3. `bun run test` — vitest 全绿（无网络）
4. `bun run generate:schema` — 生成 `config/settings.schema.json`，`git diff` 确认无意外变化
5. `bun dev serve` — `curl http://127.0.0.1:8056/v1/models` 验证 HTTP 服务可达
6. `bun dev serve --watch` — 改一处源码，确认进程自动重启

## 风险

| 风险                 | 说明                                                                                   | 应对                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| esbuild install 脚本 | bun 默认不跑依赖 `postinstall`（除非 `trustedDependencies` 声明）。vitest 依赖 esbuild | esbuild 通过 `optionalDependencies`（如 `@esbuild/win32-x64`）提供原生包，通常不需 postinstall。若步骤 3 报 esbuild 错误，在 `package.json` 加 `"trustedDependencies": ["esbuild"]` |
| `bun.lock` 格式      | bun ≥1.1 生成文本 `bun.lock`                                                           | 当前 bun 1.3.14，已满足                                                                                                                                                             |
| vitest worker 兼容   | vitest 默认用 worker_threads pool                                                      | 步骤 3 覆盖；若挂，vitest config 加 `pool: 'forks'`                                                                                                                                 |
| `bun test` 误触      | 手敲 `bun test` 跑 bun 原生 test runner                                                | 文档统一写 `bun run test`                                                                                                                                                           |

## 回滚

单分支提交，`git revert` 即可恢复（`pnpm-lock.yaml` 在 git 历史里，`pnpm install` 重建）。无不可逆操作。

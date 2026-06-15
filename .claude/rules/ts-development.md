---
paths: ["**/*.ts"]
---

# 限制 `unknown` 类型

入参和返回值**禁止** `unknown`，除非属于以下例外：

- 外部输入验证点（`validate(body: unknown)`）
- 错误处理（`catch`、`toErrorMessage(err)`、`onError(error)`、`rateLimit(errorBody)`）
- 工具调用 `args: unknown` / `result: unknown`（形状由工具定义决定）
- 插件数据、日志 payload、透传字段（本质任意）
- SDK 内部不消费的字段（`rawValue` / `request` / `response`）
- JSON 序列化/脱敏入参（`sse(value)`、`redact(value)` 等调用 `JSON.stringify` 的函数）

违反模式：入参 `unknown` 后立即 `as` 转型 → 用目标类型；返回 `unknown` 但调用方按固定形状访问 → 定义 interface/type。

替代优先级：具名类型 → 判别联合 → 泛型参数 → `Record<string, unknown>` → `unknown`（仅限例外）。

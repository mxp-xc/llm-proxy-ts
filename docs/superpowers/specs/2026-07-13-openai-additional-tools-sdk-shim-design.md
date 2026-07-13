# OpenAI Responses additional_tools SDK 优先兼容设计

## 目标

在继续使用 Vercel AI SDK 构造请求、管理工具、认证、代理、重试和解析响应的前提下，修复 Codex 新版 `input.additional_tools` 被提升到顶层 `tools` 的语义错误，恢复 SDK 省略的 message `type` discriminator，并补齐 AI SDK 已支持但代理尚未映射的 reasoning 选项。

## 设计原则

- `sdkBody` 始终是出站 body 的基础，不能用整个 raw body 或整个 raw input 覆盖 SDK 结果。
- AI SDK 已支持的能力必须通过公开 provider options 映射，不在 fetch 层重复实现。
- 原生 OpenAI Responses 的 final-body merge 为所有无 `type` 的 SDK message items 恢复 `type: "message"`，不替换 SDK 生成的 content。
- AI SDK 尚不支持的 `additional_tools` 使用最小、幂等的 request-body shim。
- shim 仅用于原生 `openai` provider 的 Responses 请求；其他 provider 继续使用现有协议转换。
- SDK 将来原生输出 `additional_tools` 时，shim 通过 body 能力检测自动停止重建 additional item；通用 message `type` 恢复仍执行。

## SDK 能力边界

当前稳定版 `@ai-sdk/openai@4.0.11` 不支持 per-message `additional_tools`。Vercel AI Draft PR #17097 正在探索该能力，尚无稳定 API。`ai@7.0.22` 与 `@ai-sdk/anthropic@4.0.12` 的隔离升级不会改变此行为，因此本修复不依赖依赖升级。

AI SDK 已支持 `reasoningContext` 和 nullable `reasoningSummary`：

- `reasoning.context` 映射为 `providerOptions.openai.reasoningContext`。
- 原请求设置非 `none` reasoning effort、但未设置 summary 时，映射 `reasoningSummary: null`，阻止 SDK 自动添加 `summary: "detailed"`。
- 原请求显式设置 summary 时继续交给 SDK 序列化。

## additional_tools Shim

`createOpenAIResponsesRequestBodyMergeFetch` 解析 SDK 最终 body 后，仍调用统一 merge helper。merge helper 先执行现有 SDK 主导合并，再在满足以下条件时修补 input：

1. raw `input` 是数组且包含至少一个 `type: "additional_tools"` item。
2. SDK `input` 尚未包含任何 `additional_tools` item。

原生 OpenAI mapping 在每个 `additional_tools` 位置放置带随机 UUID 文本和 `phase: "commentary"` 的内部 assistant anchor。该形状不会像 `itemId` 一样在 `conversation` 模式下被跳过、在 `store` 模式下被转换为 `item_reference`。AI SDK 继续正常序列化所有 messages；final fetch 只把 SDK body 中的 anchor 原位替换为对应 raw `additional_tools`：

- anchor 数量必须与 raw `additional_tools` 数量一致，否则抛错，不猜测位置、不静默降级。错误由现有上游错误处理记录完整对象与堆栈。
- assistant message 可能被 SDK 展开为多个 input item，空 message 或 reasoning 也可能不生成 item；anchor 方案不依赖 raw item 与 SDK item 的 1:1 假设。
- SDK 生成的所有非 anchor input items 保持原顺序和原内容；final-body merge 仅为缺少 `type`、具有 Responses message role 和 `content` 的 item 补充 `type: "message"`。
- 当前 native mapping 明确跳过的 `web_search_call` 仍不由本 shim 恢复，保持现有行为。
- merge helper 保留无 anchor 时的保守顺序对齐，供独立调用兼容；数量无法对齐时同样抛错。

工具集合仍全部注册到 AI SDK `ToolSet`，供 SDK tool-call validation 和响应解析使用。由于 SDK 会把这些工具序列化到顶层，shim 激活时还需恢复正确的 wire 位置：

- raw 没有顶层 `tools` 时，删除 SDK body 的顶层 `tools`。
- raw 同时包含顶层 `tools` 时，顶层使用 raw `tools`；`additional_tools` 仍保留在 input 中，避免联合 ToolSet 导致重复或提前可用。
- 如果 SDK input 已原生包含 `additional_tools`，不再重建 additional item，只移除代理插入的内部 anchor；SDK input 其余内容除通用 message `type` 恢复外均不修改。

## 允许的不一致

- `model` 继续由 SDK 使用路由后的 upstream model。
- SDK 对普通 message 的 content 表示和字段顺序规范化继续保留。
- JSON 空白、对象 key 顺序和 content-length 不要求与入站字节一致。

## 验收

- leading、middle、trailing 和多个 `additional_tools` 均保持原始相对位置。
- SDK 生成的非 additional input items 除补充缺失的 `type: "message"` 外保持不变。
- 所有原生 Responses 出站 SDK message items 都具有 `type: "message"`；已有 `type` 的 item 不修改。
- `additional_tools` 不再同时出现在顶层 `tools`。
- SDK 已原生输出 additional item 时不再重建该 item，仅执行通用 message `type` 恢复并移除内部 anchor。
- `reasoning.context` 保留，未请求 summary 时不再自动增加 `detailed`。
- 真实 `codex exec --profile` 成功，Reqable 入站/出站抓包验证上述结构。

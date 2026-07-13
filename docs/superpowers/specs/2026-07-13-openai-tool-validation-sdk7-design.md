# OpenAI Responses 工具校验与 AI SDK 7 兼容设计

## 目标

修复 OpenAI Responses 请求映射中因 AI SDK 7 / `@ai-sdk/openai` 4 的契约变化导致的运行时错误，使非法工具参数在调用 AI SDK 前返回请求校验错误，并让图片输入使用当前 `FilePart` 数据结构。

## 范围

- 为 `custom`、`web_search`、`tool_search` 定义明确的请求 schema。
- 保留 function tool 的现有严格校验。
- 保留其他未知 hosted tool 的最小形状透传，维持前向兼容。
- 将图片 URL 映射为 `URL`，将 data URL 和 `file_id` 映射为字符串。
- 不改变 openai-compatible provider 对 custom/tool_search 的 shim 行为。

## 校验行为

- `custom` 必须包含非空 `name`；grammar format 必须包含合法 `syntax` 和 `definition`。
- `web_search` 仅接受受支持的 context size、字符串域名数组和结构正确的 user location。
- `tool_search` 仅接受合法 execution、字符串 description 和对象 parameters。
- 已识别工具的非法输入由协议请求校验返回 400，不再进入流后产生 `AI_TypeValidationError`。

## 图片映射

- 带协议的 URL 使用 `new URL(value)`。
- data URL 保持字符串，由 AI SDK 解析媒体类型和 base64 内容。
- `file_id` 保持字符串，供 provider 处理。
- 保留现有 `imageDetail` provider option。

## 测试

- 先更新现有测试以表达 AI SDK 7 的图片结构，并确认旧实现失败。
- 为三类已识别工具补充合法与非法请求测试。
- 保留 custom tool provider args 的 `name` 回归断言。
- 运行相关协议测试、全量测试、typecheck、Prettier 和 `git diff --check`。

## 错误处理

本次不新增 catch 或降级路径。错误在 Zod 请求校验阶段产生，由现有协议错误格式化流程记录并返回，避免静默丢弃工具或在响应已开始后失败。

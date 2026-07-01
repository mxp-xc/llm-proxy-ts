# Codex Responses 支持完善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完善 `/codex/v1/responses` 对 Codex CLI 原生 API 的支持——修复被 AI SDK 静默丢弃的请求字段、补全 namespace tool 展开与 hosted tool（web_search/tool_search）的透传/渲染链路。

**Architecture:** 六个阶段递进。阶段 0 恢复 `providerExecuted` 透传（hosted tool 渲染前提）。阶段 1 把 Codex 的 namespace 嵌套 tool 展开成顶层 function tool（当前完全丢弃 → MCP 工具不可用）。阶段 2 系统性修复 snake_case → camelCase 的 providerOptions 映射（reasoning.effort 等被 zod 静默丢弃）。阶段 3-4 补全 web_search / tool_search 透传与渲染（仅 openai provider）。阶段 5 重构 renderer 的 tool-call 分支为 `providerExecuted` 通用判别。

**Tech Stack:** TypeScript, `@ai-sdk/openai@3.0.71`, Hono, Vitest, Zod v3

## Global Constraints

- 所有本地导入必须用 `.js` 扩展名（ESM + `NodeNext`）。
- `tsconfig.base.json` 启用 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`verbatimModuleSyntax`。
- 入参/返回值禁止 `unknown`（例外：工具 input/output、透传字段、SDK 不消费字段、JSON 序列化入参）。
- 错误处理节点（`catch`、错误分支）必须记日志，不得静默吞错。
- 测试用 Vitest，无网络；JS/TS 用 `pnpm`。
- 临时文件放项目根 `temp/`。
- 日志自动脱敏 `apikey`/`authorization`/`x-api-key` 等（不区分大小写）。
- provider tool 透传仅 `type:'openai'` provider 有效（走 `openaiProvider.responses()` + `prepareResponsesTools`）；`openai-compatible` 走 Chat Completions 丢弃所有 provider tool（预期降级，不修）。

## 调研依据（3 subagent + 源码验证 + [82] 真实抓包）

- `@ai-sdk/openai@3.0.71` Responses 模式对 providerOptions 字段期望 **camelCase**：`reasoningEffort`/`reasoningSummary`/`textVerbosity`/`promptCacheKey`/`store`/`metadata`/`parallelToolCalls`/`include`/`previousResponseId`/`truncation`（`node_modules/@ai-sdk/openai/dist/index.mjs:5042-5094`）。snake_case passthrough 被 zod 校验丢弃。
- `reasoningEffort` 合法值 `none|minimal|low|medium|high|xhigh`（index.mjs:4466-4482, 500）。
- web*search 响应侧：上游 `web_search_call` → AI SDK 映射成 `tool-input-start`+`tool-input-end`+`tool-call`+`tool-result` 四个 stream part，判别标志 `part.providerExecuted === true`，`toolCallId` 即上游 `web_search_call.id`（形如 `ws*...`），`tool-call.input === '{}'`，`tool-result.output`是 camelCase 的`{action:{type,query?,queries?},sources?}`（index.mjs:5726-5753, 5959-5968, 6567-6594）。
- `openai.tools.webSearch()` helper 参数仅 `externalWebAccess`/`filters`/`searchContextSize`/`userLocation`，**丢弃** Codex 的 `search_content_types`/`index_gated_web_access`（index.mjs:2475-2525）。已知限制，接受。
- `openai.tools.toolSearch()` helper 存在（id `openai.tool_search`），接受 `execution`/`description`/`parameters`（index.mjs:4763-4774）。
- namespace tool：`prepareResponsesTools` 无 `namespace` case，裸 `{type:'namespace'}` 被丢弃（index.mjs:4572-4617）。Codex 发 `{type:'namespace', name:'mcp__<server>', tools:[{type:'function', name, ...}]}`（[82] 抓包确认带 tools 子数组，子 tool 裸名）。Codex 扁平回路命名 `mcp__<server>__<tool>`（codex issue #20652）。
- `providerExecuted` 运行时未丢：`gateway.ts:51` 用 `as AsyncIterable<ProxyStreamPart>` 强转 AI SDK fullStream，`as` 不删属性，运行时 `tool-call`/`tool-input-start` 仍带 `providerExecuted`。仅在 `ProxyStreamPart` 类型定义（`aisdk-types.ts:51,60-63`）和 `stream-collector.ts:41` 收集时丢失。
- Codex 期望 `web_search_call` output item：`{type:'web_search_call', id, status, action:{type:'search'|'open_page'|'find_in_page', query?, queries?, url?, pattern?}}`。Codex 不读 `sources`，从 `message.content[].annotations` 的 `url_citation` 取 URL（codex-rs/protocol/src/models.rs）。

## 阶段优先级与确定性

| 阶段                    | 确定性                     | 用户 glm(compatible) 场景受益     | openai provider 受益 |
| ----------------------- | -------------------------- | --------------------------------- | -------------------- |
| 0 providerExecuted 类型 | 高                         | 间接（前提）                      | 是                   |
| 1 namespace flatten     | 高                         | **是**（MCP 工具可用）            | 是                   |
| 2 camelCase 字段映射    | 高                         | 部分（reasoning.effort 需验证）   | 是                   |
| 3 web_search            | 中（请求侧 helper 丢字段） | 否（compatible 丢弃 hosted tool） | 是                   |
| 4 tool_search           | 中                         | 否                                | 是                   |
| 5 renderer 重构         | 高                         | 间接                              | 是                   |

---

## File Structure

| 文件                                               | 责任                                                                 | 阶段    |
| -------------------------------------------------- | -------------------------------------------------------------------- | ------- |
| `src/providers/shared/aisdk-types.ts`              | `ProxyStreamPart` 加 `providerExecuted` 字段                         | 0       |
| `src/providers/shared/stream-collector.ts`         | `CollectedResult.toolCalls` 保留 `providerExecuted`                  | 0       |
| `src/providers/openai-responses/protocol.ts`       | namespace flatten + camelCase 字段映射 + web_search/tool_search 透传 | 1,2,3,4 |
| `src/providers/openai-responses/renderer.ts`       | web_search_call 渲染 + tool-call 分支通用判别                        | 3,5     |
| `src/providers/openai-responses/types.ts`          | `web_search_call` output item + 事件类型                             | 3,5     |
| `test/providers/openai-responses/protocol.test.ts` | namespace/字段映射/透传测试                                          | 1,2,3,4 |
| `test/providers/openai-responses/renderer.test.ts` | web_search_call 渲染测试                                             | 3,5     |
| `test/server/codex-endpoint.test.ts`               | 端到端测试                                                           | 1,3     |

---

## Task 1: 恢复 providerExecuted 透传（类型 + collector）

**Files:**

- Modify: `src/providers/shared/aisdk-types.ts:60-63`
- Modify: `src/providers/shared/stream-collector.ts:11,23,41`
- Modify: `src/providers/protocol-types.ts:26`
- Test: `test/providers/shared/stream-collector.test.ts`

**Interfaces:**

- Produces: `ProxyStreamPart` 的 `tool-call` 与 `tool-input-start` 变体新增 `providerExecuted?: boolean`；`CollectedResult.toolCalls` 与 `RenderResultInput.toolCalls` 元素新增 `providerExecuted?: boolean`。后续 Task 4 的 renderer（流式 + 非流式）依赖此字段判别 web_search_call。

- [ ] **Step 1: 写失败测试——collector 保留 providerExecuted**

在 `test/providers/shared/stream-collector.test.ts` 末尾新增（若文件不存在则创建，参考 `test/helpers/sse.js` 的 import 风格）：

```typescript
import { describe, expect, it } from 'vitest'
import { collectStreamResult } from '../../../src/providers/shared/stream-collector.js'
import type { ProxyStreamPart } from '../../../src/providers/shared/aisdk-types.js'

describe('collectStreamResult', () => {
  it('preserves providerExecuted on tool-call for hosted tools', async () => {
    async function* stream() {
      yield {
        type: 'tool-call',
        toolCallId: 'ws_1',
        toolName: 'web_search',
        input: '{}',
        providerExecuted: true,
      } as ProxyStreamPart
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 1, outputTokens: 1 },
      } as ProxyStreamPart
    }
    const result = await collectStreamResult(stream())
    expect(result.toolCalls).toEqual([
      { toolCallId: 'ws_1', toolName: 'web_search', input: {}, providerExecuted: true },
    ])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/providers/shared/stream-collector.test.ts`
Expected: FAIL — `providerExecuted` 不在 `CollectedResult.toolCalls` 元素类型上，且 collector 未收集该字段（断言 `providerExecuted: true` 不匹配）。

- [ ] **Step 3: 修改 `aisdk-types.ts`——tool-call 与 tool-input-start 加 providerExecuted**

`src/providers/shared/aisdk-types.ts` 第 60 行 `tool-input-start` 与第 63 行 `tool-call` 改为：

```typescript
  | { type: 'tool-input-start'; id: string; toolName: string; providerMetadata?: ProviderMetadata; providerExecuted?: boolean; dynamic?: boolean; title?: string }
  | { type: 'tool-input-end'; id: string; providerMetadata?: ProviderMetadata }
  | { type: 'tool-input-delta'; id: string; delta: string; providerMetadata?: ProviderMetadata }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerMetadata?: ProviderMetadata; providerExecuted?: boolean; dynamic?: boolean }
```

同时更新第 51 行注释，把"省略 AI SDK 的 toolMetadata / providerExecuted"改为"保留 providerExecuted（hosted tool 判别标志），省略 toolMetadata"。

- [ ] **Step 3b: 修改 `protocol-types.ts`——RenderResultInput.toolCalls 加 providerExecuted**

`src/providers/protocol-types.ts` 第 26 行改为：

```typescript
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean }>
```

- [ ] **Step 4: 修改 `stream-collector.ts`——CollectedResult.toolCalls 保留 providerExecuted**

`src/providers/shared/stream-collector.ts` 第 11 行 `toolCalls` 类型与第 23/41 行收集逻辑改为：

```typescript
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean }>
```

```typescript
const toolCalls: Array<{
  toolCallId: string
  toolName: string
  input: unknown
  providerExecuted?: boolean
}> = []
```

第 31-43 行 `case 'tool-call'` 改为：

```typescript
      case 'tool-call': {
        let input: unknown = part.input
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input)
          } catch {
            // 防御性：input 为畸形 JSON 时保留原始字符串。实践中 AI SDK 总提供已解析对象。
          }
        }
        const call: { toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean } = {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input,
        }
        if (part.providerExecuted) call.providerExecuted = true
        toolCalls.push(call)
        break
      }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test test/providers/shared/stream-collector.test.ts`
Expected: PASS

- [ ] **Step 6: typecheck + 全量测试无回归**

Run: `pnpm typecheck && pnpm test`
Expected: PASS（496+ 测试通过，新增 1 个）

- [ ] **Step 7: Commit**

```bash
git add src/providers/shared/aisdk-types.ts src/providers/shared/stream-collector.ts test/providers/shared/stream-collector.test.ts
git commit -m "feat(codex): preserve providerExecuted through ProxyStreamPart and collector"
```

---

## Task 2: namespace tool flatten

**Files:**

- Modify: `src/providers/openai-responses/protocol.ts:268-292`（tools 循环）
- Test: `test/providers/openai-responses/protocol.test.ts`

**Interfaces:**

- Consumes: `ResponsesFunctionTool` 类型（protocol.ts:329）、`mapResponsesFunctionTool`（protocol.ts:331）
- Produces: `mapResponsesRequestToAISDKInput` 对 `type:'namespace'` tool 展开其 `tools[]` 子工具为顶层 function tool，name 改为 `${namespace.name}__${subTool.name}`。所有 provider 类型均生效（namespace flatten 不依赖 providerType，compatible 也需要让 MCP 工具作为 function tool 可见）。

**背景：** [82] 抓包确认 namespace 形状为 `{type:'namespace', name:'mcp__node_repl', tools:[{type:'function', name:'js', parameters, description}, ...]}`。当前 `passthroughToolSchema` 放行但 mapping 阶段跳过 → MCP 工具（js/js_add_node_module_dir/js_reset）完全不可用。flatten 后作为顶层 function tool，compatible 与 openai 上游均可见。

- [ ] **Step 1: 写失败测试——namespace flatten**

在 `test/providers/openai-responses/protocol.test.ts` 的 `describe('mapResponsesRequestToAISDKInput')` 内新增：

```typescript
it('flattens namespace tools into top-level function tools with mcp__ prefix', () => {
  const result = mapResponsesRequestToAISDKInput({
    model: 'gpt-5',
    input: 'hi',
    tools: [
      { type: 'function', name: 'shell_command', parameters: { type: 'object' } },
      {
        type: 'namespace',
        name: 'mcp__node_repl',
        description: 'node repl',
        tools: [
          {
            type: 'function',
            name: 'js',
            description: 'run js',
            parameters: { type: 'object', properties: { code: { type: 'string' } } },
          },
          { type: 'function', name: 'js_reset', parameters: { type: 'object' } },
        ],
      },
    ],
  })
  expect(Object.keys(result.tools!).sort()).toEqual([
    'js_reset',
    'mcp__node_repl__js',
    'mcp__node_repl__js_reset',
    'shell_command',
  ])
  expect(result.tools!['mcp__node_repl__js']!.description).toBe('run js')
})

it('skips namespace tool without tools array', () => {
  const result = mapResponsesRequestToAISDKInput({
    model: 'gpt-5',
    input: 'hi',
    tools: [{ type: 'namespace', name: 'mcp__empty', description: 'empty' }],
  })
  expect(result.tools).toBeUndefined()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts -t "flattens namespace"`
Expected: FAIL — namespace 当前被跳过，`result.tools` 只含 `shell_command`（第一个测试）或 undefined（第二个）。

- [ ] **Step 3: 实现 namespace flatten**

`src/providers/openai-responses/protocol.ts` 第 269-291 行 tools 循环，在 `else if (ctx?.providerType === 'openai' && tool.type === 'custom')` 分支后、`// 其他非 function tool` 注释前，新增 namespace 分支：

```typescript
      } else if (tool.type === 'namespace') {
        // namespace tool：Codex 把 MCP server 的工具包成 {type:'namespace', name, tools:[function...]}。
        // AI SDK 不认 namespace tool（prepareResponsesTools 无此 case），原样透传会被丢弃 → MCP 工具不可用。
        // flatten 成顶层 function tool，name 用 mcp__<server>__<tool> 匹配 Codex 扁平回路命名（codex issue #20652）。
        // 对 compatible + openai 上游均生效（function tool 不会被丢弃）。
        const nsTool = tool as { name?: string; tools?: ResponsesFunctionTool[] }
        if (nsTool.name && Array.isArray(nsTool.tools)) {
          for (const subTool of nsTool.tools) {
            const flatName = `${nsTool.name}__${subTool.name}`
            toolSet[flatName] = mapResponsesFunctionTool({ ...subTool, name: flatName })
          }
        }
      }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts -t "namespace"`
Expected: PASS

- [ ] **Step 5: 验证不破坏已有 tools 测试**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts`
Expected: PASS（含已有 `ignores non-function tools when building ToolSet`——该测试的 namespace 无 tools 字段，命中 Step 3 的 `Array.isArray` 守卫被跳过，仍只含 `get_weather`）

- [ ] **Step 6: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/providers/openai-responses/protocol.ts test/providers/openai-responses/protocol.test.ts
git commit -m "feat(codex): flatten namespace tools into top-level function tools"
```

---

## Task 3: 系统性 camelCase providerOptions 字段映射

**Files:**

- Modify: `src/providers/openai-responses/protocol.ts:141-144`（mappedResponsesRequestKeys）、`313-324`（providerOptions 组装）
- Test: `test/providers/openai-responses/protocol.test.ts`

**Interfaces:**

- Produces: `mapResponsesRequestToAISDKInput` 把 `reasoning.effort`→`reasoningEffort`、`reasoning.summary`→`reasoningSummary`、`text.verbosity`→`textVerbosity`、`prompt_cache_key`→`promptCacheKey`、`store`→`store`、`client_metadata`→`metadata` 显式映射进 `providerOptions.openai`，并将这些 key 加入 `mappedResponsesRequestKeys`（从 passthrough 排除）。`reasoning`/`text`/`client_metadata` 不再原样透传。

**背景：** [82] 抓包顶层字段 `reasoning={effort:'xhigh'}`、`text={verbosity:'low'}`、`store=false`、`prompt_cache_key='...'`、`client_metadata={...}`。当前 `mapProviderOptions` 把它们原样塞进 `providerOptions.openai.{snake_case}`，AI SDK 的 zod schema 只认 camelCase → 全部静默丢弃。

- [ ] **Step 1: 写失败测试——camelCase 映射**

在 `test/providers/openai-responses/protocol.test.ts` 新增（替换/扩展已有 `reasoning` 相关测试，因行为改变）：

```typescript
it('maps reasoning.effort to providerOptions.openai.reasoningEffort', () => {
  const result = mapResponsesRequestToAISDKInput({
    model: 'gpt-5',
    input: 'hi',
    reasoning: { effort: 'xhigh' },
  })
  expect(result.providerOptions).toEqual({ openai: { reasoningEffort: 'xhigh' } })
})

it('maps reasoning.summary to providerOptions.openai.reasoningSummary', () => {
  const result = mapResponsesRequestToAISDKInput({
    model: 'gpt-5',
    input: 'hi',
    reasoning: { effort: 'high', summary: 'detailed' },
  })
  expect(result.providerOptions).toEqual({
    openai: { reasoningEffort: 'high', reasoningSummary: 'detailed' },
  })
})

it('maps text.verbosity to providerOptions.openai.textVerbosity', () => {
  const result = mapResponsesRequestToAISDKInput({
    model: 'gpt-5',
    input: 'hi',
    text: { verbosity: 'low' },
  })
  expect(result.providerOptions).toEqual({ openai: { textVerbosity: 'low' } })
})

it('maps prompt_cache_key to providerOptions.openai.promptCacheKey', () => {
  const result = mapResponsesRequestToAISDKInput({
    model: 'gpt-5',
    input: 'hi',
    prompt_cache_key: 'abc123',
  })
  expect(result.providerOptions).toEqual({ openai: { promptCacheKey: 'abc123' } })
})

it('maps store to providerOptions.openai.store', () => {
  const result = mapResponsesRequestToAISDKInput({
    model: 'gpt-5',
    input: 'hi',
    store: false,
  })
  expect(result.providerOptions).toEqual({ openai: { store: false } })
})

it('maps client_metadata to providerOptions.openai.metadata', () => {
  const result = mapResponsesRequestToAISDKInput({
    model: 'gpt-5',
    input: 'hi',
    client_metadata: { session_id: 's1', turn_id: 't1' },
  })
  expect(result.providerOptions).toEqual({
    openai: { metadata: { session_id: 's1', turn_id: 't1' } },
  })
})

it('combines camelCase mapped fields with passthrough unknown fields', () => {
  const result = mapResponsesRequestToAISDKInput({
    model: 'gpt-5',
    input: 'hi',
    reasoning: { effort: 'high' },
    custom_param: 'value',
  })
  expect(result.providerOptions).toEqual({
    openai: { reasoningEffort: 'high', custom_param: 'value' },
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts -t "reasoningEffort"`
Expected: FAIL — 当前 `providerOptions.openai` 是 `{reasoning:{effort:'xhigh'}}`（嵌套），断言 `{reasoningEffort:'xhigh'}` 不匹配。

- [ ] **Step 3: 扩展 mappedResponsesRequestKeys**

`src/providers/openai-responses/protocol.ts` 第 141-144 行改为：

```typescript
const mappedResponsesRequestKeys = new Set([
  'model',
  'input',
  'instructions',
  'stream',
  'temperature',
  'top_p',
  'max_output_tokens',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  // 以下字段由显式 camelCase 映射处理（AI SDK zod 只认 camelCase），不从 passthrough 透传
  'reasoning',
  'text',
  'store',
  'prompt_cache_key',
  'client_metadata',
])
```

- [ ] **Step 4: 显式 camelCase 映射**

`src/providers/openai-responses/protocol.ts` 第 313-324 行（`mapProviderOptions` 调用 + parallel_tool_calls 特殊处理）改为：

```typescript
// providerOptions key 固定为 "openai"：
// @ai-sdk/openai 始终读此 key（Responses 模式期望 camelCase 字段）；
// 其他 provider（如 @ai-sdk/openai-compatible）不认识此 key，自动忽略 → 不泄漏
const providerOptions = mapProviderOptions(request, mappedResponsesRequestKeys)
// parallel_tool_calls：AI SDK 期望 parallelToolCalls（camelCase）
if (request.parallel_tool_calls !== undefined) {
  providerOptions.parallelToolCalls = request.parallel_tool_calls
}
// reasoning.effort/summary：AI SDK 期望 reasoningEffort/reasoningSummary（扁平 camelCase），
// 非 reasoning.effort 嵌套对象（原样透传会被 zod 丢弃）
if (request.reasoning !== undefined) {
  const reasoning = request.reasoning as { effort?: string; summary?: string }
  if (reasoning.effort !== undefined) providerOptions.reasoningEffort = reasoning.effort
  if (reasoning.summary !== undefined) providerOptions.reasoningSummary = reasoning.summary
}
// text.verbosity：AI SDK 期望 textVerbosity
if (request.text !== undefined) {
  const text = request.text as { verbosity?: string }
  if (text.verbosity !== undefined) providerOptions.textVerbosity = text.verbosity
}
// store：字段名恰好匹配 AI SDK 期望（providerOptions.openai.store）
if (request.store !== undefined) {
  providerOptions.store = request.store
}
// prompt_cache_key：AI SDK 期望 promptCacheKey
if (request.prompt_cache_key !== undefined) {
  providerOptions.promptCacheKey = request.prompt_cache_key
}
// client_metadata：Codex 自定义字段，OpenAI Responses API 无 client_metadata；
// 映射到标准 metadata 字段（AI SDK 支持 metadata: z.any()），供上游观测/计费关联
if (request.client_metadata !== undefined) {
  providerOptions.metadata = request.client_metadata
}
if (Object.keys(providerOptions).length > 0) {
  input.providerOptions = { openai: providerOptions }
}
```

- [ ] **Step 5: 确认已有测试不破坏**

已有测试不受影响：`passes unknown fields as providerOptions.openai`（断言 `custom_param` 走 passthrough）仍成立；`maps reasoning items with encrypted_content to reasoning parts`（input item mapping，非 providerOptions）不冲突。无已有测试断言 `reasoning`/`text` 原样透传到 providerOptions，无需更新。

Run: `pnpm test test/providers/openai-responses/protocol.test.ts`
Expected: PASS（所有新测试 + 已有测试）

- [ ] **Step 6: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/providers/openai-responses/protocol.ts test/providers/openai-responses/protocol.test.ts
git commit -m "fix(codex): map reasoning/text/store/prompt_cache_key/client_metadata to camelCase providerOptions"
```

---

## Task 4: web_search 透传 + web_search_call 渲染

**Files:**

- Modify: `src/providers/openai-responses/protocol.ts:275-289`（tools 循环加 web_search 分支）
- Modify: `src/providers/openai-responses/renderer.ts`（web_search_call 渲染分支）
- Modify: `src/providers/openai-responses/types.ts`（web_search_call 类型）
- Test: `test/providers/openai-responses/protocol.test.ts`、`test/providers/openai-responses/renderer.test.ts`、`test/server/codex-endpoint.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `providerExecuted` 字段；`openai.tools.webSearch()`（`@ai-sdk/openai`）
- Produces: 请求侧 `type:'web_search'` tool（仅 openai provider）经 `openai.tools.webSearch()` 包装透传；响应侧 renderer 把 `providerExecuted===true` 的 tool-call + 配对 tool-result 渲染成 `{type:'web_search_call', id, status, action}` output item。

**已知限制：** `openai.tools.webSearch()` 丢弃 Codex 的 `search_content_types`/`index_gated_web_access`（helper schema 不认）。web_search 仍工作，仅返回内容类型用上游默认。请求侧仅 openai provider 透传；compatible 丢弃（预期降级）。

- [ ] **Step 1: 写失败测试——请求侧 web_search 透传（openai provider）**

`test/providers/openai-responses/protocol.test.ts` 新增：

```typescript
it('passes web_search tool through for openai provider', () => {
  const result = mapResponsesRequestToAISDKInput(
    {
      model: 'gpt-5',
      input: 'hi',
      tools: [
        { type: 'function', name: 'shell_command', parameters: { type: 'object' } },
        { type: 'web_search', external_web_access: true, search_content_types: ['text', 'image'] },
      ],
    },
    { providerType: 'openai' },
  )
  expect(Object.keys(result.tools!).sort()).toEqual(['shell_command', 'web_search'])
})

it('skips web_search tool for openai-compatible provider', () => {
  const result = mapResponsesRequestToAISDKInput(
    {
      model: 'gpt-5',
      input: 'hi',
      tools: [{ type: 'web_search', external_web_access: true }],
    },
    { providerType: 'openai-compatible' },
  )
  expect(result.tools).toBeUndefined()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts -t "web_search tool through"`
Expected: FAIL — web_search 当前被跳过，`result.tools` 只含 `shell_command`。

- [ ] **Step 3: 请求侧 web_search 透传**

`src/providers/openai-responses/protocol.ts` tools 循环（Task 2 已加 namespace 分支后），在 namespace 分支后新增：

```typescript
      } else if (ctx?.providerType === 'openai' && tool.type === 'web_search') {
        // web_search hosted tool：@ai-sdk/openai webSearch helper 透传（仅 openai provider，
        // openai-compatible 走 Chat Completions 丢弃 hosted tool）。
        // 已知限制：helper schema 不认 search_content_types / index_gated_web_access，被丢弃。
        const wsTool = tool as {
          external_web_access?: boolean
          search_context_size?: 'low' | 'medium' | 'high'
          filters?: { allowed_domains?: string[] }
          user_location?: { type?: string; country?: string; region?: string; city?: string; timezone?: string }
        }
        const args: Parameters<typeof openai.tools.webSearch>[0] = {}
        if (wsTool.external_web_access !== undefined) args.externalWebAccess = wsTool.external_web_access
        if (wsTool.search_context_size !== undefined) args.searchContextSize = wsTool.search_context_size
        if (wsTool.filters !== undefined) args.filters = wsTool.filters
        if (wsTool.user_location !== undefined) args.userLocation = wsTool.user_location as Parameters<typeof openai.tools.webSearch>[0]['userLocation']
        toolSet['web_search'] = openai.tools.webSearch(args) as ToolSet[string]
      }
```

- [ ] **Step 4: 运行请求侧测试确认通过**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts -t "web_search tool through"`
Expected: PASS

- [ ] **Step 5: 写失败测试——响应侧 web_search_call 渲染**

`test/providers/openai-responses/renderer.test.ts` 新增：

```typescript
// web_search_call 渲染：AI SDK 把上游 web_search_call 映射成 tool-call(providerExecuted:true) + tool-result 对
async function* webSearchCallStream() {
  yield { type: 'tool-input-start', id: 'ws_1', toolName: 'web_search', providerExecuted: true }
  yield { type: 'tool-input-end', id: 'ws_1' }
  yield {
    type: 'tool-call',
    toolCallId: 'ws_1',
    toolName: 'web_search',
    input: '{}',
    providerExecuted: true,
  }
  yield {
    type: 'tool-result',
    toolCallId: 'ws_1',
    toolName: 'web_search',
    output: { action: { type: 'search', query: 'rust async' } },
  }
  yield {
    type: 'finish',
    finishReason: 'stop',
    totalUsage: { inputTokens: 5, outputTokens: 5 },
    response: { id: 'resp_ws' },
  }
}

it('renders web_search tool-call + tool-result as web_search_call output item', async () => {
  const stream = renderOpenAIResponseSSE({
    model: 'gpt-5',
    stream: webSearchCallStream() as AsyncIterable<ProxyStreamPart>,
  })
  const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
  const done = events.find((e) => e.event === 'response.output_item.done')
  const item = (done!.data as ResponseOutputItemDoneEvent).item
  expect(item.type).toBe('web_search_call')
  if (item.type === 'web_search_call') {
    expect(item.id).toBe('ws_1')
    expect(item.status).toBe('completed')
    expect(item.action).toEqual({ type: 'search', query: 'rust async' })
  }
})
```

需在文件顶部 import 加 `ResponseWebSearchCall`（若类型导出）或用 inline 断言。

- [ ] **Step 6: 运行测试确认失败**

Run: `pnpm test test/providers/openai-responses/renderer.test.ts -t "web_search_call"`
Expected: FAIL — 当前 `providerExecuted===true` 的 tool-call 被当 function_call 渲染（isCustomToolName('web_search')=false）。

- [ ] **Step 7: types.ts 加 web_search_call 类型**

`src/providers/openai-responses/types.ts` 在 `ResponseCustomToolCall` 后新增：

```typescript
export interface ResponseWebSearchAction {
  type: 'search' | 'open_page' | 'find_in_page'
  query?: string
  queries?: string[]
  url?: string
  pattern?: string
}

export interface ResponseWebSearchCall {
  id: string
  type: 'web_search_call'
  status: 'completed' | 'incomplete'
  action: ResponseWebSearchAction | null
}
```

`ResponseOutputItem` 联合（第 33 行）加 `| ResponseWebSearchCall`。

streaming `StreamOutputItem`（第 107 行）加 `StreamWebSearchCallItem`：

```typescript
interface StreamWebSearchCallItem {
  id: string
  type: 'web_search_call'
  status: string
  action: ResponseWebSearchAction | null
}
```

- [ ] **Step 8: renderer 加 web_search_call 渲染分支**

`src/providers/openai-responses/renderer.ts`：

a) 顶部 import 加 `ResponseWebSearchCall`、`ResponseWebSearchAction`，`export type {}` 加 `ResponseWebSearchCall`。

b) 在 `isCustomToolName` 后新增 hosted tool 判别：

```typescript
/** 判别 hosted tool（web_search 等）：AI SDK 把上游 web_search_call 映射成 tool-call(providerExecuted:true)。
 *  providerExecuted 是 hosted tool 的决定性标志（function/custom tool 的 tool-call 不带此字段）。 */
function isHostedToolCall(part: { providerExecuted?: boolean }): boolean {
  return part.providerExecuted === true
}

/** 把 AI SDK tool-result.output（camelCase）还原成 Codex 期望的 web_search_call.action（snake_case）。 */
function mapWebSearchAction(output: unknown): ResponseWebSearchAction | null {
  if (!output || typeof output !== 'object') return null
  const o = output as {
    action?: { type?: string; query?: string; queries?: string[]; url?: string; pattern?: string }
  }
  const a = o.action
  if (!a || typeof a.type !== 'string') return null
  const action: ResponseWebSearchAction = { type: a.type as ResponseWebSearchAction['type'] }
  if (a.query !== undefined) action.query = a.query
  if (a.queries !== undefined) action.queries = a.queries
  if (a.url !== undefined) action.url = a.url
  if (a.pattern !== undefined) action.pattern = a.pattern
  return action
}
```

c) 新增 hosted toolCallId 跟踪 Set。在 `toolCallStartEmitted` 声明旁（第 92 行）加：

```typescript
const hostedToolCallIds = new Set<string>()
```

d) `tool-input-start` 分支（第 217 行）：在现有 fcId/added 逻辑前加 hosted 判断——hosted tool 记录 toolCallId 后 `continue`，added 留到 tool-call 时发（避免与 function/custom 的 added 冲突）：

```typescript
if (part.type === 'tool-input-start') {
  const toolCallId = part.id
  const toolName = part.toolName
  if (isHostedToolCall(part)) {
    hostedToolCallIds.add(toolCallId)
    continue
  }
  // ... 现有 fcId / contentPartStarted 关闭 / added 逻辑不变
}
```

e) `tool-input-delta` 分支（第 258 行）开头加守卫——hosted tool 无 input delta，跳过：

```typescript
if (part.type === 'tool-input-delta') {
  const toolCallId = part.id
  if (toolCallId != null && hostedToolCallIds.has(toolCallId)) continue
  // ... 现有逻辑不变
}
```

f) `tool-call` 分支（第 280 行）改为先判 hosted——hosted 时关闭前置 text message、发 `output_item.added`（action=null），然后 `continue`（done 等 tool-result）：

```typescript
      if (part.type === 'tool-call') {
        const toolCallId = part.toolCallId
        const toolName = part.toolName

        if (isHostedToolCall(part)) {
          // web_search 等 hosted tool：AI SDK 把上游 web_search_call 拆成 tool-call + tool-result 对。
          // tool-call 时发 added（action 未知），tool-result 时发 done（带 action）。
          if (contentPartStarted) {
            yield { event: 'response.output_text.done', data: { type: 'response.output_text.done', sequence_number: nextSeq(), item_id: currentMsgId, output_index: outputIndex, content_index: 0, text: fullText } }
            yield { event: 'response.content_part.done', data: { type: 'response.content_part.done', sequence_number: nextSeq(), item_id: currentMsgId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } } }
            yield { event: 'response.output_item.done', data: { type: 'response.output_item.done', sequence_number: nextSeq(), output_index: outputIndex, item: { id: currentMsgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] } } }
            outputIndex++
            outputItemStarted = false
            contentPartStarted = false
          }
          yield { event: 'response.output_item.added', data: {
            type: 'response.output_item.added', sequence_number: nextSeq(), output_index: outputIndex,
            item: { id: toolCallId, type: 'web_search_call', status: 'in_progress', action: null },
          } }
          continue
        }

        // 以下现有 function/custom 渲染逻辑不变（fcId、args、added、delta、done）
        const fcId = toolCallFcIds.get(toolCallId) ?? `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        // ...
      }
```

g) 新增 `tool-result` 分支（在 tool-call 分支后、finish 分支前）——hosted tool 结果到达时发 done（带 action）：

```typescript
      if (part.type === 'tool-result' && hostedToolCallIds.has(part.toolCallId)) {
        // hosted tool 结果到达：发 done（带 action），item id 用 toolCallId 即上游 ws_ id
        const action = mapWebSearchAction(part.output)
        yield { event: 'response.output_item.done', data: {
          type: 'response.output_item.done', sequence_number: nextSeq(), output_index: outputIndex,
          item: { id: part.toolCallId, type: 'web_search_call', status: 'completed', action },
        } }
        streamedToolCalls.push({
          id: part.toolCallId, type: 'web_search_call', status: 'completed', action,
        } as ResponseWebSearchCall)
        outputIndex++
        hostedToolCallIds.delete(part.toolCallId)
      }
```

h) `streamedToolCalls` 类型（第 87 行）扩展：`Array<ResponseFunctionToolCall | ResponseCustomToolCall | ResponseWebSearchCall>`

i) `renderOpenAIResponse` 非流式（第 534 行起）toolCalls 循环加 hosted 分支：

```typescript
      if (call.providerExecuted === true) {
        output.push({
          id: call.toolCallId,
          type: 'web_search_call',
          status: 'completed',
          action: null,  // 非流式 generateText 无 tool-result 配对，action 未知
        })
      } else if (isCustomToolName(call.toolName)) {
        // ... 现有 custom_tool_call
```

- [ ] **Step 9: 运行响应侧测试确认通过**

Run: `pnpm test test/providers/openai-responses/renderer.test.ts -t "web_search_call"`
Expected: PASS

- [ ] **Step 10: 端到端测试**

`test/server/codex-endpoint.test.ts` 新增：

```typescript
it('renders web_search_call for openai provider hosted tool', async () => {
  const settings = makeSettings({
    openai: {
      type: 'openai',
      apiKey: 'secret',
      headers: {},
      plugins: [],
      models: { chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] } },
    },
  })
  const gateway = makeGateway({
    stream() {
      return (async function* () {
        yield {
          type: 'tool-call',
          toolCallId: 'ws_1',
          toolName: 'web_search',
          input: '{}',
          providerExecuted: true,
        }
        yield {
          type: 'tool-result',
          toolCallId: 'ws_1',
          toolName: 'web_search',
          output: { action: { type: 'search', query: 'test' } },
        }
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: { inputTokens: 5, outputTokens: 5 },
        }
      })() as AsyncIterable<ProxyStreamPart>
    },
  })
  const app = createApp({ settings, gateway, providerRegistry: stubRegistry })
  const body = JSON.stringify({
    model: 'openai/chat',
    input: 'hi',
    stream: true,
    tools: [{ type: 'web_search', external_web_access: true }],
  })
  const res = await app.request('/codex/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain('web_search_call')
  expect(text).not.toContain('"function_call"')
})
```

- [ ] **Step 11: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add src/providers/openai-responses/protocol.ts src/providers/openai-responses/renderer.ts src/providers/openai-responses/types.ts test/providers/openai-responses/protocol.test.ts test/providers/openai-responses/renderer.test.ts test/server/codex-endpoint.test.ts
git commit -m "feat(codex): pass web_search through for openai provider and render web_search_call"
```

---

## Task 5: tool_search 透传

**Files:**

- Modify: `src/providers/openai-responses/protocol.ts`（tools 循环加 tool_search 分支）
- Test: `test/providers/openai-responses/protocol.test.ts`

**Interfaces:**

- Consumes: `openai.tools.toolSearch()`（`@ai-sdk/openai`）
- Produces: `type:'tool_search'` tool（仅 openai provider）经 `openai.tools.toolSearch()` 包装透传。

**背景：** [82] 抓包 tool_search 形状 `{type:'tool_search', execution:'client', description, parameters:{...}}`。AI SDK 有 `openai.tools.toolSearch()` helper（id `openai.tool_search`，index.mjs:4763-4774）。当前被 filter 掉。

- [ ] **Step 1: 实施前验证 helper 签名**

Run: `node -e "const {openai}=require('@ai-sdk/openai'); console.log(typeof openai.tools.toolSearch)"`
Expected: `function`（确认 helper 存在）。若不存在，回退：tool_search 跳过（当前行为），本 Task 取消。

进一步读源码确认参数：

Run: `grep -n "toolSearch" node_modules/@ai-sdk/openai/dist/index.mjs | head -20`
Expected: 看到 `toolSearch` 的 schema 定义，确认接受 `execution`/`description`/`parameters` 字段名。

- [ ] **Step 2: 写失败测试**

`test/providers/openai-responses/protocol.test.ts` 新增：

```typescript
it('passes tool_search tool through for openai provider', () => {
  const result = mapResponsesRequestToAISDKInput(
    {
      model: 'gpt-5',
      input: 'hi',
      tools: [
        {
          type: 'tool_search',
          execution: 'client',
          description: 'Tool discovery',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    },
    { providerType: 'openai' },
  )
  expect(Object.keys(result.tools!)).toEqual(['tool_search'])
})

it('skips tool_search tool for openai-compatible provider', () => {
  const result = mapResponsesRequestToAISDKInput(
    {
      model: 'gpt-5',
      input: 'hi',
      tools: [{ type: 'tool_search', execution: 'client' }],
    },
    { providerType: 'openai-compatible' },
  )
  expect(result.tools).toBeUndefined()
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts -t "tool_search tool through"`
Expected: FAIL — tool_search 当前被跳过。

- [ ] **Step 4: 实现 tool_search 透传**

`src/providers/openai-responses/protocol.ts` tools 循环，在 web_search 分支后新增（字段名以 Step 1 源码确认结果为准，此处假设 helper 接受 `execution`/`description`/`parameters`）：

```typescript
      } else if (ctx?.providerType === 'openai' && tool.type === 'tool_search') {
        // tool_search hosted tool：@ai-sdk/openai toolSearch helper 透传（仅 openai provider）。
        const tsTool = tool as {
          execution?: string
          description?: string
          parameters?: Record<string, unknown>
        }
        const args: Parameters<typeof openai.tools.toolSearch>[0] = {}
        if (tsTool.execution !== undefined) args.execution = tsTool.execution as Parameters<typeof openai.tools.toolSearch>[0]['execution']
        if (tsTool.description !== undefined) args.description = tsTool.description
        if (tsTool.parameters !== undefined) args.parameters = tsTool.parameters
        toolSet['tool_search'] = openai.tools.toolSearch(args) as ToolSet[string]
      }
```

注：若 Step 1 确认 helper 参数名不同（如 `executionMode` 而非 `execution`），按实际调整。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts -t "tool_search"`
Expected: PASS

- [ ] **Step 6: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/providers/openai-responses/protocol.ts test/providers/openai-responses/protocol.test.ts
git commit -m "feat(codex): pass tool_search through for openai provider"
```

---

## Task 6: renderer tool-call 分支通用判别重构

**Files:**

- Modify: `src/providers/openai-responses/renderer.ts`（`isCustomToolName` 硬编码 → 通用判别）
- Test: `test/providers/openai-responses/renderer.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `providerExecuted`、Task 4 的 `isHostedToolCall`
- Produces: renderer tool-call 分支判别统一为三档：`providerExecuted===true`（web_search 等 hosted）→ web_search_call；`isCustomToolName(toolName)`（apply_patch）→ custom_tool_call；其余 → function_call。`isCustomToolName` 改为基于已声明 custom tool 集合的判别（当前硬编码 `'apply_patch'`）。

**背景：** 当前 `isCustomToolName(toolName) => toolName === 'apply_patch'` 硬编码。apply_patch 之外的自定义 custom tool（如未来其他 grammar tool）会被误判为 function_call。应改为：renderer 接收已声明的 custom tool name 集合，或基于 `providerMetadata.openai.toolCallType === 'custom'` 判别。

- [ ] **Step 1: 实施前验证 custom_tool_call 的判别信号**

读 AI SDK 源码确认上游 custom_tool_call 映射的 tool-call part 是否带 `providerMetadata.openai.toolCallType === 'custom'` 或类似标志：

Run: `grep -n "toolCallType\|custom_tool_call\|customTool" node_modules/@ai-sdk/openai/dist/index.mjs | head -20`
Expected: 确认 custom_tool_call 的 tool-call part 是否有可判别的 providerMetadata 字段。

- [ ] **Step 2: 写测试——非 apply_patch 的 custom tool 也能渲染为 custom_tool_call**

根据 Step 1 结果决定判别方式。若 providerMetadata 可用，测试改为：

```typescript
it('renders custom tool by providerMetadata.toolCallType, not just apply_patch name', async () => {
  async function* customStream() {
    yield {
      type: 'tool-call',
      toolCallId: 'call_1',
      toolName: 'my_grammar_tool',
      input: JSON.stringify('payload'),
      providerMetadata: { openai: { toolCallType: 'custom' } },
    }
    yield {
      type: 'finish',
      finishReason: 'tool-calls',
      totalUsage: { inputTokens: 5, outputTokens: 5 },
      response: { id: 'resp_c' },
    }
  }
  const stream = renderOpenAIResponseSSE({
    model: 'gpt-5',
    stream: customStream() as AsyncIterable<ProxyStreamPart>,
  })
  const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
  const done = events.find((e) => e.event === 'response.output_item.done')
  expect((done!.data as ResponseOutputItemDoneEvent).item.type).toBe('custom_tool_call')
})
```

若 Step 1 确认无 providerMetadata 信号，则保持 `isCustomToolName` 但改为接收外部传入的 custom tool name 集合（由 `renderStreamSSE` 入参传入，protocol 层收集已声明的 custom tool name）。此路径需改 `renderStreamSSE` 签名 + `handle-protocol.ts` 调用，改动较大，优先用 providerMetadata 方案。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test test/providers/openai-responses/renderer.test.ts -t "custom tool by providerMetadata"`
Expected: FAIL（若用 providerMetadata 方案，当前不读该字段，my_grammar_tool 被当 function_call）。

- [ ] **Step 4: 重构 isCustomToolName**

`src/providers/openai-responses/renderer.ts` 改 `isCustomToolName` 为基于 providerMetadata 的判别（若 Step 1 确认可行）：

```typescript
/** 判别 custom tool（apply_patch 等 freeform grammar tool）：
 *  - 优先看 providerMetadata.openai.toolCallType === 'custom'（AI SDK 对 custom_tool_call 的标志）
 *  - 回退到 toolName === 'apply_patch'（Codex 的 apply_patch 总是 custom tool） */
function isCustomToolCall(part: {
  toolName: string
  providerMetadata?: { openai?: { toolCallType?: string } }
}): boolean {
  if (part.providerMetadata?.openai?.toolCallType === 'custom') return true
  return part.toolName === 'apply_patch'
}
```

把 `tool-call`/`tool-input-start`/`tool-input-delta` 分支里所有 `isCustomToolName(toolName)` 调用改为 `isCustomToolCall(part)`（注意传入完整 part 而非 toolName）。保留 `isCustomToolName` 用于非流式 `renderOpenAIResponse`（无 providerMetadata 时回退 toolName 判别）。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test test/providers/openai-responses/renderer.test.ts`
Expected: PASS（新测试 + 已有 apply_patch 测试仍通过）

- [ ] **Step 6: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/providers/openai-responses/renderer.ts test/providers/openai-responses/renderer.test.ts
git commit -m "refactor(codex): discriminate custom_tool_call by providerMetadata.toolCallType"
```

---

## 验证（全计划完成后）

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全量通过（496 + 新增约 15 个）
- [ ] [82] 真实请求端到端 200（compatible provider 不破坏，reasoning/text/store/prompt_cache_key 透传不 400）
- [ ] openai provider 端到端：apply_patch → custom_tool_call；web_search → web_search_call；namespace flatten 后 MCP 工具可见

## 范围外（后续，不在本计划）

- `openai-compatible` provider 的 reasoning.effort 支持（Chat Completions 的 reasoning_effort 透传）——需单独验证 AI SDK openai-compatible 是否读 providerOptions
- web_search 请求侧 `search_content_types` 透传（AI SDK helper 不支持，需上游 AI SDK 增强）
- `previous_response_id` / `truncation`（Codex 当前未发，若发需显式映射）
- namespace flatten 的回路命名验证（`mcp__<server>__<tool>` 是否被 Codex 接受，需真实 MCP 工具调用回路测试）

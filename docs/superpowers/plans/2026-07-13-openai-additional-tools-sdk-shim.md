# OpenAI Responses additional_tools SDK Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保持 AI SDK 主导出站 body，同时让 Codex 的 per-message `additional_tools` 保留任意位置语义、普通 message 保留 `type: "message"`，并补齐 SDK 已支持的 reasoning 映射。

**Architecture:** 请求仍完整进入 `mapResponsesRequestToAISDKInput` 和 AI SDK，所有工具继续注册到 `ToolSet`。原生 OpenAI mapping 在 `additional_tools` 位置加入内部 anchor，final fetch 在 SDK body 基础上原位替换 anchor、恢复缺失的 message `type`，并清理由这些 input tools 产生的重复顶层工具；reasoning 差异通过 SDK provider options 修复。

**Tech Stack:** TypeScript、Vercel AI SDK 7、`@ai-sdk/openai` 4、Vitest、Hono、Zod、Bun。

## Global Constraints

- 仅修改原生 `openai` provider 的 Responses execution override；`openai-compatible` 和 `anthropic` 行为不变。
- SDK body 为权威基础；不得用整个 raw body 或整个 raw input 覆盖 SDK body。
- 本任务不升级依赖；隔离实验已确认最新稳定版不支持 `additional_tools`。
- 错误分支必须由现有错误链记录完整错误对象和堆栈，不允许静默回退到错误位置。
- 测试使用 Vitest 且无真实网络；最终 E2E 才使用本地 proxy、Codex profile 和 Reqable。
- 未经用户明确批准，不执行 `git commit`、`git push`、分支或 worktree 写操作。

---

### Task 1: 通过 SDK provider options 保留 reasoning 契约

**Files:**

- Modify: `src/providers/openai-responses/protocol.ts:1084`
- Test: `test/providers/openai-responses/protocol.test.ts`

**Interfaces:**

- Consumes: `OpenAIResponsesRequest.reasoning`
- Produces: `providerOptions.openai.reasoningContext` 与 nullable `reasoningSummary`

- [x] **Step 1: 写失败测试**

在 `mapResponsesRequestToAISDKInput` 的 provider options 测试组加入：

```typescript
it('maps reasoning.context and suppresses the SDK default summary when omitted', () => {
  const result = mapResponsesRequestToAISDKInput(
    {
      model: 'gpt-5.6',
      input: 'hello',
      reasoning: { effort: 'medium', context: 'all_turns' },
    } as OpenAIResponsesRequest,
    'openai',
  )

  expect(result.providerOptions?.openai).toMatchObject({
    reasoningEffort: 'medium',
    reasoningContext: 'all_turns',
    reasoningSummary: null,
  })
})

it('keeps an explicitly requested reasoning summary', () => {
  const result = mapResponsesRequestToAISDKInput(
    {
      model: 'gpt-5.6',
      input: 'hello',
      reasoning: { effort: 'medium', context: 'current_turn', summary: 'auto' },
    } as OpenAIResponsesRequest,
    'openai',
  )

  expect(result.providerOptions?.openai).toMatchObject({
    reasoningEffort: 'medium',
    reasoningContext: 'current_turn',
    reasoningSummary: 'auto',
  })
})
```

- [x] **Step 2: 运行测试并确认失败**

Run: `bun run test test/providers/openai-responses/protocol.test.ts -t "reasoning.context|explicitly requested reasoning summary"`

Expected: 第一条缺少 `reasoningContext`，且 `reasoningSummary` 不是 `null`。

- [x] **Step 3: 补齐 SDK 映射**

扩展现有 reasoning 映射，不改变 SDK schema 校验：

```typescript
const reasoning = request.reasoning as {
  effort?: string
  summary?: string
  context?: string
}
if (reasoning.effort !== undefined) providerOptions.reasoningEffort = reasoning.effort
if (reasoning.context !== undefined) providerOptions.reasoningContext = reasoning.context
providerOptions.reasoningSummary = reasoning.summary ?? null
```

- [x] **Step 4: 验证协议测试**

Run: `bun run test test/providers/openai-responses/protocol.test.ts`

Expected: 全部通过。

---

### Task 2: 为 SDK body 增加幂等 additional_tools input patch

**Files:**

- Modify: `src/providers/openai-responses/passthrough.ts:112`
- Test: `test/server/passthrough-openai.test.ts`

**Interfaces:**

- Produces: `patchAdditionalToolsInput(sdkBody: Record<string, unknown>, rawBody: Record<string, unknown>): Record<string, unknown>`，仅供 `mergeOpenAIResponsesRequestBody` 调用。
- Contract: SDK 已原生输出 additional item 时不重建该 item，只恢复缺失的 message `type` 并移除内部 anchor；anchor 数量不一致或 fallback 无法可靠对齐时抛错。

- [x] **Step 1: 写 input patch 失败测试**

新增 table test，固定 SDK items 用 `sdk-a`、`sdk-b`、`sdk-c` 标识：

```typescript
it.each([
  {
    name: 'leading',
    rawInput: [
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'a' }] },
      { type: 'message', role: 'user', content: 'a' },
    ],
    sdkInput: [{ role: 'user', content: 'sdk-a' }],
    expectedTypes: ['additional_tools', 'message'],
  },
  {
    name: 'middle',
    rawInput: [
      { type: 'message', role: 'developer', content: 'a' },
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'b' }] },
      { type: 'message', role: 'user', content: 'b' },
    ],
    sdkInput: [
      { role: 'developer', content: 'sdk-a' },
      { role: 'user', content: 'sdk-b' },
    ],
    expectedTypes: ['message', 'additional_tools', 'message'],
  },
  {
    name: 'trailing and repeated',
    rawInput: [
      { type: 'message', role: 'user', content: 'a' },
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'b' }] },
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'c' }] },
    ],
    sdkInput: [{ role: 'user', content: 'sdk-a' }],
    expectedTypes: ['message', 'additional_tools', 'additional_tools'],
  },
])(
  'injects $name additional_tools without replacing SDK messages',
  ({ rawInput, sdkInput, expectedTypes }) => {
    const merged = mergeOpenAIResponsesRequestBody(
      { model: 'upstream', input: sdkInput, tools: [{ type: 'function', name: 'a' }] },
      { model: 'route/model', input: rawInput },
    )

    expect(
      (merged.input as Array<Record<string, unknown>>).map((item) => item.type ?? item.role),
    ).toEqual(expectedTypes)
    expect(JSON.stringify(merged.input)).toContain('sdk-a')
    expect(merged).not.toHaveProperty('tools')
  },
)
```

- [x] **Step 2: 写幂等、混合 tools 与错误测试**

```typescript
it('trusts SDK-native additional_tools while restoring missing message types', () => {
  const nativeAdditionalTools = { type: 'additional_tools', role: 'developer', tools: [] }
  const merged = mergeOpenAIResponsesRequestBody(
    {
      model: 'upstream',
      input: [nativeAdditionalTools, { role: 'user', content: 'sdk' }],
      tools: [{ type: 'function', name: 'sdk' }],
    },
    { model: 'route/model', input: [{ type: 'additional_tools', role: 'developer', tools: [] }] },
  )
  expect(merged.input).toEqual([
    nativeAdditionalTools,
    { type: 'message', role: 'user', content: 'sdk' },
  ])
  expect(merged.tools).toEqual([{ type: 'function', name: 'sdk' }])
})

it('keeps raw top-level tools separate from input additional_tools', () => {
  const rawTopTools = [{ type: 'function', name: 'top' }]
  const merged = mergeOpenAIResponsesRequestBody(
    {
      model: 'upstream',
      input: [{ role: 'user', content: 'sdk' }],
      tools: [
        { type: 'function', name: 'top' },
        { type: 'function', name: 'later' },
      ],
    },
    {
      model: 'route/model',
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [{ type: 'function', name: 'later' }],
        },
        { type: 'message', role: 'user', content: 'raw' },
      ],
      tools: rawTopTools,
    },
  )
  expect(merged.tools).toEqual(rawTopTools)
})

it('throws when raw and SDK input items cannot be aligned safely', () => {
  expect(() =>
    mergeOpenAIResponsesRequestBody(
      { model: 'upstream', input: [] },
      {
        model: 'route/model',
        input: [
          { type: 'message', role: 'user', content: 'raw' },
          { type: 'additional_tools', role: 'developer', tools: [] },
        ],
      },
    ),
  ).toThrow('Cannot align additional_tools with SDK input')
})
```

- [x] **Step 3: 运行测试并确认失败**

Run: `bun run test test/server/passthrough-openai.test.ts -t "additional_tools|align"`

Expected: 现有 merge 不会插入 input item，且保留了错误的顶层 tools。

- [x] **Step 4: 实现最小幂等 patch**

在 native mapping 中为每个 additional item 放置带随机 UUID 文本与 `phase: "commentary"` 的 assistant anchor；在 `passthrough.ts` 增加窄 helper，于 `mergeOpenAIResponsesRequestBody` 返回前先为无 `type` 的 SDK message item 恢复 `type: "message"`，再将 anchor 原位替换。`phase` 标记不会在 `conversation` 或 `store` 模式下被 SDK 过滤。保留无 anchor 时的顺序对齐作为独立 merge helper 的兼容 fallback。

在现有 raw-only 顶层字段合并与 web search patch 完成后执行：

```typescript
return patchAdditionalToolsInput(merged, rawBody)
```

- [x] **Step 5: 运行 passthrough 测试**

Run: `bun run test test/server/passthrough-openai.test.ts`

Expected: 全部通过。

---

### Task 3: 覆盖真实 SDK 序列化与服务接线

**Files:**

- Modify: `test/server/passthrough-openai.test.ts`
- Verify: `src/providers/openai-responses/passthrough.ts`

**Interfaces:**

- Verifies: `/codex/v1/responses` → provider registry → AI SDK → custom fetch 的完整 request-body 路径。

- [x] **Step 1: 写 SDK stub-fetch 集成测试**

沿用测试文件现有 `vi.stubGlobal('fetch', ...)` 和真实 `createProviderRegistry` 模式，发送包含 middle `additional_tools`、reasoning context 和显式 marker 的请求。捕获 final fetch body 后断言：

```typescript
expect(forwardedBody?.model).toBe('gpt-5')
expect(forwardedBody?.reasoning).toEqual({ effort: 'medium', context: 'all_turns' })
expect(forwardedBody).not.toHaveProperty('tools')
expect(
  (forwardedBody?.input as Array<Record<string, unknown>>).map((item) => item.type ?? item.role),
).toEqual(['message', 'additional_tools', 'message'])
expect(forwardedBody?.input).toEqual([
  { type: 'message', role: 'developer', content: 'sdk-normalized developer content' },
  expect.objectContaining({ type: 'additional_tools', role: 'developer' }),
  expect.objectContaining({ type: 'message', role: 'user' }),
])
```

测试中的 mock response 使用现有 `makeRawResponseBody()`，不得访问真实网络。

- [x] **Step 2: 运行集成测试并完成 red-green**

Run: `bun run test test/server/passthrough-openai.test.ts -t "preserves positional additional_tools"`

Expected before implementation: FAIL；Task 1-2 完成后 PASS。

- [x] **Step 3: 覆盖 non-streaming 与 streaming**

同一 fixture 分别以 `stream: false` 和 `stream: true` 执行；streaming mock 使用现有 SSE fixture。两条路径必须捕获相同 request body 结构，仅 `stream` 值不同。

- [x] **Step 4: 运行相关回归**

Run: `bun run test test/providers/openai-responses/protocol.test.ts test/server/passthrough-openai.test.ts test/server/codex-endpoint.test.ts`

Expected: 全部通过。

---

### Task 4: 全量验证与真实 Codex 双边界验收

**Files:**

- Verify only;不修改业务文件。

- [x] **Step 1: 静态与格式验证**

Run: `bun run typecheck`

Expected: exit code 0。

Run: `bun run format:check`

Expected: exit code 0。

Run: `git diff --check`

Expected: 无输出。

- [x] **Step 2: 全量测试**

Run: `bun run test`

Expected: 本任务相关测试全部通过；若仓库已有 Windows 环境测试失败，必须记录具体测试名，并确认升级实验基线中存在相同失败，不得笼统宣称全绿。

- [x] **Step 3: 按 codex-profile-e2e 启动隔离 proxy**

使用临时 profile 指向 `http://127.0.0.1:<port>/codex/v1`，显式选择 `openai/<model>`，prompt 使用唯一 marker。不得复用或终止其他工作区的 proxy。

- [x] **Step 4: Reqable 双边界抓包**

启用 capture 后运行一次真实 `codex exec --profile`，以唯一 marker 精确定位：

- 入站 `POST /codex/v1/responses`。
- 出站 provider `POST /v1/responses`。

逐项断言：

- 出站 `model` 为 upstream model。
- `additional_tools` 数量、内容和 input 相对位置与入站一致。
- 出站没有由 input tools 产生的重复顶层 `tools`。
- `reasoning.context` 一致，未请求 summary 时出站无 `reasoning.summary`。
- 普通 message 的 content 允许保持 SDK 规范化形态，但必须恢复 `type: "message"`。

- [x] **Step 5: 清理与状态检查**

停止本次 proxy、关闭本次启用的 capture、删除临时 Codex profile，并运行：

Run: `git status --short --branch`

Expected: 仅显示本任务明确修改的源码、测试和文档；无 profile、日志、配置、密钥或实验依赖进入版本控制。

---

## Self-Review

- SDK 主导：所有请求先经 SDK；final-body merge 只恢复缺失的 message `type`，`additional_tools` shim 激活时再插入 additional item 并修正工具位置。
- 任意位置：leading、middle、trailing、multiple 均有测试。
- 变长映射：outgoing `agent_message` 被 SDK 展开为多个 items 时，anchor 仍保持正确边界。
- 升级兼容：SDK body 已含 additional item 时不重建该 item，只执行通用 message `type` 恢复并移除内部 anchor。
- 工具语义：SDK ToolSet 保留验证能力，wire 不重复或提前暴露 input tools。
- reasoning：使用 SDK public options，不在 fetch 层修补。
- 错误处理：对齐失败抛错，由现有完整错误日志链处理。
- 非目标 provider：无行为变化。
- 无占位符；函数名、签名和命令在各任务间一致。

# Codex tool_search 动态工具 + namespace 命名回路修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 codex 经 llm-proxy 转发到 openai-compatible 上游（GLM）时，tool_search 发现的 namespace 工具（如 spawn_agent）能被 GLM 调用，并修复现有 mcp__/codex_app namespace 命名回路。

**Architecture:** llm-proxy 承担 codex PR #26234 的 un-flatten 角色——请求侧把 `tool_search_output` 发现的 namespace 工具拍平成 `ns__subtool` 加入 GLM `tools[]`（幂等/追加末尾/固定字段顺序保缓存），历史 `function_call` 的 `namespace` 字段映射为拍平名；响应侧把 GLM 返回的拍平名拆回 `{name, namespace}` 分离字段给 codex（codex master 不支持扁平名）。namespace 映射通过 strategy 接口经 handle-protocol 从请求侧传递到响应侧（复用 `customToolNames` 模式）。

**Tech Stack:** TypeScript（ESM + NodeNext，所有本地导入用 `.js` 扩展名）、Vercel AI SDK、Vitest、Hono、Zod v3。`tsconfig.base.json` 启用 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`。

## Global Constraints

- 所有本地导入用 `.js` 扩展名（ESM + NodeNext）。
- `exactOptionalPropertyTypes`：optional 字段用 `...(cond && { field })` 展开或 `if (x) obj.field = x`，不可直接赋 `undefined`。
- `noUncheckedIndexedAccess`：数组/Map 索引访问返回 `T | undefined`，需窄化。
- 入参/返回值禁止 `unknown`（除验证点/错误处理/工具 args 等例外），用具名类型或 `Record<string, unknown>`。
- 测试无网络，用 Vitest。命令：`pnpm test test/providers/openai-responses/xxx.test.ts`、`pnpm typecheck`、`pnpm test`。
- 日志脱敏（apikey/authorization/x-api-key 等），错误分支带完整对象记日志（本计划不涉及新日志分支）。
- 禁止提交 `.env`/`settings.jsonc`/`auth.json`。

---

## File Structure

- **Modify** `src/providers/protocol-types.ts` — 新增 `NamespaceFlatEntry`/`NamespaceFlatMap` 类型；`RenderResultInput` 加 `namespaceFlatMap?` 字段。
- **Modify** `src/providers/openai-responses/protocol.ts` — 新增 `collectNamespaceFlatMap`/`getResponsesNamespaceFlatMap`；`mapResponsesRequestToAISDKInput` 扫 `tool_search_output` 拍平加入 `toolSet`；历史 `function_call` 的 `namespace` 字段映射为拍平名。
- **Modify** `src/providers/shared/strategy.ts` — `ProtocolStrategy` 加 `getNamespaceFlatMap?` 方法；`renderStreamSSE` input 加 `namespaceFlatMap?`。
- **Modify** `src/providers/openai-responses/strategy.ts` — 暴露 `getResponsesNamespaceFlatMap`。
- **Modify** `src/server/handle-protocol.ts` — 调用 `getNamespaceFlatMap` 并传给 render。
- **Modify** `src/providers/openai-responses/types.ts` — `ResponseFunctionToolCall`/`StreamFunctionCallItem` 加 `namespace?`。
- **Modify** `src/providers/openai-responses/renderer.ts` — 接收 `namespaceFlatMap`，`function_call` 渲染拆回 `{name, namespace}`。
- **Test** `test/providers/openai-responses/protocol.test.ts` — 请求侧测试。
- **Test** `test/providers/openai-responses/renderer.test.ts` — 响应侧测试。

---

### Task 1: 新增 NamespaceFlatMap 类型 + collectNamespaceFlatMap 函数

**Files:**
- Modify: `src/providers/protocol-types.ts:14-34`（加类型 + RenderResultInput 字段）
- Modify: `src/providers/openai-responses/protocol.ts`（新增函数，放 `hasClientToolSearch` 之后，约 L147）
- Test: `test/providers/openai-responses/protocol.test.ts`

**Interfaces:**
- Produces:
  - `NamespaceFlatEntry = { namespace: string | undefined; name: string }`（protocol-types.ts）
  - `NamespaceFlatMap = Map<string, NamespaceFlatEntry>`（protocol-types.ts）
  - `getResponsesNamespaceFlatMap(request: OpenAIResponsesRequest): NamespaceFlatMap | undefined`（protocol.ts，导出）
  - `collectNamespaceFlatMap(request: OpenAIResponsesRequest): NamespaceFlatMap`（protocol.ts，导出，供 Task 2/响应侧共用）

- [ ] **Step 1: 写失败测试**

在 `test/providers/openai-responses/protocol.test.ts` 末尾 `})` 之前加：

```typescript
  describe('getResponsesNamespaceFlatMap', () => {
    it('collects namespace tools from request.tools and tool_search_output', () => {
      const map = getResponsesNamespaceFlatMap({
        model: 'gpt-5',
        input: 'hi',
        tools: [
          { type: 'namespace', name: 'codex_app', tools: [{ type: 'function', name: 'load_ws' }] },
        ],
      })
      expect(map).toBeDefined()
      expect(map!.get('codex_app__load_ws')).toEqual({ namespace: 'codex_app', name: 'load_ws' })
    })

    it('collects namespace tools discovered via tool_search_output in input history', () => {
      const map = getResponsesNamespaceFlatMap({
        model: 'gpt-5',
        input: [
          { type: 'tool_search_call', call_id: 'ts_1', arguments: { query: 'agent' } },
          { type: 'tool_search_output', call_id: 'ts_1', tools: [
            { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn_agent' }] },
          ] },
        ],
      })
      expect(map).toBeDefined()
      expect(map!.get('multi_agent_v1__spawn_agent')).toEqual({ namespace: 'multi_agent_v1', name: 'spawn_agent' })
    })

    it('collects top-level function (no namespace) from tool_search_output', () => {
      const map = getResponsesNamespaceFlatMap({
        model: 'gpt-5',
        input: [
          { type: 'tool_search_output', call_id: 'ts_1', tools: [{ type: 'function', name: 'standalone_tool' }] },
        ],
      })
      expect(map).toBeDefined()
      expect(map!.get('standalone_tool')).toEqual({ namespace: undefined, name: 'standalone_tool' })
    })

    it('returns undefined when no namespace tools present', () => {
      const map = getResponsesNamespaceFlatMap({ model: 'gpt-5', input: 'hi' })
      expect(map).toBeUndefined()
    })

    it('skips non-function sub-tools in namespace', () => {
      const map = getResponsesNamespaceFlatMap({
        model: 'gpt-5',
        input: [{ type: 'tool_search_output', call_id: 'ts_1', tools: [
          { type: 'namespace', name: 'ns', tools: [
            { type: 'function', name: 'fn' },
            { type: 'custom', name: 'patch' },
          ] },
        ] }],
      })
      expect(map!.get('ns__fn')).toEqual({ namespace: 'ns', name: 'fn' })
      expect(map!.has('ns__patch')).toBe(false)
    })
  })
```

在 `protocol.test.ts` 顶部 import 行加 `getResponsesNamespaceFlatMap`（现有 import 含 `getResponsesCustomToolNames`/`mapResponsesRequestToAISDKInput`/`validateOpenAIResponsesRequest`，**不**新增 `hasClientToolSearch`——Task 1 测试未用到，避免 unused import）：

```typescript
import { getResponsesCustomToolNames, getResponsesNamespaceFlatMap, mapResponsesRequestToAISDKInput, validateOpenAIResponsesRequest } from '../../../src/providers/openai-responses/protocol.js'
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts`
Expected: FAIL — `getResponsesNamespaceFlatMap is not a function` / 类型未导出。

- [ ] **Step 3: 加类型到 protocol-types.ts**

在 `src/providers/protocol-types.ts` 的 `RenderResultInput` interface 之前加：

```typescript
/** namespace 工具拍平名 → 原始 {namespace, name} 映射条目。
 *  namespace 为 undefined 表示顶层 function（无 namespace 包裹）。 */
export interface NamespaceFlatEntry {
  namespace: string | undefined
  name: string
}

/** namespace 拍平映射：flatName(`${namespace}__${name}` 或 name) → {namespace, name}。
 *  请求侧构建（request.tools namespace + input tool_search_output），响应侧用于把
 *  GLM 返回的拍平 toolName 拆回 codex 期望的 {name, namespace} 分离字段。 */
export type NamespaceFlatMap = Map<string, NamespaceFlatEntry>
```

在 `RenderResultInput` 的 `toolSearchShimmed?: boolean` 之后加：

```typescript
  /** namespace 拍平映射：把 GLM 返回的拍平 toolName 拆回 {name, namespace}。
   *  仅 openai-responses renderer 使用；其他 renderer 忽略。 */
  namespaceFlatMap?: NamespaceFlatMap
```

- [ ] **Step 4: 加函数到 protocol.ts**

在 `src/providers/openai-responses/protocol.ts` 顶部 import 加 `NamespaceFlatMap`（定义在 `protocol-types.ts`，`aisdk-types.ts` **不** re-export，直接从 `../protocol-types.js` 导入；现有 `import { isRecord } from '../protocol-types.js'` 合并）：

```typescript
import { isRecord, type NamespaceFlatMap } from '../protocol-types.js'
```

在 `hasClientToolSearch` 函数之后（约 L147）加 `flattenToolName` helper（Task 1/2/3 共用，避免拼接逻辑漂移）+ `collectNamespaceFlatMap`/`getResponsesNamespaceFlatMap`：

```typescript
/** 把 codex 的 {name, namespace} 还原成 GLM 期望的拍平 toolName。
 *  namespace 存在时 `${namespace}__${name}`，否则原 name。请求侧历史 function_call 映射、
 *  collectNamespaceFlatMap 拍平、Task 2 toolSet 加入均复用此函数，保证拼接规则一致。 */
function flattenToolName(name: string, namespace: string | undefined): string {
  return namespace ? `${namespace}__${name}` : name
}

/** 收集 namespace 拍平映射：flatName → {namespace, name}。
 *  来源：(1) request.tools 的 namespace 工具；(2) input 历史的 tool_search_output 里的 namespace/顶层 function。
 *  用于响应侧把 GLM 返回的拍平 toolName 拆回 codex 期望的 {name, namespace} 分离字段。 */
export function collectNamespaceFlatMap(request: OpenAIResponsesRequest): NamespaceFlatMap {
  const map: NamespaceFlatMap = new Map()
  const add = (namespace: string | undefined, name: string) => {
    const flatName = flattenToolName(name, namespace)
    if (!map.has(flatName)) map.set(flatName, { namespace, name })
  }

  // (1) request.tools 的 namespace
  if (request.tools) {
    for (const tool of request.tools) {
      if (tool.type !== 'namespace') continue
      const nsTool = tool as { name?: string; tools?: Array<{ type?: string; name?: string }> }
      if (!nsTool.name || !Array.isArray(nsTool.tools)) continue
      for (const sub of nsTool.tools) {
        if (!sub.name || sub.type !== 'function') continue
        add(nsTool.name, sub.name)
      }
    }
  }

  // (2) input 历史的 tool_search_output
  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (!('type' in item) || item.type !== 'tool_search_output') continue
      const tsOut = item as { tools?: Array<{ type?: string; name?: string; tools?: Array<{ type?: string; name?: string }> }> }
      if (!Array.isArray(tsOut.tools)) continue
      for (const t of tsOut.tools) {
        if (t.type === 'namespace') {
          if (!t.name || !Array.isArray(t.tools)) continue
          for (const sub of t.tools) {
            if (!sub.name || sub.type !== 'function') continue
            add(t.name, sub.name)
          }
        } else if (t.type === 'function') {
          if (t.name) add(undefined, t.name)
        }
      }
    }
  }

  return map
}

/** collectNamespaceFlatMap 的可选包装：无 namespace 工具时返回 undefined（复用 getCustomToolNames 模式）。 */
export function getResponsesNamespaceFlatMap(request: OpenAIResponsesRequest): NamespaceFlatMap | undefined {
  const map = collectNamespaceFlatMap(request)
  return map.size > 0 ? map : undefined
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts`
Expected: PASS — 全部 `getResponsesNamespaceFlatMap` 用例通过，原有用例不回归。

- [ ] **Step 6: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add src/providers/protocol-types.ts src/providers/openai-responses/protocol.ts test/providers/openai-responses/protocol.test.ts
git commit -m "feat(codex): add namespace flat map collection for tool_search discovery"
```

---

### Task 2: 请求侧扫 tool_search_output 拍平加入 tools[]

**Files:**
- Modify: `src/providers/openai-responses/protocol.ts:482`（tools 处理之后、tool_choice 之前插入）
- Test: `test/providers/openai-responses/protocol.test.ts`

**Interfaces:**
- Consumes: `mapResponsesFunctionTool`（protocol.ts:546）、`flattenToolName`（Task 1）。
- Produces: `mapResponsesRequestToAISDKInput` 输出的 `tools` 含 tool_search_output 发现的拍平工具。

- [ ] **Step 1: 写失败测试**

在 `protocol.test.ts` 的 `describe('getResponsesNamespaceFlatMap', ...)` 之后加新 describe：

```typescript
  describe('tool_search_output discovered tools → tools[]', () => {
    it('flattens namespace tools from tool_search_output into toolSet (openai-compatible)', () => {
      const result = mapResponsesRequestToAISDKInput({
        model: 'gpt-5',
        input: [
          { type: 'tool_search_call', call_id: 'ts_1', arguments: { query: 'agent' } },
          { type: 'tool_search_output', call_id: 'ts_1', tools: [
            { type: 'namespace', name: 'multi_agent_v1', description: 'sub-agents',
              tools: [{ type: 'function', name: 'spawn_agent', description: 'spawn', parameters: { type: 'object', properties: { message: { type: 'string' } } } }] },
          ] },
        ],
      }, { providerType: 'openai-compatible' })
      expect(result.tools).toBeDefined()
      expect(Object.keys(result.tools!)).toContain('multi_agent_v1__spawn_agent')
      expect(result.tools!['multi_agent_v1__spawn_agent']!.description).toBe('spawn')
    })

    it('is idempotent: duplicate tool_search_output does not duplicate toolSet entries', () => {
      const result = mapResponsesRequestToAISDKInput({
        model: 'gpt-5',
        input: [
          { type: 'tool_search_output', call_id: 'ts_1', tools: [
            { type: 'namespace', name: 'ns', tools: [{ type: 'function', name: 'fn', parameters: { type: 'object' } }] }] },
          { type: 'tool_search_output', call_id: 'ts_2', tools: [
            { type: 'namespace', name: 'ns', tools: [{ type: 'function', name: 'fn', parameters: { type: 'object' } }] }] },
        ],
      }, { providerType: 'openai-compatible' })
      expect(Object.keys(result.tools!).filter((k) => k === 'ns__fn').length).toBe(1)
    })

    it('appends discovered tools after initial request.tools (stable order)', () => {
      const result = mapResponsesRequestToAISDKInput({
        model: 'gpt-5',
        input: [{ type: 'tool_search_output', call_id: 'ts_1', tools: [
          { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }] }] }],
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
      }, { providerType: 'openai-compatible' })
      // 初始 request.tools 在前，发现的 namespace 工具追加末尾（保缓存前缀稳定）
      expect(Object.keys(result.tools!)).toEqual(['shell', 'multi_agent_v1__spawn_agent'])
    })

    it('scans tool_search_output even when request.tools is undefined', () => {
      // 关键：request.tools 为 undefined 时仍扫描 tool_search_output（代码在 if(request.tools) 块外）
      const result = mapResponsesRequestToAISDKInput({
        model: 'gpt-5',
        input: [{ type: 'tool_search_output', call_id: 'ts_1', tools: [
          { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }] }] }],
      }, { providerType: 'openai-compatible' })
      expect(Object.keys(result.tools!)).toEqual(['multi_agent_v1__spawn_agent'])
    })

    it('does not add tools when tool_search_output empty', () => {
      const result = mapResponsesRequestToAISDKInput({
        model: 'gpt-5',
        input: [{ type: 'tool_search_output', call_id: 'ts_1', tools: [] }],
      }, { providerType: 'openai-compatible' })
      expect(result.tools).toBeUndefined()
    })

    it('skips top-level tool without type field (only type:function added)', () => {
      // 钉住现有 protocol.test.ts:449 行为：tool_search_output 顶层元素不带 type（如 open_page）
      // 时，Task 2 用 t.type === 'function' 判断会跳过，不误加入 toolSet
      const result = mapResponsesRequestToAISDKInput({
        model: 'gpt-5',
        input: [{ type: 'tool_search_output', call_id: 'ts_1', tools: [{ name: 'open_page' }] }],
      }, { providerType: 'openai-compatible' })
      expect(result.tools).toBeUndefined()
    })
  })
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts`
Expected: FAIL — `result.tools` 不含 `multi_agent_v1__spawn_agent`。

- [ ] **Step 3: 实现 — 扫 tool_search_output 拍平加入 toolSet**

改动 `src/providers/openai-responses/protocol.ts` 的 tools 赋值结构（**关键**：扫 tool_search_output 的代码必须在 `if (request.tools) {...}` 块**外**，否则 `request.tools` 为 undefined 时——仅有 tool_search_output 历史的请求——整个块不执行，发现工具丢失，核心 bug 未修）：

1. 把 `if (Object.keys(toolSet).length > 0) input.tools = toolSet`（当前 L482，在 `if (request.tools) {...}` 块**内**）**移到块外**（L483 `}` 之后）——**删除原 L482 行**，仅在块外保留一处赋值，使 tool_search_output 发现的工具（无 request.tools 时）也能赋给 `input.tools`，避免重复赋值。
2. 在该赋值**之前**（块外）插入扫 tool_search_output 逻辑。完整片段（插入位置：`if (request.tools) {...}` 闭合之后、tool_choice 校验 L489 之前）：

```typescript
  // tool_search_output 历史发现的 namespace/顶层 function 工具，拍平加入 toolSet（幂等、追加末尾）。
  // codex 不把 tool_search 动态发现的工具放进顶层 tools[]（依赖 OpenAI 服务端从历史注册），
  // GLM 无此 hosted 机制 → 必须由代理把发现的工具加入 tools[] 才能被调用。幂等保缓存前缀稳定。
  // 注意：此段在 if (request.tools) 块外，确保 request.tools 为 undefined 时仍扫描。
  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (!('type' in item) || item.type !== 'tool_search_output') continue
      const tsOut = item as {
        tools?: Array<{
          type?: string
          name?: string
          description?: string
          parameters?: Record<string, unknown>
          tools?: Array<{ type?: string; name?: string; description?: string; parameters?: Record<string, unknown> }>
        }>
      }
      if (!Array.isArray(tsOut.tools)) continue
      for (const t of tsOut.tools) {
        if (t.type === 'namespace') {
          if (!t.name || !Array.isArray(t.tools)) continue
          for (const sub of t.tools) {
            if (!sub.name || sub.type !== 'function') continue
            const flatName = flattenToolName(sub.name, t.name)
            if (flatName in toolSet) continue  // 幂等
            // 显式构型 type:'function'（sub 来自 passthrough record，type 非 'function' 字面量，
            // spread 不保留字面量 → 需显式声明以满足 mapResponsesFunctionTool 的 ResponsesFunctionTool 类型）
            toolSet[flatName] = mapResponsesFunctionTool({
              type: 'function', name: flatName,
              ...(sub.description !== undefined && { description: sub.description }),
              ...(sub.parameters !== undefined && { parameters: sub.parameters }),
            })
            selectableToolNames.add(flatName)
          }
        } else if (t.type === 'function') {
          if (!t.name) continue
          if (t.name in toolSet) continue  // 幂等
          toolSet[t.name] = mapResponsesFunctionTool({
            type: 'function', name: t.name,
            ...(t.description !== undefined && { description: t.description }),
            ...(t.parameters !== undefined && { parameters: t.parameters }),
          })
          selectableToolNames.add(t.name)
        }
      }
    }
  }

  // toolSet 赋值（从 if(request.tools) 块内移出，使 tool_search_output 发现的工具能赋给 input.tools）
  if (Object.keys(toolSet).length > 0) input.tools = toolSet
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/providers/openai-responses/protocol.ts test/providers/openai-responses/protocol.test.ts
git commit -m "feat(codex): flatten tool_search_output tools into GLM tools[]"
```

---

### Task 3: 请求侧历史 function_call namespace 字段 → 拍平名

**Files:**
- Modify: `src/providers/openai-responses/protocol.ts:247-271`（callIdToName 构建 + function_call 映射）
- Modify: `src/providers/openai-responses/protocol.ts:285-301`（custom_tool_call 同理，保持一致）
- Test: `test/providers/openai-responses/protocol.test.ts`

**Interfaces:**
- Produces: 历史 `function_call{name, namespace}` 映射为 `toolName = '${namespace}__${name}'`，`function_call_output` 的 toolName 经 callIdToName 匹配拍平名。

- [ ] **Step 1: 写失败测试**

在 `protocol.test.ts` 加新 describe：

```typescript
  describe('historical function_call namespace → flattened toolName', () => {
    it('maps function_call with namespace to flattened toolName', () => {
      const result = mapResponsesRequestToAISDKInput({
        model: 'gpt-5',
        input: [
          { type: 'function_call', call_id: 'call_1', name: 'spawn_agent', namespace: 'multi_agent_v1', arguments: '{"message":"hi"}' },
          { type: 'function_call_output', call_id: 'call_1', output: '{"agent_id":"a1"}' },
        ],
      }, { providerType: 'openai-compatible' })
      expect(result.messages[0]).toEqual({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'multi_agent_v1__spawn_agent', input: { message: 'hi' } }],
      })
      expect(result.messages[1]).toEqual({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'multi_agent_v1__spawn_agent', output: { type: 'text', value: '{"agent_id":"a1"}' } }],
      })
    })

    it('maps function_call without namespace as plain toolName', () => {
      const result = mapResponsesRequestToAISDKInput({
        model: 'gpt-5',
        input: [
          { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
        ],
      }, { providerType: 'openai-compatible' })
      expect((result.messages[0].content as Array<{ toolName: string }>)[0]!.toolName).toBe('exec_command')
    })

    it('maps custom_tool_call with namespace to flattened toolName', () => {
      // custom_tool_call 也读 namespace（customToolCallSchema 是 passthrough，namespace 已保留）
      const result = mapResponsesRequestToAISDKInput({
        model: 'gpt-5',
        input: [
          { type: 'custom_tool_call', call_id: 'call_1', name: 'my_patch', namespace: 'custom_ns', input: '*** Begin Patch\n*** End Patch' },
          { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok' },
        ],
      }, { providerType: 'openai-compatible' })
      expect((result.messages[0].content as Array<{ toolName: string }>)[0]!.toolName).toBe('custom_ns__my_patch')
    })
  })
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts`
Expected: FAIL — `toolName` 是 `'spawn_agent'`（非拍平名）。

- [ ] **Step 3: 实现 — callIdToName 与 function_call 映射读取 namespace**

在 `src/providers/openai-responses/protocol.ts`，**先改 `functionCallSchema`（L30-36）加 `namespace` 字段**——`functionCallSchema` 是普通 `z.object`（非 `.passthrough()`），zod 默认 strip 未声明字段，`namespace` 会被丢弃 → `fc.namespace` 永远 undefined，`flattenToolName` 拍平失效。这是本 Task 的前提：

```typescript
const functionCallSchema = z.object({
  type: z.literal('function_call'),
  id: z.string().optional(),
  call_id: z.string().min(1),
  name: z.string().min(1),
  namespace: z.string().optional(),
  arguments: z.string(),
})
```

复用 Task 1 Step 4 已定义的 `flattenToolName`（无需重复定义）。改 `callIdToName` 构建（L247-252）——读 namespace 字段：

```typescript
    // Build call_id → tool name lookup (function_call_output lacks tool name)
    const callIdToName = new Map<string, string>()
    for (const item of request.input) {
      if ('type' in item && item.type === 'function_call') {
        const fc = item as { call_id: string; name: string; namespace?: string }
        callIdToName.set(fc.call_id, flattenToolName(fc.name, fc.namespace))
      }
    }
```

改 `function_call` 映射（L254-271）——toolName 用拍平名：

```typescript
      if ('type' in item && item.type === 'function_call') {
        // function_call → assistant message with tool-call content part
        const fc = item as { call_id: string; name: string; namespace?: string; arguments: string }
        let args: Record<string, unknown> | string = {}
        try {
          args = JSON.parse(fc.arguments)
        } catch {
          args = fc.arguments
        }
        messages.push({
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: fc.call_id,
            toolName: flattenToolName(fc.name, fc.namespace),
            input: args,
          }],
        })
      } else if ('type' in item && item.type === 'function_call_output') {
```

改 `custom_tool_call` 映射（L285-301）——同理读 namespace（apply_patch 一般 namespace 为空，但保持一致）：

```typescript
      } else if ('type' in item && item.type === 'custom_tool_call') {
        // custom_tool_call（apply_patch 等 freeform tool 的上轮调用）→ assistant tool-call
        const ctc = item as { call_id: string; name: string; namespace?: string; input: unknown }
        callIdToName.set(ctc.call_id, flattenToolName(ctc.name, ctc.namespace))
        const isShimmed = ctx?.providerType !== 'openai'
        const rawInput = ctc.input
        const mappedInput = isShimmed && typeof rawInput === 'string'
          ? { input: rawInput }
          : rawInput
        messages.push({
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: ctc.call_id,
            toolName: flattenToolName(ctc.name, ctc.namespace),
            input: mappedInput,
          }],
        })
      } else if ('type' in item && item.type === 'custom_tool_call_output') {
```

注意：`customToolCallSchema`（L51-56）是 `.passthrough()`，namespace 字段已保留，无需改。`functionCallSchema` 已在 Step 3 开头加 `namespace` 字段。改 schema 后 `fc.namespace`/`ctc.namespace` 才能读到值。

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts`
Expected: PASS。注意检查原有 `maps tool_search_call input item for shimmed provider`（L444）等用例不回归——tool_search_call 不受影响（无 namespace 字段）。

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/providers/openai-responses/protocol.ts test/providers/openai-responses/protocol.test.ts
git commit -m "fix(codex): map historical function_call namespace to flattened toolName"
```

---

### Task 4: strategy 接口 + handle-protocol 传递 namespaceFlatMap

**Files:**
- Modify: `src/providers/shared/strategy.ts:26,32`（renderStreamSSE input + 加 getNamespaceFlatMap）
- Modify: `src/providers/openai-responses/strategy.ts:3,15`（import + 暴露）
- Modify: `src/server/handle-protocol.ts:106-108,144-150,181-191,210-220`（调用 + 传递）
- Test: `test/server/handle-protocol.test.ts`（若存在；否则在 strategy.ts 单测）

**Interfaces:**
- Consumes: `getResponsesNamespaceFlatMap`（Task 1）、`NamespaceFlatMap`（protocol-types.ts）。
- Produces: `strategy.getNamespaceFlatMap?(request)` 方法；`renderStreamSSE`/`renderResult` 接收 `namespaceFlatMap?`。

- [ ] **Step 1: 写失败测试**

先确认 `test/server/handle-protocol.test.ts` 是否存在：

Run: `ls test/server/`

若有 handle-protocol 测试，加一个用例验证 namespaceFlatMap 传递。若不确定，改用 strategy 层断言。最简：在 `test/providers/openai-responses/strategy.test.ts`（若存在）或新建轻量断言。先检查：

Run: `ls test/providers/openai-responses/`

若有 `strategy.test.ts`，加：

```typescript
  it('exposes getNamespaceFlatMap from protocol', () => {
    const req = validateOpenAIResponsesRequest({
      model: 'gpt-5',
      input: [{ type: 'tool_search_output', call_id: 'ts_1', tools: [
        { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn_agent' }] }] }],
    })
    expect(openaiResponsesStrategy.getNamespaceFlatMap?.(req)).toBeDefined()
  })
```

若无 strategy.test.ts，在 `protocol.test.ts` 已覆盖函数本身，此 Task 的接口接线通过 Task 5 的端到端渲染测试间接验证。跳过 Step 1 失败测试，直接实现接口（本 Task 是机械接线）。

- [ ] **Step 2: 改 strategy.ts 接口**

在 `src/providers/shared/strategy.ts` 顶部加 `NamespaceFlatMap` import（`aisdk-types.ts` **不** re-export，直接从 `../protocol-types.js` 导入）：

```typescript
import type { NamespaceFlatMap } from '../protocol-types.js'
```

改 `renderStreamSSE` 签名（L26）加 `namespaceFlatMap?`：

```typescript
  renderStreamSSE(input: { model: string; stream: AsyncIterable<ProxyStreamPart>; customToolNames?: Set<string>; customToolShimmed?: boolean; toolSearchShimmed?: boolean; namespaceFlatMap?: NamespaceFlatMap }): AsyncIterable<SSEOutput<TSSEData>>
```

在 `getHasClientToolSearch?` 之后（L32）加：

```typescript
  /** 收集 namespace 拍平映射（flatName → {namespace, name}），供 renderer 把 GLM 返回的拍平
   *  toolName 拆回 codex 期望的 {name, namespace} 分离字段。仅 openai-responses 实现。 */
  getNamespaceFlatMap?(request: TRequest): NamespaceFlatMap | undefined
```

- [ ] **Step 3: 改 openai-responses strategy.ts 暴露**

在 `src/providers/openai-responses/strategy.ts` import 加 `getResponsesNamespaceFlatMap`：

```typescript
import { validateOpenAIResponsesRequest, mapResponsesRequestToAISDKInput, getResponsesCustomToolNames, hasClientToolSearch, getResponsesNamespaceFlatMap } from './protocol.js'
```

在 strategy 对象（L13-16 附近）加：

```typescript
  getCustomToolNames: getResponsesCustomToolNames,
  getHasClientToolSearch: hasClientToolSearch,
  getNamespaceFlatMap: getResponsesNamespaceFlatMap,
```

- [ ] **Step 4: 改 handle-protocol.ts 调用 + 传递**

在 `src/server/handle-protocol.ts` L108 之后加：

```typescript
  const namespaceFlatMap = strategy.getNamespaceFlatMap?.(request)
```

streaming 分支（L144-150）加 `namespaceFlatMap`：

```typescript
          strategy.renderStreamSSE({
            model: requestModel,
            stream: acquired.stream,
            ...(customToolNames && { customToolNames }),
            ...(customToolShimmed && { customToolShimmed }),
            ...(toolSearchShimmed && { toolSearchShimmed }),
            ...(namespaceFlatMap && { namespaceFlatMap }),
          }),
```

stream-only 分支（L189-191，`if (customToolNames)...` 系列之后）加：

```typescript
      if (namespaceFlatMap) renderInput.namespaceFlatMap = namespaceFlatMap
```

generate 分支（L218-220 系列之后）同样加：

```typescript
      if (namespaceFlatMap) renderInput.namespaceFlatMap = namespaceFlatMap
```

- [ ] **Step 5: typecheck + 全量 protocol 测试**

Run: `pnpm typecheck && pnpm test test/providers/openai-responses/protocol.test.ts`
Expected: typecheck 无错误（renderer 还未用 namespaceFlatMap，optional 字段不报错）；protocol 测试不回归。

- [ ] **Step 6: Commit**

```bash
git add src/providers/shared/strategy.ts src/providers/openai-responses/strategy.ts src/server/handle-protocol.ts
git commit -m "feat(codex): wire namespaceFlatMap from request to renderer via strategy"
```

---

### Task 5: 响应侧 renderer 拆回 {name, namespace}

**Files:**
- Modify: `src/providers/openai-responses/types.ts:15-22,102-110`（ResponseFunctionToolCall + StreamFunctionCallItem 加 namespace?）
- Modify: `src/providers/openai-responses/renderer.ts`（L123-129 renderOpenAIResponseSSE input；L314-339/L393-403 added；L438-451 done+push；L611-615 renderOpenAIResponse input；L654-663 non-streaming function_call）
- Test: `test/providers/openai-responses/renderer.test.ts`

**Interfaces:**
- Consumes: `NamespaceFlatMap`（protocol-types.ts）、`namespaceFlatMap` 参数（Task 4 传入）。
- Produces: `function_call` 渲染输出 `{name, namespace?, arguments, call_id}`（namespace 命中映射时带字段）。

- [ ] **Step 1: 写失败测试**

在 `test/providers/openai-responses/renderer.test.ts` 末尾 `})` 之前加：

```typescript
  it('renders flattened toolName back to {name, namespace} in non-streaming', () => {
    const namespaceFlatMap = new Map([
      ['multi_agent_v1__spawn_agent', { namespace: 'multi_agent_v1', name: 'spawn_agent' }],
      ['mcp__codegraph__codegraph_search', { namespace: 'mcp__codegraph', name: 'codegraph_search' }],
    ])
    const result = renderOpenAIResponse({
      model: 'gpt-5',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        { toolCallId: 'call_1', toolName: 'multi_agent_v1__spawn_agent', input: { message: 'hi' } },
        { toolCallId: 'call_2', toolName: 'mcp__codegraph__codegraph_search', input: { query: 'x' } },
        { toolCallId: 'call_3', toolName: 'exec_command', input: { cmd: 'ls' } },
      ],
      namespaceFlatMap,
    })
    const fc1 = result.output.find((o) => o.type === 'function_call' && (o as { call_id?: string }).call_id === 'call_1')
    const fc2 = result.output.find((o) => o.type === 'function_call' && (o as { call_id?: string }).call_id === 'call_2')
    const fc3 = result.output.find((o) => o.type === 'function_call' && (o as { call_id?: string }).call_id === 'call_3')
    expect(fc1).toMatchObject({ type: 'function_call', name: 'spawn_agent', namespace: 'multi_agent_v1' })
    expect(fc2).toMatchObject({ type: 'function_call', name: 'codegraph_search', namespace: 'mcp__codegraph' })
    // 普通工具不带 namespace 字段（codex master 不支持扁平名，namespace 字段必须省略，而非 undefined）
    expect(fc3).toMatchObject({ type: 'function_call', name: 'exec_command' })
    expect('namespace' in (fc3 as object)).toBe(false)
  })

  it('renders flattened toolName back to {name, namespace} in streaming', async () => {
    const namespaceFlatMap = new Map([
      ['multi_agent_v1__spawn_agent', { namespace: 'multi_agent_v1', name: 'spawn_agent' }],
    ])
    async function* gen() {
      yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'multi_agent_v1__spawn_agent', input: { message: 'hi' } }
      yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 5, outputTokens: 5 }, response: { id: 'resp_x' } }
    }
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-5',
      stream: gen() as AsyncIterable<ProxyStreamPart>,
      namespaceFlatMap,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    // added item 也带拆回的 name/namespace
    const added = events.find((e) => e.event === 'response.output_item.added')
    const addedItem = (added!.data as ResponseOutputItemAddedEvent).item
    expect(addedItem.type).toBe('function_call')
    if (addedItem.type === 'function_call') {
      expect(addedItem.name).toBe('spawn_agent')
      expect((addedItem as { namespace?: string }).namespace).toBe('multi_agent_v1')
    }
    // done item
    const done = events.find((e) => e.event === 'response.output_item.done')
    const doneItem = (done!.data as ResponseOutputItemDoneEvent).item
    expect(doneItem.type).toBe('function_call')
    if (doneItem.type === 'function_call') {
      expect(doneItem.name).toBe('spawn_agent')
      expect((doneItem as { namespace?: string }).namespace).toBe('multi_agent_v1')
    }
    // response.completed 的 output 也含拆回字段（codex 实际消费）
    const completed = events.find((e) => e.event === 'response.completed')
    const completedOutput = (completed!.data as { response: { output: Array<{ type: string; name?: string; namespace?: string }> } }).response.output
    const fc = completedOutput.find((o) => o.type === 'function_call')
    expect(fc?.name).toBe('spawn_agent')
    expect(fc?.namespace).toBe('multi_agent_v1')
  })

  it('does not resolve namespace for tool_search shimmed call (isTsShimmed takes priority)', () => {
    // namespaceFlatMap 误含 'tool_search' 时，tool_search 仍渲染为 tool_search_call（不被拆回为 function_call）
    const namespaceFlatMap = new Map([
      ['tool_search', { namespace: 'wrong', name: 'tool_search' }],
    ])
    const result = renderOpenAIResponse({
      model: 'gpt-5',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'ts_1', toolName: 'tool_search', input: { query: 'x' } }],
      toolSearchShimmed: true,
      namespaceFlatMap,
    })
    expect(result.output.find((o) => o.type === 'tool_search_call')).toBeDefined()
    // 不应出现 function_call（被误拆回）
    expect(result.output.find((o) => o.type === 'function_call')).toBeUndefined()
  })
```

确认 `renderer.test.ts` 顶部 import 含 `renderOpenAIResponse`、`renderOpenAIResponseSSE`、`collectSSEFrames`、`OpenAIResponseStreamEvent`、`ResponseOutputItemAddedEvent`、`ResponseOutputItemDoneEvent`、`ProxyStreamPart`。若缺则补（现有 import 已含多数）。

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test test/providers/openai-responses/renderer.test.ts`
Expected: FAIL — `name` 是 `'multi_agent_v1__spawn_agent'`（未拆回），无 `namespace` 字段。

- [ ] **Step 3: 加 namespace? 到类型**

在 `src/providers/openai-responses/types.ts` 的 `ResponseFunctionToolCall`（L15-22）`name` 之后加：

```typescript
export interface ResponseFunctionToolCall {
  id: string
  type: 'function_call'
  status: 'completed' | 'incomplete'
  call_id: string
  name: string
  namespace?: string
  arguments: string
}
```

`StreamFunctionCallItem`（L102-110）同理加 `namespace?: string`：

```typescript
interface StreamFunctionCallItem {
  id: string
  type: 'function_call'
  status: string
  call_id: string
  name: string
  namespace?: string
  arguments: string
}
```

- [ ] **Step 4: 加 resolveNamespacedToolName helper + 接收 namespaceFlatMap**

在 `src/providers/openai-responses/renderer.ts` 顶部 import 加 `NamespaceFlatMap`（renderer.ts L5 已从 `'../protocol-types.js'` 导入 `FinishReason`/`RenderResultInput`，合并）：

```typescript
import type { FinishReason, RenderResultInput, NamespaceFlatMap } from '../protocol-types.js'
```

在 `isToolSearchShimmed`（L65-67）之后加（参数类型复用 `NamespaceFlatMap`，不内联）：

```typescript
/** 把 GLM 返回的拍平 toolName 拆回 codex 期望的 {name, namespace}。
 *  命中 namespaceFlatMap 且 entry.namespace 非 undefined → 拆回；否则原样（普通工具）。
 *  注意：custom_tool_call（apply_patch）与 tool_search_call 走各自的 isCustom/isTsShimmed 分支，
 *  不进此函数——apply_patch namespace=None 无需拆回，tool_search 是 hosted 不在 flatMap。 */
function resolveNamespacedToolName(
  toolName: string,
  namespaceFlatMap?: NamespaceFlatMap,
): { name: string; namespace?: string } {
  const entry = namespaceFlatMap?.get(toolName)
  if (entry && entry.namespace !== undefined) {
    return { name: entry.name, namespace: entry.namespace }
  }
  return { name: toolName }
}
```

改 `renderOpenAIResponseSSE` input（L123-129）加 `namespaceFlatMap?`，并在函数体（L159-161 附近）解构：

```typescript
export async function* renderOpenAIResponseSSE(input: {
  model: string
  stream: AsyncIterable<ProxyStreamPart>
  customToolNames?: Set<string>
  customToolShimmed?: boolean
  toolSearchShimmed?: boolean
  namespaceFlatMap?: NamespaceFlatMap
}): AsyncIterable<SSEOutput<OpenAIResponseStreamEvent>> {
```

L159-161 加：

```typescript
  const customToolNames = input.customToolNames
  const customToolShimmed = input.customToolShimmed
  const toolSearchShimmed = input.toolSearchShimmed
  const namespaceFlatMap = input.namespaceFlatMap
```

改 `renderOpenAIResponse`（L611）input 接收 + 解构（L613-615）：

```typescript
export function renderOpenAIResponse(input: RenderResultInput): OpenAIResponse {
  const output: ResponseOutputItem[] = []
  const customToolNames = input.customToolNames
  const customToolShimmed = input.customToolShimmed
  const toolSearchShimmed = input.toolSearchShimmed
  const namespaceFlatMap = input.namespaceFlatMap
```

- [ ] **Step 5: 改 streaming function_call 渲染拆回 namespace**

**关键决策**：只对 `function_call` 的 `else` 分支拆回 namespace。`isCustom`（custom_tool_call，apply_patch）和 `isTsShimmed`（tool_search_call）分支**不拆回**——apply_patch 的 namespace=None（codex custom_tool_call 虽带 namespace 字段，但 apply_patch 实际无 namespace），tool_search 是 hosted 工具不在 namespaceFlatMap。这两个分支保持 `name: toolName` 原样。

`tool-input-start` 分支（L333）的 `function_call` added item——把 `name: toolName` 改为拆回。改 L329-333：

```typescript
        const isCustom = isCustomToolName(toolName, customToolNames)
        const isTsShimmed = isToolSearchShimmed(toolName, toolSearchShimmed)
        const nsResolved = resolveNamespacedToolName(toolName, namespaceFlatMap)
        const addedItem = isCustom
          ? { id: fcId, type: 'custom_tool_call' as const, status: 'in_progress' as const, call_id: toolCallId, name: toolName, input: '' }
          : isTsShimmed
            ? { id: fcId, type: 'tool_search_call' as const, status: 'in_progress' as const, call_id: toolCallId, execution: 'client' as const, arguments: {} }
            : { id: fcId, type: 'function_call' as const, status: 'in_progress' as const, call_id: toolCallId, name: nsResolved.name, ...(nsResolved.namespace !== undefined && { namespace: nsResolved.namespace }), arguments: '' }
```

`tool-call` 分支的 added（L393-403）同样改——L394-398 的 `addedItem`：

```typescript
          const addedItem = isCustom
            ? { id: fcId, type: 'custom_tool_call' as const, status: 'in_progress' as const, call_id: toolCallId, name: toolName, input: '' }
            : isTsShimmed
              ? { id: fcId, type: 'tool_search_call' as const, status: 'in_progress' as const, call_id: toolCallId, execution: 'client' as const, arguments: {} }
              : { id: fcId, type: 'function_call' as const, status: 'in_progress' as const, call_id: toolCallId, name: nsResolved.name, ...(nsResolved.namespace !== undefined && { namespace: nsResolved.namespace }), arguments: '' }
```

注意：`tool-call` 分支需在 addedItem 之前计算 `nsResolved`。在 L381-382（`isCustom`/`isTsShimmed` 之后）加：

```typescript
        const isCustom = isCustomToolName(toolName, customToolNames)
        const isTsShimmed = isToolSearchShimmed(toolName, toolSearchShimmed)
        const nsResolved = resolveNamespacedToolName(toolName, namespaceFlatMap)
```

`tool-call` 分支的 done（L443-451）——改 `name: toolName` 为 `name: nsResolved.name` 并加 namespace：

```typescript
          yield { event: 'response.function_call_arguments.done', data: {
            type: 'response.function_call_arguments.done', sequence_number: nextSeq(),
            item_id: fcId, output_index: outputIndex, arguments: args,
          } }
          yield { event: 'response.output_item.done', data: {
            type: 'response.output_item.done', sequence_number: nextSeq(), output_index: outputIndex,
            item: { id: fcId, type: 'function_call', status: 'completed', call_id: toolCallId, name: nsResolved.name, ...(nsResolved.namespace !== undefined && { namespace: nsResolved.namespace }), arguments: args },
          } }
          streamedToolCalls.push({
            id: fcId, type: 'function_call', status: 'completed',
            call_id: toolCallId, name: nsResolved.name, ...(nsResolved.namespace !== undefined && { namespace: nsResolved.namespace }), arguments: args,
          })
```

- [ ] **Step 6: 改 non-streaming function_call 渲染拆回 namespace**

`renderOpenAIResponse` 的 function_call 分支（L654-663）——加 `nsResolved` 并拆回：

```typescript
      } else {
        const args = typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? {})
        const nsResolved = resolveNamespacedToolName(call.toolName, namespaceFlatMap)
        output.push({
          id: `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function_call',
          status: 'completed',
          call_id: call.toolCallId,
          name: nsResolved.name,
          ...(nsResolved.namespace !== undefined && { namespace: nsResolved.namespace }),
          arguments: args,
        })
      }
```

- [ ] **Step 7: 运行测试验证通过**

Run: `pnpm test test/providers/openai-responses/renderer.test.ts`
Expected: PASS — 新增 2 个用例通过，原有 tool_search/custom tool 用例不回归。

- [ ] **Step 8: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 9: Commit**

```bash
git add src/providers/openai-responses/types.ts src/providers/openai-responses/renderer.ts test/providers/openai-responses/renderer.test.ts
git commit -m "feat(codex): render flattened toolName back to {name, namespace} for codex"
```

---

### Task 6: mcp__/codex_app 回归 + 端到端 + 全量验证

**Files:**
- Test: `test/providers/openai-responses/renderer.test.ts`（补 codex_app 响应侧拆回）
- Test: `test/providers/openai-responses/protocol.test.ts`（补 mcp__ 请求侧历史 function_call 拍平 + 请求侧一致性）
- Test: `test/server/codex-endpoint.test.ts`（端到端，若存在；否则 Step 3 退而用 protocol 组合测试）
- Verify: 全量 typecheck + test

**Interfaces:**
- 验证 Task 1-5 覆盖现有 mcp__/codex_app 路径（同一机制），handle-protocol 接线端到端通，不回归。

- [ ] **Step 1: 补 codex_app 响应侧拆回测试**

在 `renderer.test.ts` 加：

```typescript
  it('renders codex_app namespace tool back to {name, namespace}', () => {
    const namespaceFlatMap = new Map([
      ['codex_app__load_workspace_dependencies', { namespace: 'codex_app', name: 'load_workspace_dependencies' }],
    ])
    const result = renderOpenAIResponse({
      model: 'gpt-5',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'call_1', toolName: 'codex_app__load_workspace_dependencies', input: {} }],
      namespaceFlatMap,
    })
    const fc = result.output.find((o) => o.type === 'function_call')
    expect(fc).toMatchObject({ type: 'function_call', name: 'load_workspace_dependencies', namespace: 'codex_app' })
  })
```

- [ ] **Step 2: 补 mcp__ 请求侧历史 function_call 拍平测试**

在 `protocol.test.ts` 的 `describe('historical function_call namespace → flattened toolName', ...)` 内加（验证 mcp__ 路径请求侧拍平，与 multi_agent_v1 同机制）：

```typescript
    it('maps mcp__ namespace function_call to flattened toolName', () => {
      const result = mapResponsesRequestToAISDKInput({
        model: 'gpt-5',
        input: [
          { type: 'function_call', call_id: 'call_1', name: 'codegraph_search', namespace: 'mcp__codegraph', arguments: '{"query":"x"}' },
          { type: 'function_call_output', call_id: 'call_1', output: '{}' },
        ],
      }, { providerType: 'openai-compatible' })
      expect((result.messages[0].content as Array<{ toolName: string }>)[0]!.toolName).toBe('mcp__codegraph__codegraph_search')
    })
```

- [ ] **Step 3: 端到端测试 — handle-protocol 接线（必须）**

Task 4 的 strategy 接口 + handle-protocol 三处传递（streaming/stream-only/generate）是本特性核心回路，**必须有端到端测试覆盖**——Task 5 的 renderer 单元测试直接调 renderer、绕过 handle-protocol，无法捕获接线错误（如忘记调 `getNamespaceFlatMap` 或忘传给 render）。

在 `test/server/codex-endpoint.test.ts`（已确认存在，用 `createApp` + `makeGateway` 模式，参照其现有 tool_search 端到端用例）加：构造含 `tool_search_output`（发现 `multi_agent_v1`/`spawn_agent`）的 `/codex/v1/responses` 请求，mock 上游（`makeGateway`）返回 `toolName: 'multi_agent_v1__spawn_agent'` 的 tool-call，断言响应 `function_call` 含 `name: 'spawn_agent'` + `namespace: 'multi_agent_v1'`。先读 `codex-endpoint.test.ts` 确认 `makeGateway` 是否支持自定义 toolCalls 返回。

若 `makeGateway` 不支持自定义 toolCalls 或 mock 难度过高，**退而**在 `protocol.test.ts` 加请求侧一致性组合测试（仅验证 tools[] 与 flatMap 一致，**不覆盖 handle-protocol 接线**——此时需在 commit message 标注"handle-protocol 接线依赖类型检查 + 手动验证，未端到端覆盖"，并在 Task 6 Step 6 全量测试后手动跑一次 codex 客户端连 llm-proxy 验证）：

```typescript
  it('request-side tools[] and namespaceFlatMap agree on flatName', () => {
    const request = validateOpenAIResponsesRequest({
      model: 'gpt-5',
      input: [{ type: 'tool_search_output', call_id: 'ts_1', tools: [
        { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }] }] }],
    })
    const mapped = mapResponsesRequestToAISDKInput(request, { providerType: 'openai-compatible' })
    const flatMap = getResponsesNamespaceFlatMap(request)
    expect(Object.keys(mapped.tools!)).toContain('multi_agent_v1__spawn_agent')
    expect(flatMap!.has('multi_agent_v1__spawn_agent')).toBe(true)
    expect(flatMap!.get('multi_agent_v1__spawn_agent')).toEqual({ namespace: 'multi_agent_v1', name: 'spawn_agent' })
  })
```

- [ ] **Step 4: 运行 Task 6 新增测试**

Run: `pnpm test test/providers/openai-responses/protocol.test.ts test/providers/openai-responses/renderer.test.ts`
Expected: PASS（含 Step 3 的 codex-endpoint 用例，若加了）。

- [ ] **Step 5: 全量 typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 6: 全量测试 + 回归基准**

Run: `pnpm test`
Expected: 全部 PASS。**回归基准**（必须通过，验证不破坏现有）：
- `test/providers/openai-responses/protocol.test.ts`：namespace flatten（`mcp__node_repl__js`，约 L325-380）、tool_search_call 映射（约 L444-505）。
- `test/providers/openai-responses/renderer.test.ts`：tool_search 渲染（约 L635-671）、custom tool 渲染。
- `test/providers/enumerate-models.test.ts`、`test/providers/models.test.ts`、`test/server/` 全部。
- `test/cli/codex-install.test.ts`、`test/cli/codex-toml.test.ts`（codex 配置，不受影响但回归）。

- [ ] **Step 7: Commit**

```bash
git add test/providers/openai-responses/renderer.test.ts test/providers/openai-responses/protocol.test.ts
git commit -m "test(codex): cover mcp__/codex_app regression + namespace render-back e2e"
```

---

## Self-Review

**1. Spec coverage:**
- 请求侧扫 `tool_search_output` 拍平加入 `tools[]` → Task 2 ✓
- 历史 `function_call` namespace → 拍平名 → Task 3 ✓
- `getNamespaceFlatMap` 映射构建 → Task 1 ✓
- strategy 接口 + handle-protocol 传递 → Task 4 ✓
- 响应侧 renderer 拆回 `{name, namespace}`（streaming + non-streaming）→ Task 5 ✓
- 现有 mcp__/codex_app 路径修复 → Task 6（同一机制覆盖）✓
- 膨胀保护（不实现，记录）→ spec 已记录，计划不含 ✓
- 测试（请求侧/响应侧/回归/端到端）→ Task 1-6 ✓
- 待验证项（流式 call_id、capability、顶层 function）→ spec 已记录 ✓

**2. Placeholder scan:** 无 TBD/TODO；所有步骤含完整代码与命令。

**3. Type consistency:**
- `NamespaceFlatMap = Map<string, NamespaceFlatEntry>`，`NamespaceFlatEntry = { namespace: string | undefined; name: string }` — Task 1 定义，Task 4/5 使用一致。
- `getResponsesNamespaceFlatMap` 返回 `NamespaceFlatMap | undefined` — Task 1 定义，Task 4 暴露一致。
- `resolveNamespacedToolName` 返回 `{ name: string; namespace?: string }`，参数复用 `NamespaceFlatMap` 类型 — Task 5 定义并使用一致。
- `flattenToolName(name, namespace)` 返回 `string` — **Task 1 Step 4 定义**，Task 1（collectNamespaceFlatMap 的 add）/Task 2（toolSet 拼接）/Task 3（历史 function_call）复用，拼接规则一致。
- `ResponseFunctionToolCall.namespace?` / `StreamFunctionCallItem.namespace?` — Task 5 加，renderer 使用一致。
- `renderStreamSSE` input 与 `renderResult`（`RenderResultInput`）的 `namespaceFlatMap?` 字段一致（都用 `NamespaceFlatMap`）。
- `functionCallSchema` 加 `namespace: z.string().optional()`（Task 3），`customToolCallSchema` 已 passthrough — 两 schema 都保留 namespace。

**4. 待验证项（本次不实现，spec 已记录）：**
- **MCP namespace 值一致性**：codex 源码显示 MCP `ToolName.namespace` 可能是裸 server 名（`github`），而 `request.tools[].namespace.name` 是 `mcp__{server}`（callable_namespace）。本计划假设 codex 对同一工具在 `request.tools`/`tool_search_output`/历史 `function_call.namespace` 三处用同一 namespace 值（回路一致）。若实测 MCP 历史 `function_call.namespace` 与 `namespace.name` 不一致，flatMap key 与历史拍平名不匹配，需用 `function_call.namespace` 而非 `namespace.name` 构建 flatMap。multi_agent_v1 路径已用真实数据确认一致。
- **tool_search_output 顶层 function 是否带 `type:'function'`**：现有测试 fixture 用裸 `{name}`（无 type）。本计划 Task 1/2 用 `t.type === 'function'` 判断。若 codex 真实顶层 function 不带 type，需放宽判断（`t.type === 'function' || (t.type === undefined && t.name)`）。
- **OpenAI provider 路径**：`getNamespaceFlatMap` 对 openai provider 也返回 map（无 providerType guard，与现有 namespace flatten L407-423 一致——对所有 provider 拍平）。响应侧拆回也 openai provider 生效。若 openai provider 应不同（codex 期望 openai provider 的扁平名），需加 `route.provider.type !== 'openai'` guard（参照 customToolShimmed）。本次延续现有无 guard 设计。
- 流式 call_id 关联（cc-switch #4651 类风险）、codex `namespace_tools`/`supports_search_tool` capability 配置 — spec 已记录。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-codex-tool-search-namespace.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

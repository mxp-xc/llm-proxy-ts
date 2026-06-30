# Codex tool_search 动态工具 + namespace 命名回路修复设计

## 概述

codex 通过 llm-proxy 转发到 openai-compatible 上游（GLM）时，`tool_search` 能搜到工具（前序 bug 已修），但搜到后 GLM 无法调用 `spawn_agent` 等命名空间工具。根因：codex 不把 `tool_search` 动态发现的工具放进顶层 `tools[]`（依赖 OpenAI 服务端从 `tool_search_output` 历史注册），llm-proxy 只 flatten 顶层 `tools[]`、不扫 `tool_search_output` 历史，导致 GLM `tools[]` 永远不含这些工具。同时发现现有 namespace 命名回路（mcp__/codex_app）在 codex master 下也 broken。

方案：llm-proxy 承担 codex PR #26234 的 un-flatten 角色——请求侧把 `tool_search_output` 发现的 namespace 工具拍平加入 GLM `tools[]`，响应侧把 GLM 返回的拍平名拆回 `{name, namespace}` 分离字段给 codex。一并修复现有 mcp__/codex_app 路径。

## 背景

### bug 根因
- codex `tool_search`（`execution:'client'`）本地 BM25 搜索 deferred 工具，返回 `tool_search_output`（含 namespace 工具如 `multi_agent_v1`/`spawn_agent`）。codex **不**把这些工具放进顶层 `tools[]`——它依赖 OpenAI 服务端从 `tool_search_output` 历史读取工具使其可调用（hosted 行为）。
- llm-proxy 只 flatten 顶层 `request.tools[]` 的 namespace（`protocol.ts:407-423`），**不扫 input 历史的 `tool_search_output`**。GLM 无 hosted 机制，`tools[]` 始终只有初始 16 个工具，`spawn_agent` 不在白名单。
- GLM 在 `tool_search_output` 文本里"读到"了 `spawn_agent` 描述，甚至说"现在调用 spawn_agent"，但 function calling 的 `tools` 数组是可调用白名单，模型不对未声明工具生成 `tool_call` → 反复 `tool_search` 死循环（subagent2 实测 14 次 tool_search、0 次 spawn_agent）。

### codex 期望的 function_call 格式（决定性）
- codex `function_call` **必须带 `namespace` 分离字段**：`{name:'spawn_agent', namespace:'multi_agent_v1', arguments:'<JSON字符串>', call_id}`。
- codex master **不支持扁平名** `ns__subtool`：`ToolName { name, namespace }` 无 split 逻辑，路由 HashMap 严格相等，扁平名 → `unsupported call`。PR #26234（un-flatten）未合并。
- namespace 值：MCP = `mcp__{server}`（如 `mcp__codegraph`）；`multi_agent_v1`；`codex_app`。内置工具 namespace=None（省略字段）。

### 现有命名回路 gap（Agent 6 确认）
- renderer.ts 全文无 `namespace` 引用，`function_call` 只输出扁平 `name`。
- 请求侧历史映射 `protocol.ts:250` 只取 `item.name`，忽略 `namespace` 字段。
- `functionCallSchema` 是普通 `z.object`（非 passthrough），zod 默认 strip 未声明字段，`namespace` 被丢弃 → 需显式加 `namespace: z.string().optional()`（Task 3 已修）。
- 现有 mcp__/codex_app 路径同样 broken（codex master 不认扁平名）。

### 缓存事实
- GLM-4.5+ 支持隐式 prompt caching，`tools` 在前缀最前，tools 任何变化（增删/重排/字段顺序）→ 整个前缀失效。
- 方案要求：拍平加入的 namespace 工具**幂等（只增不减）+ 追加末尾 + 固定字段顺序/结构**，使每次新增 namespace 只失效 system+messages 一次（实测 subagent2 仅 2 个 distinct namespace = 2 次失效）。

### 规模
- 典型重度用户 7-15 namespace，但模型实际 tool_search 发现的远少于配置总量（subagent2 实测 2 个）。`tool_search` 一次最多返回 8。skills 不走 tool_search。

## 方案设计

### 架构总览

```
codex 请求（input 历史含 tool_search_output + 带 namespace 的 function_call）
  ↓ 请求侧 protocol.ts mapResponsesRequestToAISDKInput
  ├─ 扫 input 历史的 tool_search_output → 拍平 ns__subtool 加入 toolSet
  │  （幂等 / 只增 / 追加末尾 / 固定字段顺序）
  ├─ 历史 function_call{name, namespace} → toolName = `${namespace}__${name}`
  │  （当前只取 name，需修）；callIdToName 索引同步用拍平名
  └─ strategy.getNamespaceFlatMap(request) 构建 flatName → {namespace, name} 映射
  ↓ handle-protocol.ts 传递映射（复用 customToolNames 模式，L104-108/L144-149）
GLM（tools[] 含 ns__subtool，可调用）
  ↓ 响应侧 renderer.ts
GLM 调用 ns__subtool → 查映射 → 渲染 {name: subtool, namespace: ns} 分离字段给 codex
```

llm-proxy 承担 codex #26234 的 un-flatten 角色：请求侧拍平给 GLM（GLM 需要扁平 function name），响应侧拆回分离字段给 codex（codex master 不支持扁平名）。

### 请求侧改动 `src/providers/openai-responses/protocol.ts`

1. **扫 `tool_search_output` 历史拍平加入 toolSet**：遍历 `request.input`，对 `type:'tool_search_output'` 的项，提取 `tools` 数组中的 namespace/function 工具：
   - namespace 元素 `{type:'namespace', name, tools:[{type:'function', name, ...}]}`：每个 function 子工具拍平为 `${namespace.name}__${subtool.name}`，加入 `toolSet`（用 `mapResponsesFunctionTool`）。跳过非 function 子工具、缺 name 子工具（复用现有 `protocol.ts:414-418` 校验）。
   - 顶层 function 元素 `{type:'function', name, ...}`（无 namespace 包裹）：直接用 `name` 加入 `toolSet`，映射记 `{namespace: undefined, name}`。
   - **幂等**：用 `selectableToolNames` Set 去重，已存在的不重复加。
   - **追加末尾**：在初始 `request.tools` 处理之后追加，不插入中间，保前缀稳定。
   - 加入 `selectableToolNames`（与 `request.tools` 的 namespace flatten 一致，`protocol.ts:419-421`），使 `tool_choice` 引用动态工具名时能正确映射，不回退 auto。

2. **修复历史 `function_call` 映射**（`protocol.ts` 遍历 input 构 `callIdToName` + 生成 assistant tool-call 处）：
   - `functionCallSchema` 已显式加 `namespace: z.string().optional()`（非 passthrough，需声明才保留）。映射时读取 `namespace` 字段：`toolName = item.namespace ? \`${item.namespace}__${item.name}\` : item.name`。
   - `callIdToName.set(item.call_id, toolName)` 用拍平名，使后续 `function_call_output` 的 `toolName`（`protocol.ts:281`）匹配 GLM 历史的拍平名。
   - 同理 `custom_tool_call` 若带 namespace 也按此处理（apply_patch 一般 namespace=None，但保持一致）。

3. **构建映射**（新方法，见 strategy 接口）：从 `request.tools` 的 namespace + input 历史的 `tool_search_output` 的 namespace 提取所有 `flatName → {namespace, name}` 条目。

### strategy 接口 + `src/server/handle-protocol.ts`

- `ProtocolStrategy` 新增可选方法 `getNamespaceFlatMap?(request): Map<string, {namespace: string | undefined; name: string}>`（复用 `getCustomToolNames` 模式）。仅 openai-responses strategy 实现。
- `handle-protocol.ts`：`const namespaceFlatMap = strategy.getNamespaceFlatMap?.(request)`（L106 附近），传给 `renderStreamSSE`/`renderResult`（`renderInput.namespaceFlatMap = namespaceFlatMap`，L147-149/L189-191/L218-220 附近）。

### 响应侧改动 `src/providers/openai-responses/renderer.ts`

- `renderOpenAIResponseSSE`/`renderResult` 输入新增 `namespaceFlatMap?: Map<string, {namespace: string | undefined; name: string}>`。
- 渲染 `function_call`（streaming `output_item.added`/`done` + non-streaming）时：`const ns = namespaceFlatMap?.get(call.toolName)`；若命中且 `ns.namespace !== undefined`，输出 `{name: ns.name, namespace: ns.namespace, ...}`；否则输出 `{name: call.toolName, ...}`（普通工具，无 namespace 字段）。
- `arguments` 仍是 JSON 字符串（codex 期望字符串）。
- 普通工具（exec_command、apply_patch、tool_search shimmed）不命中映射，行为不变。

### 命名回路规则
- 拍平：`${namespace}__${name}`。例：`mcp__codegraph__codegraph_search`、`multi_agent_v1__spawn_agent`、`codex_app__load_workspace_dependencies`。
- 拆回：用映射查表（不用 split，避免误拆普通工具名）。映射构建时，从 namespace 元素的 `{name, tools:[{name}]}` 生成 `flatName → {namespace: ns.name, name: subtool.name}`。
- namespace 值原样使用（MCP 的 `mcp__{server}` 本身含 `mcp__` 前缀，不要二次处理）。

### 缓存策略
- 拍平加入的工具：幂等 + 追加末尾 + 固定字段顺序（`mapResponsesFunctionTool` 输出顺序稳定）。
- 不按请求上下文重排或精简 tools schema。
- 缓存命中可观测：`usage.prompt_tokens_details.cached_tokens`（已透传）。

## 修复范围

本次一并修复：
1. `tool_search_output` 动态发现的 namespace 工具加入 GLM `tools[]`（核心 bug）。
2. 历史 `function_call` 的 namespace 字段处理（请求侧）。
3. renderer 渲染 `function_call` 输出 `{name, namespace}` 分离字段（响应侧）。
4. 现有 mcp__/codex_app 路径（同一映射机制覆盖，响应侧拆回 namespace）。

## 测试

`test/providers/openai-responses/protocol.test.ts`：
- `tool_search_output` 含 namespace 工具 → 拍平 `ns__subtool` 加入 `tools[]`；幂等（重复 tool_search_output 不重复加）；追加末尾不破坏初始 tools 顺序。
- 历史 `function_call{name:'spawn_agent', namespace:'multi_agent_v1'}` → 映射为 `toolName:'multi_agent_v1__spawn_agent'`；`function_call_output` 的 toolName 匹配。
- `getNamespaceFlatMap` 返回正确映射（含 request.tools namespace + tool_search_output namespace）。

`test/providers/openai-responses/renderer.test.ts`：
- GLM tool-call `toolName:'multi_agent_v1__spawn_agent'` + 映射 → 渲染 `{name:'spawn_agent', namespace:'multi_agent_v1', arguments}`（streaming + non-streaming）。
- GLM tool-call `toolName:'mcp__codegraph__codegraph_search'` + 映射 → 渲染 `{name:'codegraph_search', namespace:'mcp__codegraph'}`。
- 普通工具 `exec_command` 不受影响（无 namespace 字段）。
- 现有 namespace flatten 测试（`protocol.test.ts:325-380`）回归通过。

端到端（可选，受 GLM 实时可用性限制）：codex 经 llm-proxy 发"fan out subagents"请求，确认 tool_search 搜到 `multi_agent_v1` 后 GLM 能调用 `spawn_agent`，不再死循环。

## 膨胀保护（未来工作，本次不实现）

累计发现的 distinct namespace 超 ~15 或 tools 超 ~80 时，退化为只暴露 namespace 名+描述（模拟 deferred，强制模型 tool_search）或转 invoke wrapper（Meta-Tool Pattern）。本次仅记录，不实现。触发条件待真实重度 MCP 场景验证后定。

## 待验证项

- **llm-proxy 流式 call_id 关联**：cc-switch issue #4651 报告 GLM/MiniMax 等 opaque `call_<hash>` id provider 流式下 tool_call 关联坏。llm-proxy 流式渲染是否正常需验证（独立问题，本次不修）。
- **codex `namespace_tools`/`supports_search_tool` capability**：subagent2 数据显示 codex 经 llm-proxy 已发 tool_search（说明当前已启用），但需确认 `buildCodexModelsResponse` 的 ModelInfo 配置是否显式设置这两个 capability，避免依赖默认值。
- **tool_search_output 顶层 function 元素**（无 namespace 包裹）：subagent2 未见此情况，spec 按 `namespace=undefined` 处理，需实测确认 codex 期望。

## 调研依据

- codex 源码：`ToolName { name, namespace }` 无 split（`codex-rs/protocol/src/tool_name.rs`）；`build_tool_call` 用 `ToolName::new(namespace, name)`（`router.rs`）；PR #26234 un-flatten 未合并；issue #20652 扁平名 unsupported。
- OpenAI tool_search：client 模式 codex 本地 BM25；`tool_search_output` 工具靠声明可用（"Tools not listed in this array will not be available"）；注入 context 末尾保缓存。
- GLM：隐式 prompt caching，tools 在前缀最前，变化全失效（`usage.prompt_tokens_details.cached_tokens`）。
- AI SDK：`ToolCallPart.input` 始终 string；openai-compatible 不支持 namespace/tool_search（llm-proxy 自行 shim）。
- 真实数据：`temp/data/subagent2/`（14 次 tool_search / 2 distinct namespace / 0 spawn_agent）、`temp/data/paylaod/codex-body.json`（spawn_agent 带 namespace 字段证据）。

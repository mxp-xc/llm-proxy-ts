# 模型视觉能力与图片输入降级设计

**日期：** 2026-07-21
**状态：** Approved

## 目标

为不支持视觉输入的模型提供显式配置。当请求包含图片而最终选中的模型不支持视觉时，proxy 在调用
上游前移除图片数据，同时保留同一消息中的文本内容，包括客户端或工具带入的文件路径描述。工具结果
中的图片不再被清空，而是在原位置换成协议原生文本，提示 agent 改用可用的图片分析 MCP/工具；配置
共享目录后，proxy 还会把内联图片保存为 agent 可访问的临时 artifact，并在提示中给出路径。

首期覆盖 OpenAI Chat Completions、Codex 使用的 OpenAI Responses，以及 Claude 使用的 Anthropic
Messages 三条协议链路。配置未声明时有效值为 `true`，不触发降级过滤。Anthropic image schema 与
mapper 兼容属于本功能范围，因此此前仅因 schema 不认识 image 而返回 `400` 的 Claude 图片请求会
改为正常映射；这不是降级过滤产生的行为。

## 配置结构

视觉能力同时支持 provider 默认值和 model 覆盖值：

```jsonc
{
  "providers": {
    "zhipu": {
      "type": "openai-compatible",
      "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
      "options": {
        "supports_vision": false,
      },
      "models": {
        "glm-5-turbo": {
          "upstreamModel": "glm-5-turbo",
        },
        "glm-5V-turbo": {
          "upstreamModel": "glm-5V-turbo",
          "supports_vision": true,
        },
      },
    },
  },
}
```

- `provider.options.supports_vision`：该 provider 下所有模型的默认值。
- `model.supports_vision`：单个模型的覆盖值。
- 两层字段均可省略。
- 最终值按以下优先级解析，缺省为 `true`：

```typescript
model.supports_vision ?? provider.options?.supports_vision ?? true
```

该结构沿用现有 `provider.options.reasoning_effort` / `model.reasoning_effort` 和 `provider.options.codex` / `model.codex` 的两层继承方式，不为单个字段新增 `model.options`。

tool-result artifact 是独立的全局降级策略，不属于 provider/model 能力配置。默认不写盘，只注入不含
路径的 unavailable notice；配置以下共享目录后才启用持久化：

```jsonc
{
  "visionFallback": {
    "toolResultArtifacts": {
      "storageDir": "C:/llm-proxy/vision-artifacts",
      "agentVisibleDir": "/workspace/.llm-proxy/vision-artifacts",
      "ttlMs": 86400000,
      "maxImageBytes": 10485760,
      "maxRequestBytes": 20971520,
      "maxTotalBytes": 1073741824,
    },
  },
}
```

- `storageDir` 是 proxy 实际写入目录；`agentVisibleDir` 是同一共享目录在 agent 运行环境中的可见路径。
- `toolResultArtifacts` 整体省略时关闭写盘。两个目录字段必须同时提供，避免生成 agent 不可访问的
  虚假路径。
- 其余字段使用以上默认值，分别控制 artifact TTL、单图、单请求和目录总字节数。
- artifact 使用随机 ID 和由受信 MIME 映射出的扩展名，不采用请求中的文件名或路径。

`supports_vision` 在语义上属于模型能力，而不是模型路由能力。当前
`providers.<provider>.models.<model>` 的 schema 名为 `modelRouteConfigSchema`，只是现有配置容器的
实现名称；本设计不以该名称改变能力归属，也不为此做无关重命名。

## 架构与处理顺序

配置归属只有 provider 默认值和 model 覆盖值，不新增 route 配置层。请求的 model selector 可能是带
provider 前缀的模型名、裸模型名或 alias；`RoutingTable` 只负责选中具体 provider/model。选中后，
handler 通过独立配置解析函数得到最终 camelCase 值，并仅作为本次请求的局部变量使用：

```typescript
const supportsVision = resolveModelSupportsVision(provider, model)
```

`resolveModelSupportsVision(provider, model)` 集中实现
`model.supports_vision ?? provider.options?.supports_vision ?? true`。`RouteMatch` 不新增能力字段；
route 与视觉能力的唯一关系是必须先完成路由，才能知道该解析哪一个 provider/model。当前只有一个
布尔能力，不提前引入 `ResolvedModelCapabilities` 等聚合对象。

协议 mapper 不读取配置，也不负责日志、文件 I/O 或错误响应。`ProtocolStrategy` 增加可选的协议能力
接口 `ProtocolVisionInputFilter`，由 OpenAI Chat Completions、OpenAI Responses 和 Anthropic
Messages 策略分别提供协议感知的纯 adapter。统一编排顺序为：

```text
validate original body
-> resolve route
-> resolve supportsVision from selected provider/model
-> protocol-aware vision plan
-> persist eligible tool-result artifacts
-> apply removals and synthetic text replacements
-> report mutation outcome / revalidate filtered body
-> prepareExecution(filtered body)
-> map filtered request to AISDKInput
-> upstream
```

仅在最终 `supportsVision` 为 `false` 时调用 adapter。adapter 使用 `plan -> persist -> apply`：

- 只按已知协议路径识别图片，不递归扫描任意 JSON，因此不会删除 `tool_use.input`、普通工具参数或
  其中的文件路径。
- `planUnsupportedVisionInput(rawBody)` 只收集 tool-result 图片候选、图片计数及可选拒绝原因，不修改
  body。候选以原始 body 的 RFC 6901 JSON Pointer 标识。
- server 层 `VisionArtifactStore` 只处理候选图片的解码、配额和写盘；adapter 不执行文件 I/O。
- `applyUnsupportedVisionInput(plan, replacements)` 对原始请求体 copy-on-write，返回替换后的 body、
  逐项变更列表和统计值；无 mutation 时保持原对象引用。
- body 发生变更后，若 plan 返回 `unsupported_vision_input`，不写 artifact，使用
  `request_rejected` replacement 生成可审计的 transform 结果，记录汇总日志后返回 `400`；
  否则使用同一协议 schema 重新验证，再进入后续流程。
- 过滤后的同一份 body 同时传给 `prepareExecution` 和协议 mapper。OpenAI Responses 的 raw-body
  passthrough 不得继续持有原始未过滤 body，避免合并阶段重新带回图片。

首期只处理以下协议 allowlist 中命中的图片 block；普通消息图片删除，tool-result 图片替换为 notice：

- OpenAI Chat Completions：`messages[*].content[*]` 中 `type: "image_url"`。
- OpenAI Responses：easy input message 与 `agent_message` 的 `input[*].content[*]`，以及
  `function_call_output` / `custom_tool_call_output` 的 `input[*].output[*]` 中
  `type: "input_image"`。
- Anthropic Messages：`messages[*].content[*]` 中 `type: "image"`，以及外层为 `tool_result` 时
  `messages[*].content[*].content[*]` 中 `type: "image"`。

transform 不递归扫描 tool arguments、tool schema、普通字符串或其他同名字段，不把字符串中的 data
URL/base64 当图片删除，也不根据文件名或扩展名猜测 Responses `input_file` 是图片。

当 `supportsVision` 为 `true`，或请求中没有图片时，不创建替代 body，保持现有映射与 raw-body
passthrough 行为。

Anthropic schema 与 mapper 需要新增顶层 user image 和 `tool_result.content[]` image 支持。映射使用
AI SDK `FilePart` 和多模态 `ToolResultOutput`，从而在允许视觉时保留完整图片内容与 block 顺序。

## 降级行为

当最终 `supports_vision` 为 `false` 时：

- 删除请求中所有实际图片内容，不只处理 base64 data URL。
- 保留同一消息中的普通文本内容及其顺序。
- 保留请求中本来存在的图片路径文本或工具参数。`Read` 实测路径位于
  `tool_use.input.file_path`；本次 MCP 实测没有路径。两者都不解析、不改写，也绝不合成路径。
- 不读取请求中的本地路径，也不尝试让 proxy 自行识图。
- 若移除图片后仍有文本内容，请求继续发送给上游。
- 普通 user message 的“可用 content”定义为至少一个满足 `text.trim().length > 0` 的文本 block。
  `trim()` 只用于判空，继续转发时保留原始文本和空白，不拼接或改写。
- 请求历史中任意一条普通 user message 因移除图片而不再有可用 content 时，拒绝整个请求并返回
  `400 unsupported_vision_input`；不删除该消息继续发送、不向上游发送空消息，也不创建占位文本。
- 三条协议的 tool-result 容器都必须保留及其关联 ID：Chat tool message 的 `tool_call_id`、Responses
  `function_call_output` / `custom_tool_call_output` 的 `call_id`，以及 Anthropic `tool_result` 的
  `tool_use_id`。
- image-only tool result 将 `content` / `output` 直接替换为包含全部 notice 的字符串，确保最终 mapper
  产生文本 tool output。mixed tool result 中每个图片 block 都在原位置替换为协议原生 synthetic
  text block：Chat 使用 `{ type: "text" }`，Responses 使用 `{ type: "input_text" }`，Anthropic
  使用 `{ type: "text" }`。两种情况都不返回 `400`。
- mixed tool result 保持原始 `text / image / text` 的相对顺序，结果为 `text / notice / text`；不拼接
  相邻文本，也不把整个结果替换为单一字符串。
- notice 明确说明选中模型被配置为不支持视觉，并要求 agent 查找可用的图片分析 MCP/工具、让工具以
  文本返回分析结果且不要再次返回图片，避免 fallback 循环。
- artifact 写入成功时 notice 包含 `agentVisibleDir` 下的随机文件路径；未配置存储、来源不支持、输入
  不合法、超出配额或写盘失败时注入明确的 unavailable notice，不提供虚假路径，请求仍继续上游。

artifact v1 仅保存内联 base64 或 base64 data URL。远程 URL 和 `file_id` 只生成 unavailable notice；
proxy 不发起下载，避免 SSRF。允许的 MIME 为 `image/png`、`image/jpeg`、`image/gif` 和
`image/webp`，不根据扩展名猜测类型。base64 必须严格校验后解码；写入采用同目录临时文件加原子
rename，且解码内容必须匹配对应 PNG/JPEG/GIF/WebP magic bytes。文件使用仅 owner 可读写权限（目标
平台支持时）。store 在串行化的持久化临界区内清理过期 artifact 并计算总配额，避免同一进程内并发
请求突破上限。
同一 store 实例会按解码后内容做进程内去重：客户端在后续轮次重发同一历史 tool result 时复用已有
artifact 并刷新 TTL，避免每轮生成副本。进程重启后的跨进程/跨实例去重和多个 proxy 共享目录时的
严格全局配额不属于 v1 保证。

当最终 `supports_vision` 为 `true` 时，不执行降级过滤。既有已支持图片路径保持原映射；新增的
Anthropic image schema 与 mapper 正常保留图片和 block 顺序。

## 错误契约

请求历史中任意一条普通 user message 因过滤而没有可用 content 时，三条入口协议均返回 HTTP
`400`，机器码统一为 `unsupported_vision_input`，且不调用 provider registry 或上游 gateway。

OpenAI Chat Completions 与 OpenAI Responses 共用 OpenAI 风格错误体：

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unsupported_vision_input",
    "message": "Vision input is not supported by the selected model"
  }
}
```

Anthropic Messages 保留标准 `invalid_request_error` 类型，并增加 proxy 扩展字段 `code`：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "code": "unsupported_vision_input",
    "message": "Vision input is not supported by the selected model"
  }
}
```

协议 transform 只返回 `unsupported_vision_input` 拒绝原因；对应 `ProtocolErrorFormatter` 负责构造
协议错误体。

原始 body 已通过 schema；transform 后重新验证失败说明 proxy 破坏了自身不变量，不属于客户端
无效输入。此时返回 sanitized 的协议风格 HTTP `500`，不得伪装成 `400` 或
`unsupported_vision_input`，也不得调用 `prepareExecution`、provider registry 或 gateway：

- OpenAI Chat Completions / Responses：
  `{ "error": { "type": "internal_error", "code": "internal_server_error", "message": "Internal server error" } }`
- Anthropic Messages：
  `{ "type": "error", "error": { "type": "api_error", "message": "Internal server error" } }`

## 日志

任何实际修改请求消息体的降级操作都必须记录结构化日志，包括删除普通消息图片 block，以及把
tool-result 图片替换为 synthetic text。未发生消息体变更时不记录该类日志。

每个被修改的请求恰好汇总记录一条 `info` 日志，确保默认日志级别下可见：

```typescript
{
  event: 'vision_input_filtered',
  protocol: 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages',
  provider: string,
  requestedModel: string,
  actualModel: string,
  supportsVision: false,
  outcome: 'forwarded' | 'rejected' | 'internal_error',
  removedImageCount: number,
  affectedMessageCount: number,
  fallbackNoticeCount: number,
  storedArtifactCount: number,
  unavailableArtifactCount: number,
  unavailableReasonCounts?: Record<string, number>,
  changes: Array<
    | {
        action: 'remove_image'
        path: string
        role?: string
        blockType: 'image_url' | 'input_image' | 'image'
      }
    | {
        action: 'replace_tool_result_image'
        path: string
        role?: string
        blockType: 'image_url' | 'input_image' | 'image'
        containerType:
          | 'tool_message'
          | 'function_call_output'
          | 'custom_tool_call_output'
          | 'tool_result'
        artifactStatus: 'stored' | 'unavailable'
        unavailableReason?: string
      }
  >,
}
```

- `requestId` 由现有 request-scoped logger binding 自动加入，不在 payload 中重复传入。
- `path` 是指向原始已验证 body 的 RFC 6901 JSON Pointer；`~` 编码为 `~0`，`/` 编码为
  `~1`。删除或替换图片时均指向原始图片 block。changes 按原始 body 的稳定遍历顺序排列。
- 每个图片 block 对应一项 change。普通消息图片记录 `remove_image`，tool-result 图片记录
  `replace_tool_result_image`；`removedImageCount` 和 `fallbackNoticeCount` 分别等于对应 action 的
  项数。
- `affectedMessageCount` 对发生 mutation 的顶层会话项去重计数：Chat/Anthropic 按
  `messages[index]`，Responses 按 `input[index]`。
- `storedArtifactCount` / `unavailableArtifactCount` 对 replacement change 分类计数；
  `unavailableReasonCounts` 仅按固定 reason code 聚合，不包含 artifact 定位信息。
- `outcome` 分别表示继续上游、以 `400 unsupported_vision_input` 拒绝，或 transform 后重验证失败。
  三种结果都记录这一条汇总日志，不为每张图片另记一行。
- 日志不得包含 base64、图片 URL、原始文本、`tool_call_id` / `call_id` / `tool_use_id`、文件路径或
  artifact ID、notice 文本或请求 body。change 中的 `path` 仅为 JSON Pointer，不是文件路径。

artifact 持久化失败还必须记录 request-scoped `error` 日志，携带完整 `err` 和 stack；日志不包含请求
body、图片数据或 notice 文本。该错误不改变 HTTP 结果，summary 仍只记录一次，并通过
`artifactStatus: 'unavailable'` 与 `unavailableReason: 'storage_error'` 表示降级。

transform 后重验证失败还必须追加一条 request-scoped `error` 日志：

```typescript
logger.error(
  {
    event: 'vision_transform_validation_failed',
    phase: 'vision-transform-validation',
    err,
    protocol,
    provider,
    requestedModel,
    actualModel,
    removedImageCount,
    affectedMessageCount,
    fallbackNoticeCount,
  },
  'vision-transformed request validation failed',
)
```

`err` 保留完整验证错误、stack 和 issues，不得只记录 `err.message`。该错误日志不附带原始或过滤后
body，也不进入用于上游失败的完整请求持久化路径；通过同一 `requestId` 与汇总 info 日志关联。

## Codex 实测证据

使用 Codex CLI `0.144.1` 通过 `/codex/v1/responses` 请求 `zhipu/glm-5-turbo`，附带本地 PNG。
Reqable record `39` 观察到 Responses mapper 生成并发往智谱 Chat Completions 上游的 user message：

```json
[
  {
    "type": "text",
    "text": "<image name=[Image #1] path=\"node_modules/zod-to-json-schema/.github/CR_logotype-full-color.png\">"
  },
  {
    "type": "image_url",
    "image_url": {
      "url": "data:image/png;base64,..."
    }
  },
  {
    "type": "text",
    "text": "</image>"
  },
  {
    "type": "text",
    "text": "Reply with exactly: vision-codex-20260721-ded6bad6"
  }
]
```

这证明 mapper 没有把文件路径标签与图片数据合并。`image_url` 是映射后的 Chat Completions wire
shape，不是 Responses transform 的输入：禁用视觉时，Responses transform 删除原始
`input[*].content[*]` 中的 `input_image`，保留相邻路径文本；Chat Completions transform 才直接删除
`image_url`。

智谱返回 `400`、错误码 `1210`：`messages.content.type 参数非法，取值范围 ['text']`。Codex 的重试 records `39` 至 `44` 请求结构一致。

## Claude 实测证据

使用 Claude Code CLI `2.1.207` 通过 `/v1/messages` 请求 `zhipu/glm-5-turbo`，验证用户直接
附图、`Read` 工具读取本地图片，以及 MCP 工具返回图片三种场景。

### 用户直接附图

Reqable record `58` 中，Claude Code 发送的 user content 结构为：

```json
[
  {
    "type": "text",
    "text": "<system-reminder>...</system-reminder>"
  },
  {
    "type": "image",
    "source": {
      "type": "base64",
      "media_type": "image/png",
      "data": "iVBORw0KGgo..."
    }
  },
  {
    "type": "text",
    "text": "Reply exactly claude-proxy-image-20260721-a84d"
  }
]
```

图片和前后文本是独立 content block，禁用视觉时可只删除 `image` block。

### 工具读取本地图片

Claude Code 首轮请求中的图片路径位于 assistant tool call 参数。Reqable record `64` 对应的响应要求执行：

```json
{
  "type": "tool_use",
  "id": "call_c5063c034414422bbc3e8774",
  "name": "Read",
  "input": {
    "file_path": "C:\\...\\CR_logotype-full-color.png"
  }
}
```

工具执行后，record `67` 的下一轮请求包含原 assistant `tool_use`，以及独立的 user `tool_result`：

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "call_c5063c034414422bbc3e8774",
      "content": [
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "iVBORw0KGgo..."
          }
        }
      ]
    }
  ]
}
```

因此图片路径不在 `tool_result` 的相邻 text block 中，而保留在上一条 assistant
`tool_use.input.file_path`。过滤图片时不得删除或改写对应的 tool call。

### MCP 工具返回图片

使用 Claude Code CLI `2.1.207` 调用官方 `@modelcontextprotocol/server-everything` 的
`get-tiny-image`，入口 model selector 为 `zhipu/glm-5-turbo`。Reqable record `74` 是 Claude 首轮
`/v1/messages` 请求，其 SSE 响应产生 `mcp__image_test__get-tiny-image` tool use；record `75` 确认
proxy 实际请求
`https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`，上游 model 为 `glm-5-turbo`。

工具执行后，record `76` 的第二轮 Claude 请求包含以下消息：

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "call_382d14b662b844cbb288e785",
      "content": [
        { "type": "text", "text": "Here's the image you requested:" },
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "..."
          }
        },
        { "type": "text", "text": "The image above is the MCP logo." }
      ]
    }
  ]
}
```

对应的上一条 assistant `tool_use.input` 为 `{}`，没有文件路径。因此禁用视觉时只能删除 image
block 并原样保留前后 text blocks，不能合成路径或其他替代文本。record `76` 当前由 proxy 返回
`400 Invalid Anthropic Messages request`，说明 Anthropic schema 尚不接受该 MCP 多模态
`tool_result`。marker 只匹配 records `74`、`75`、`76`；record `76` 在 validation 阶段被拒绝，
没有对应的第二轮 upstream record。

### 当前兼容缺口

当前 Anthropic Messages schema 只接受 `text`、`tool_use` 和 `tool_result`：

- 顶层 message content 不接受 `image` block。
- `tool_result.content` 只接受字符串或 `text` block 数组。
- `AnthropicContentBlock` 类型注释明确将 `image` 留给后续迭代。

所以 records `58`、`67` 和 `76` 都在 proxy 入参校验阶段返回
`400 Invalid Anthropic Messages request`，没有进入 AI SDK 映射或目标上游。支持 Claude 必须先补齐
Anthropic image schema 与 mapper；`supports_vision: false` 的过滤不能只覆盖 Codex Responses 路径。

## 测试方向

最终实现至少覆盖：

- provider 默认值、model 覆盖值和缺省 `true` 的解析优先级。
- `supports_vision: true` 不触发降级过滤；新增 Anthropic image schema/mapper 后完整保留图片。
- `supports_vision: false` 删除普通消息图片、替换 tool-result 图片，并保留前后文本和已有文件路径标签。
- 消息同时包含多张图片、纯图片、图片 URL、base64 data URL 和文件引用时的行为。
- OpenAI Chat Completions `image_url` content part 的解析和过滤。
- OpenAI Responses easy input、`agent_message`、`function_call_output` 和
  `custom_tool_call_output` 中 `input_image` 的过滤，不误删 `input_file` 或普通字符串。
- Claude 顶层 user image 与 `tool_result.content[]` image 的解析和过滤。
- Claude `Read` tool call 中的原文件路径在过滤后保持不变；MCP `{ input: {} }` 的
  text/image/text 结果不得伪造原路径，仅在 artifact 成功写入时提供 proxy 生成路径。
- 空白文本不算可用 content；任意普通 user message 因过滤变空时返回
  `400 unsupported_vision_input`，且不向上游发送请求。
- OpenAI Chat Completions、Responses 与 Anthropic Messages 的 `400` 错误体符合上述协议契约，并
  包含统一机器码，且 provider registry 与 gateway 零调用。
- Chat tool message、Responses 两类 call output 与 Anthropic `tool_result` 在图片-only 时分别保留
  `tool_call_id`、`call_id`、`tool_use_id`，并把 content/output 转为 notice 字符串。
- 三协议 mixed tool result 保持 `text / notice / text` 顺序；不拼接相邻 block。
- 默认未配置 artifact store、成功落盘、远程 URL/`file_id`、非法 base64、不支持 MIME、单图/单请求/
  总配额超限、TTL 清理、并发配额和写盘失败降级。
- 每次实际修改消息体均恰好记录一条满足字段、计数、RFC 6901 path 和敏感数据约束的汇总 `info`。
- transform 后重验证失败记录完整 error 与 `outcome: 'internal_error'`，返回协议化 `500` 且不调用
  后续执行链路。
- OpenAI Responses native passthrough 的 `prepareExecution` 和 mapper 接收同一 filtered body，raw
  merge 不得重新带回图片。
- OpenAI Chat Completions、Codex Responses 与 Claude Messages 三条真实协议映射链路。

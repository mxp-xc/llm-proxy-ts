# 错误日志功能设计

## 目标

当上游 provider 请求出现异常时，将本次客户端请求的完整入参和上游完整出参记录到独立错误日志文件，便于定位、修复与优化。

## 触发范围

记录以下四类上游异常（含超时）：

- 流式响应中途出错（SSE 已发部分后，上游报错或流中断）
- 首包前出错（`acquireStream` 失败，尚未向客户端发送数据）
- 非流式 `generate` 出错（含 streamOnly 收集阶段出错）
- 请求超时（504）

不记录：客户端入参校验失败（400）、路由失败/模型不存在（404）、OAuth 未授权（503）、限流（429）。

## 方案

在 `handleProtocolRequest` 集中拦截（方案 A）。`handleProtocolRequest` 是唯一同时持有客户端原始请求体和上游出参/错误对象的位置，错误日志的核心价值在于入参与出参的完整关联，因此拦截层放在此处而非 `ModelGateway` 层（后者拿不到原始入参）。

## 模块边界

```
handle-protocol.ts (拦截层)
  ├─ 流式路径: teeStream 包装 acquired.stream，缓冲 chunk 引用
  │    ├─ onError / handleUpstreamError → ErrorLogger.log()
  │    └─ 正常结束 → 丢弃缓冲
  └─ 非流式路径: handleUpstreamError → ErrorLogger.log()

error-logger.ts (落盘层)
  ├─ ErrorLogger 类: createApp 作用域单例，持文件句柄
  └─ log(entry): 截断 → 脱敏 → JSON.stringify → 追加一行

logging.ts (轮转扩展)
  └─ cleanOldLogs 增加 errors-*.ndjson 扫描，30 天
```

依赖：`handle-protocol.ts` → `error-logger.ts` → `logging.ts`（复用 `redact`、`LOG_DIR`）。`ErrorLogger` 通过 `AppDependencies` 注入，作为测试接缝。

`error-logger.ts` 职责单一：接收结构化数据，截断、脱敏、序列化后追加写入文件，不感知协议策略与流式逻辑。`handle-protocol.ts` 负责收集数据并调用，不写文件。

## 数据结构

错误日志为 NDJSON，每行一条记录：

```json
{
  "timestamp": "2026-06-30 15:23:01",
  "requestId": "a1b2c3d4-...",
  "phase": "stream",
  "provider": "openai",
  "requestedModel": "gpt-4o",
  "actualModel": "gpt-4o-2024-08-06",
  "error": {
    "name": "Error",
    "message": "...",
    "stack": "..."
  },
  "request": { },
  "response": { }
}
```

字段说明：

- `timestamp`：中国时区（+08:00，不标注），格式 `YYYY-MM-DD HH:MM:SS`，到秒，由 error-logger 落盘时生成
- `requestId`：关联普通日志的 `upstream request failed` 条目
- `phase`：复用 `ErrorPhase`（`stream` / `stream-only` / `generate`），标记出错阶段
- `provider` / `requestedModel` / `actualModel`：路由上下文
- `error`：完整 err 对象（name/message/stack）
- `request`：客户端原始请求体（`strategy.validate()` 后的 `request` 对象）
- `response`：按 phase 不同——
  - `generate`：`null`（出错无结果）
  - `stream` / `stream-only`：`ProxyStreamPart[]`（已缓冲的 chunks 数组）

## 截断与脱敏

`maxBodyLength` 分别对 `request` 和 `response` 做 `JSON.stringify`，任一超过上限则截断为：

```json
{ "_truncated": true, "originalLength": 12345, "preview": "..." }
```

`preview` 保留前 1KB。脱敏先于截断（避免截断破坏密钥结构导致脱敏失效），复用 `logging.ts` 的 `redact()` 函数。

## 流式缓冲拦截

流式路径（含 streamOnly）用 `teeStream` 包装器包住 `acquired.stream`：

```ts
const buffer: ProxyStreamPart[] = []
const teedStream = teeStream(acquired.stream, buffer)
```

`teeStream` 是 async generator，yield 每个 chunk 的同时往 `buffer` push 同一对象引用，不做序列化。正常结束时 buffer 被丢弃，不触发 error-logger。

出错时机衔接：

- 流消费中途出错（客户端断连或上游错误 chunk）：`readableStreamFromAsyncIterable` 的 `onError` 回调调用 `ErrorLogger.log()`，传入 `request`、`buffer`、`error`。`onError` 当前签名只接收 `error`，`request` 与 `buffer` 通过 `handleProtocolRequest` 构造回调时的闭包捕获传入，不改 `readableStreamFromAsyncIterable` 签名
- 首包前出错（`acquireStream` 抛错）：走 `handleUpstreamError`，buffer 为空，`response` 记 `[]`
- streamOnly 收集阶段出错：走 `handleUpstreamError`，`response` 记 buffer 中已缓冲的 chunks
- 非流式 generate 出错：走 `handleUpstreamError`，`response` 为 `null`

`teeStream` 生成器不捕获上游异常，异常正常向上传播，由现有 `onError` 处理，保持流式错误传播链不变，仅多一个旁路落盘。

`enabled` 为 `false` 时跳过 `teeStream` 包装，彻底零开销。

## 配置

配置项加在 `settingsSchema` 顶层：

```jsonc
{
  "errorLogging": {
    "enabled": true,
    "maxBodyLength": 262144
  }
}
```

- `enabled`：默认 `true`，静态控制（重启生效）
- `maxBodyLength`：默认 256KB（262144 字节），单条入参/出参序列化体积上限

Zod schema 定义在 `config.ts`，`pnpm generate:schema` 后同步到 `config/settings.schema.json`。

## 轮转

扩展 `cleanOldLogs`：

- `llm-proxy.YYYY-MM-DD.log`：7 天（现有）
- `errors-YYYY-MM-DD.ndjson`：30 天（新增）

两个前缀独立配置保留天数，复用同一扫描函数，按文件名前缀匹配对应天数。文件名日期按中国时区取日。

`ErrorLogger` 单例在 `createApp` 作用域创建，文件句柄用 `createWriteStream` 追加模式。

## 错误处理

`ErrorLogger.log()` 内部文件写入包 try/catch，失败时回退到普通 logger 记 `error log write failed`（带完整 err 对象）。这是唯一静默降级点，且必须记日志，不得静默吞错。

## 测试策略

通过 `app.fetch()` 走完整链路，注入 mock gateway/providerRegistry，错误日志写到临时目录：

1. 非流式 generate 出错：断言记录含正确 request、`response: null`、完整 error stack、phase 为 `generate`
2. 流式中途出错：mock stream 产出几个 chunk 后抛错，断言 buffer chunks 完整记录、phase 为 `stream`
3. 首包前出错：mock gateway.stream 立即抛错，断言 `response: []`、phase 为 `stream`
4. 超时：注入永不 resolve 的 gateway，断言 phase 正确、error 为 RequestTimeoutError
5. maxBodyLength 截断：构造超大 request body，断言 `_truncated` 标记和 preview
6. enabled: false：断言错误日志文件不产生新条目
7. 脱敏：request 含 `authorization` 字段，断言被 redact
8. 轮转：单元测试 `cleanOldLogs` 对 errors 文件 30 天阈值

## 影响范围

新增文件：

- `src/server/error-logger.ts`：ErrorLogger 类 + 轮转扩展
- `test/server/error-logger.test.ts`：错误日志模块测试

修改文件：

- `src/config.ts`：新增 `errorLoggingSchema`，挂到 `settingsSchema`
- `src/server/handle-protocol.ts`：流式路径接入 `teeStream`，错误分支接入 `ErrorLogger.log()`
- `src/server/types.ts`：`AppDependencies` 新增 `errorLogger?` 字段
- `src/server/app.ts`：`createApp` 创建 `ErrorLogger` 单例并注入 `handleProtocolRequest`
- `src/server/logging.ts`：`cleanOldLogs` 扩展支持 errors 文件轮转
- `config/settings.schema.json`：`pnpm generate:schema` 重新生成

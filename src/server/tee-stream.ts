import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'

/**
 * 包装异步流，在 yield 每个 chunk 的同时将其引用 push 到 buffer。
 * 不做序列化，不捕获异常——异常正常向上传播。
 * 用于错误日志：出错时 buffer 含已接收的全部 chunks，正常结束时由调用方丢弃。
 */
export async function* teeStream(
  source: AsyncIterable<ProxyStreamPart>,
  buffer: ProxyStreamPart[],
): AsyncIterable<ProxyStreamPart> {
  for await (const part of source) {
    buffer.push(part)
    yield part
  }
}

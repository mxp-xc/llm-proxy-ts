import type {
  VisionInputChange,
  VisionInputPlan,
  VisionInputTransformResult,
  VisionToolResultImageSource,
  VisionToolResultReplacement,
} from '../shared/strategy.js'
import {
  hasNonBlankTextBlock,
  isNonArrayRecord,
  requireVisionToolResultReplacement,
  toVisionToolResultChangeMetadata,
} from '../shared/vision-input.js'

const ANTHROPIC_TEXT_BLOCK_TYPES = ['text'] as const

function getImageSource(block: Record<string, unknown>): VisionToolResultImageSource {
  const source = block.source
  if (!isNonArrayRecord(source) || typeof source.type !== 'string') {
    return { type: 'unavailable', reason: 'unsupported_source' }
  }
  if (
    source.type === 'base64' &&
    typeof source.media_type === 'string' &&
    typeof source.data === 'string'
  ) {
    return { type: 'base64', mediaType: source.media_type, data: source.data }
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return source.url.startsWith('data:')
      ? { type: 'data_url', dataUrl: source.url }
      : { type: 'unavailable', reason: 'remote_url' }
  }
  return { type: 'unavailable', reason: 'unsupported_source' }
}

export function planUnsupportedAnthropicVisionInput(rawBody: unknown): VisionInputPlan {
  let imageCount = 0
  const toolResultImages: VisionInputPlan['toolResultImages'] = []
  let rejection: VisionInputPlan['rejection']

  if (!isNonArrayRecord(rawBody) || !Array.isArray(rawBody.messages)) {
    return {
      body: rawBody,
      imageCount,
      toolResultImages,
    }
  }

  for (let messageIndex = 0; messageIndex < rawBody.messages.length; messageIndex++) {
    const message = rawBody.messages[messageIndex]
    if (!isNonArrayRecord(message) || !Array.isArray(message.content)) continue

    const role = typeof message.role === 'string' ? message.role : undefined
    const remainingContent: unknown[] = []
    let removedDirectImage = false

    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
      const block: unknown = message.content[contentIndex]
      if (!isNonArrayRecord(block)) {
        remainingContent.push(block)
        continue
      }

      if (block.type === 'image') {
        removedDirectImage = true
        imageCount++
        continue
      }

      if (block.type !== 'tool_result') {
        remainingContent.push(block)
        continue
      }

      if (!Array.isArray(block.content)) {
        remainingContent.push(block)
        continue
      }

      for (let nestedIndex = 0; nestedIndex < block.content.length; nestedIndex++) {
        const nestedBlock: unknown = block.content[nestedIndex]
        if (isNonArrayRecord(nestedBlock) && nestedBlock.type === 'image') {
          imageCount++
          toolResultImages.push({
            path: `/messages/${messageIndex}/content/${contentIndex}/content/${nestedIndex}`,
            source: getImageSource(nestedBlock),
          })
        }
      }
      remainingContent.push(block)
    }

    const mapsOnlyToToolMessage =
      remainingContent.length > 0 &&
      remainingContent.every((block) => isNonArrayRecord(block) && block.type === 'tool_result')
    if (
      role === 'user' &&
      removedDirectImage &&
      !mapsOnlyToToolMessage &&
      !hasNonBlankTextBlock(remainingContent, ANTHROPIC_TEXT_BLOCK_TYPES)
    ) {
      rejection = 'unsupported_vision_input'
    }
  }

  return {
    body: rawBody,
    imageCount,
    toolResultImages,
    ...(rejection === undefined ? {} : { rejection }),
  }
}

export function applyUnsupportedAnthropicVisionInput(
  plan: VisionInputPlan,
  replacements: ReadonlyMap<string, VisionToolResultReplacement>,
): VisionInputTransformResult {
  const rawBody = plan.body
  const changes: VisionInputChange[] = []
  const affectedMessages = new Set<number>()
  let removedImageCount = 0
  let fallbackNoticeCount = 0

  if (!isNonArrayRecord(rawBody) || !Array.isArray(rawBody.messages)) {
    return {
      body: rawBody,
      changes,
      removedImageCount,
      affectedMessageCount: 0,
      fallbackNoticeCount,
      ...(plan.rejection === undefined ? {} : { rejection: plan.rejection }),
    }
  }

  const messages: unknown[] = rawBody.messages
  let nextMessages: unknown[] | undefined

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]
    if (!isNonArrayRecord(message) || !Array.isArray(message.content)) continue

    const role = typeof message.role === 'string' ? message.role : undefined
    const nextContent: unknown[] = []
    let mutatedMessage = false

    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
      const block: unknown = message.content[contentIndex]
      if (!isNonArrayRecord(block)) {
        nextContent.push(block)
        continue
      }

      if (block.type === 'image') {
        mutatedMessage = true
        removedImageCount++
        changes.push({
          action: 'remove_image',
          path: `/messages/${messageIndex}/content/${contentIndex}`,
          ...(role === undefined ? {} : { role }),
          blockType: 'image',
        })
        continue
      }

      if (block.type !== 'tool_result' || !Array.isArray(block.content)) {
        nextContent.push(block)
        continue
      }

      const imageIndexes = block.content.flatMap((nestedBlock, index) =>
        isNonArrayRecord(nestedBlock) && nestedBlock.type === 'image' ? [index] : [],
      )
      if (imageIndexes.length === 0) {
        nextContent.push(block)
        continue
      }

      mutatedMessage = true
      const imageOnlyToolResult = imageIndexes.length === block.content.length
      const nextToolResultContent: unknown[] = []
      const imageOnlyNotices: string[] = []
      for (let nestedIndex = 0; nestedIndex < block.content.length; nestedIndex++) {
        const nestedBlock: unknown = block.content[nestedIndex]
        if (!isNonArrayRecord(nestedBlock) || nestedBlock.type !== 'image') {
          nextToolResultContent.push(nestedBlock)
          continue
        }

        const path = `/messages/${messageIndex}/content/${contentIndex}/content/${nestedIndex}`
        const replacement = requireVisionToolResultReplacement(replacements, path)
        fallbackNoticeCount++
        if (imageOnlyToolResult) imageOnlyNotices.push(replacement.text)
        else nextToolResultContent.push({ type: 'text', text: `\n\n${replacement.text}\n\n` })
        changes.push({
          action: 'replace_tool_result_image',
          path,
          ...(role === undefined ? {} : { role }),
          blockType: 'image',
          containerType: 'tool_result',
          ...toVisionToolResultChangeMetadata(replacement),
        })
      }
      nextContent.push({
        ...block,
        content: imageOnlyToolResult ? imageOnlyNotices.join('\n\n') : nextToolResultContent,
      })
    }

    if (!mutatedMessage) continue
    affectedMessages.add(messageIndex)
    nextMessages ??= [...messages]
    nextMessages[messageIndex] = { ...message, content: nextContent }
  }

  return {
    body: nextMessages === undefined ? rawBody : { ...rawBody, messages: nextMessages },
    changes,
    removedImageCount,
    affectedMessageCount: affectedMessages.size,
    fallbackNoticeCount,
    ...(plan.rejection === undefined ? {} : { rejection: plan.rejection }),
  }
}

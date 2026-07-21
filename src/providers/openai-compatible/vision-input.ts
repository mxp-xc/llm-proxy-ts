import type {
  VisionInputChange,
  VisionInputPlan,
  VisionInputTransformResult,
  VisionToolResultImageSource,
  VisionToolResultReplacement,
} from '../shared/strategy.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasNonEmptyText(content: unknown[]): boolean {
  return content.some(
    (block) =>
      isObject(block) &&
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim().length > 0,
  )
}

function getImageSource(block: Record<string, unknown>): VisionToolResultImageSource {
  const imageUrl = block.image_url
  const url =
    typeof imageUrl === 'string'
      ? imageUrl
      : isObject(imageUrl) && typeof imageUrl.url === 'string'
        ? imageUrl.url
        : undefined
  if (url === undefined) return { type: 'unavailable', reason: 'unsupported_source' }
  return url.startsWith('data:')
    ? { type: 'data_url', dataUrl: url }
    : { type: 'unavailable', reason: 'remote_url' }
}

function requireReplacement(
  replacements: ReadonlyMap<string, VisionToolResultReplacement>,
  path: string,
): VisionToolResultReplacement {
  const replacement = replacements.get(path)
  if (replacement === undefined) {
    throw new Error(`Missing tool-result vision replacement for ${path}`)
  }
  return replacement
}

export function planUnsupportedOpenAIChatVisionInput(rawBody: unknown): VisionInputPlan {
  let imageCount = 0
  const toolResultImages: VisionInputPlan['toolResultImages'] = []
  let rejection: VisionInputPlan['rejection']

  if (!isObject(rawBody) || !Array.isArray(rawBody.messages)) {
    return {
      body: rawBody,
      imageCount,
      toolResultImages,
    }
  }

  for (let messageIndex = 0; messageIndex < rawBody.messages.length; messageIndex++) {
    const message = rawBody.messages[messageIndex]
    if (!isObject(message) || !Array.isArray(message.content)) continue

    const role = typeof message.role === 'string' ? message.role : undefined
    let removedImage = false
    const remainingContent: unknown[] = []

    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
      const block: unknown = message.content[contentIndex]
      if (isObject(block) && block.type === 'image_url') {
        removedImage = true
        imageCount++
        if (role === 'tool') {
          toolResultImages.push({
            path: `/messages/${messageIndex}/content/${contentIndex}`,
            source: getImageSource(block),
          })
        }
      } else {
        remainingContent.push(block)
      }
    }

    if (removedImage && role === 'user' && !hasNonEmptyText(remainingContent)) {
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

export function applyUnsupportedOpenAIChatVisionInput(
  plan: VisionInputPlan,
  replacements: ReadonlyMap<string, VisionToolResultReplacement>,
): VisionInputTransformResult {
  const rawBody = plan.body
  const changes: VisionInputChange[] = []
  const affectedMessages = new Set<number>()
  let removedImageCount = 0
  let fallbackNoticeCount = 0

  if (!isObject(rawBody) || !Array.isArray(rawBody.messages)) {
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
    if (!isObject(message) || !Array.isArray(message.content)) continue

    const role = typeof message.role === 'string' ? message.role : undefined
    const imageIndexes = message.content.flatMap((block, index) =>
      isObject(block) && block.type === 'image_url' ? [index] : [],
    )
    if (imageIndexes.length === 0) continue

    const imageOnlyToolResult = role === 'tool' && imageIndexes.length === message.content.length
    const nextContent: unknown[] = []
    const imageOnlyNotices: string[] = []
    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
      const block: unknown = message.content[contentIndex]
      if (!isObject(block) || block.type !== 'image_url') {
        nextContent.push(block)
        continue
      }

      const path = `/messages/${messageIndex}/content/${contentIndex}`
      if (role !== 'tool') {
        removedImageCount++
        changes.push({
          action: 'remove_image',
          path,
          ...(role === undefined ? {} : { role }),
          blockType: 'image_url',
        })
        continue
      }

      const replacement = requireReplacement(replacements, path)
      fallbackNoticeCount++
      if (imageOnlyToolResult) imageOnlyNotices.push(replacement.text)
      else nextContent.push({ type: 'text', text: `\n\n${replacement.text}\n\n` })
      changes.push({
        action: 'replace_tool_result_image',
        path,
        role,
        blockType: 'image_url',
        containerType: 'tool_message',
        artifactStatus: replacement.artifactStatus,
        ...(replacement.artifactStatus === 'unavailable'
          ? { unavailableReason: replacement.unavailableReason }
          : {}),
      })
    }

    affectedMessages.add(messageIndex)
    nextMessages ??= [...messages]
    nextMessages[messageIndex] = {
      ...message,
      content: imageOnlyToolResult ? imageOnlyNotices.join('\n\n') : nextContent,
    }
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

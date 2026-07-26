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

const OPENAI_RESPONSES_TEXT_BLOCK_TYPES = ['input_text', 'output_text', 'text'] as const

function getImageSource(block: Record<string, unknown>): VisionToolResultImageSource {
  const imageUrl = block.image_url
  const url =
    typeof imageUrl === 'string'
      ? imageUrl
      : isNonArrayRecord(imageUrl) && typeof imageUrl.url === 'string'
        ? imageUrl.url
        : typeof block.url === 'string'
          ? block.url
          : undefined
  if (url !== undefined) {
    return url.startsWith('data:')
      ? { type: 'data_url', dataUrl: url }
      : { type: 'unavailable', reason: 'remote_url' }
  }
  if (typeof block.file_id === 'string') {
    return { type: 'unavailable', reason: 'file_id' }
  }
  return { type: 'unavailable', reason: 'unsupported_source' }
}

export function planUnsupportedOpenAIResponsesVisionInput(rawBody: unknown): VisionInputPlan {
  let imageCount = 0
  const toolResultImages: VisionInputPlan['toolResultImages'] = []
  let rejection: VisionInputPlan['rejection']

  if (!isNonArrayRecord(rawBody) || !Array.isArray(rawBody.input)) {
    return {
      body: rawBody,
      imageCount,
      toolResultImages,
    }
  }

  for (let inputIndex = 0; inputIndex < rawBody.input.length; inputIndex++) {
    const item = rawBody.input[inputIndex]
    if (!isNonArrayRecord(item)) continue

    const isAgentMessage = item.type === 'agent_message'
    const isEasyInputMessage =
      (item.type === undefined || item.type === 'message') && typeof item.role === 'string'

    if ((isEasyInputMessage || isAgentMessage) && Array.isArray(item.content)) {
      const role = isEasyInputMessage ? (item.role as string) : undefined
      const remainingContent: unknown[] = []
      let removedImage = false

      for (const block of item.content) {
        if (isNonArrayRecord(block) && block.type === 'input_image') {
          removedImage = true
          imageCount++
        } else {
          remainingContent.push(block)
        }
      }

      if (
        removedImage &&
        (role === 'user' || isAgentMessage) &&
        !hasNonBlankTextBlock(remainingContent, OPENAI_RESPONSES_TEXT_BLOCK_TYPES)
      ) {
        rejection = 'unsupported_vision_input'
      }
      continue
    }

    if (
      (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') ||
      !Array.isArray(item.output)
    ) {
      continue
    }
    for (let outputIndex = 0; outputIndex < item.output.length; outputIndex++) {
      const block: unknown = item.output[outputIndex]
      if (isNonArrayRecord(block) && block.type === 'input_image') {
        imageCount++
        toolResultImages.push({
          path: `/input/${inputIndex}/output/${outputIndex}`,
          source: getImageSource(block),
        })
      }
    }
  }

  return {
    body: rawBody,
    imageCount,
    toolResultImages,
    ...(rejection === undefined ? {} : { rejection }),
  }
}

export function applyUnsupportedOpenAIResponsesVisionInput(
  plan: VisionInputPlan,
  replacements: ReadonlyMap<string, VisionToolResultReplacement>,
): VisionInputTransformResult {
  const rawBody = plan.body
  const changes: VisionInputChange[] = []
  const affectedMessages = new Set<number>()
  let removedImageCount = 0
  let fallbackNoticeCount = 0

  if (!isNonArrayRecord(rawBody) || !Array.isArray(rawBody.input)) {
    return {
      body: rawBody,
      changes,
      removedImageCount,
      affectedMessageCount: 0,
      fallbackNoticeCount,
      ...(plan.rejection === undefined ? {} : { rejection: plan.rejection }),
    }
  }

  const input: unknown[] = rawBody.input
  let nextInput: unknown[] | undefined

  for (let inputIndex = 0; inputIndex < input.length; inputIndex++) {
    const item = input[inputIndex]
    if (!isNonArrayRecord(item)) continue

    const isAgentMessage = item.type === 'agent_message'
    const isEasyInputMessage =
      (item.type === undefined || item.type === 'message') && typeof item.role === 'string'

    if ((isEasyInputMessage || isAgentMessage) && Array.isArray(item.content)) {
      const role = isEasyInputMessage ? (item.role as string) : undefined
      const filteredContent: unknown[] = []
      let removedImage = false
      for (let contentIndex = 0; contentIndex < item.content.length; contentIndex++) {
        const block: unknown = item.content[contentIndex]
        if (!isNonArrayRecord(block) || block.type !== 'input_image') {
          filteredContent.push(block)
          continue
        }
        removedImage = true
        removedImageCount++
        changes.push({
          action: 'remove_image',
          path: `/input/${inputIndex}/content/${contentIndex}`,
          ...(role === undefined ? {} : { role }),
          blockType: 'input_image',
        })
      }
      if (!removedImage) continue
      affectedMessages.add(inputIndex)
      nextInput ??= [...input]
      nextInput[inputIndex] = { ...item, content: filteredContent }
      continue
    }

    if (
      (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') ||
      !Array.isArray(item.output)
    ) {
      continue
    }

    const imageIndexes = item.output.flatMap((block, index) =>
      isNonArrayRecord(block) && block.type === 'input_image' ? [index] : [],
    )
    if (imageIndexes.length === 0) continue

    const imageOnlyToolResult = imageIndexes.length === item.output.length
    const nextOutput: unknown[] = []
    const imageOnlyNotices: string[] = []
    for (let outputIndex = 0; outputIndex < item.output.length; outputIndex++) {
      const block: unknown = item.output[outputIndex]
      if (!isNonArrayRecord(block) || block.type !== 'input_image') {
        nextOutput.push(block)
        continue
      }

      const path = `/input/${inputIndex}/output/${outputIndex}`
      const replacement = requireVisionToolResultReplacement(replacements, path)
      fallbackNoticeCount++
      if (imageOnlyToolResult) imageOnlyNotices.push(replacement.text)
      else nextOutput.push({ type: 'input_text', text: `\n\n${replacement.text}\n\n` })
      changes.push({
        action: 'replace_tool_result_image',
        path,
        blockType: 'input_image',
        containerType: item.type,
        ...toVisionToolResultChangeMetadata(replacement),
      })
    }

    affectedMessages.add(inputIndex)
    nextInput ??= [...input]
    nextInput[inputIndex] = {
      ...item,
      output: imageOnlyToolResult ? imageOnlyNotices.join('\n\n') : nextOutput,
    }
  }

  return {
    body: nextInput === undefined ? rawBody : { ...rawBody, input: nextInput },
    changes,
    removedImageCount,
    affectedMessageCount: affectedMessages.size,
    fallbackNoticeCount,
    ...(plan.rejection === undefined ? {} : { rejection: plan.rejection }),
  }
}

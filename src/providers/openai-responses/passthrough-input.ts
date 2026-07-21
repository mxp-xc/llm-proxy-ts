import { ADDITIONAL_TOOLS_ANCHOR_PREFIX, AGENT_MESSAGE_ANCHOR_PREFIX } from './protocol.js'

const EASY_INPUT_MESSAGE_ROLES = new Set(['system', 'developer', 'user', 'assistant'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function contentIncludesText(content: unknown, text: string): boolean {
  if (typeof content === 'string') return content.includes(text)
  if (Array.isArray(content)) return content.some((part) => contentIncludesText(part, text))
  if (!isRecord(content)) return false

  if (typeof content.text === 'string' && content.text.includes(text)) return true
  if ('content' in content) return contentIncludesText(content.content, text)
  return false
}

export function sdkInputAlreadyContainsInstructions(
  sdkBody: Record<string, unknown>,
  instructions: string,
): boolean {
  const input = sdkBody.input
  if (!Array.isArray(input)) return false

  return input.some((item) => {
    if (!isRecord(item)) return false
    const role = item.role
    if (role !== 'developer' && role !== 'system') return false
    return contentIncludesText(item.content, instructions)
  })
}

function isInputItemAnchor(item: unknown, prefix: string): boolean {
  if (
    !isRecord(item) ||
    item.type !== 'message' ||
    item.role !== 'assistant' ||
    item.phase !== 'commentary'
  ) {
    return false
  }
  if (!Array.isArray(item.content) || item.content.length !== 1) {
    return false
  }

  const content = item.content[0]
  if (!isRecord(content) || content.type !== 'output_text' || typeof content.text !== 'string') {
    return false
  }
  const marker = content.text.slice(prefix.length)
  return (
    content.text.startsWith(prefix) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker)
  )
}

function isAdditionalToolsAnchor(item: unknown): boolean {
  return isInputItemAnchor(item, ADDITIONAL_TOOLS_ANCHOR_PREFIX)
}

function isAgentMessageAnchor(item: unknown): boolean {
  return isInputItemAnchor(item, AGENT_MESSAGE_ANCHOR_PREFIX)
}

function restoreMessageItemType(item: unknown): unknown {
  if (!isRecord(item) || 'type' in item || !('content' in item)) return item
  if (
    item.role !== 'system' &&
    item.role !== 'developer' &&
    item.role !== 'user' &&
    item.role !== 'assistant'
  ) {
    return item
  }
  return { type: 'message', ...item }
}

function restoreMessageItemTypes(body: Record<string, unknown>): Record<string, unknown> {
  const input = body.input
  if (!Array.isArray(input)) return body

  let changed = false
  const restoredInput = input.map((item) => {
    const restored = restoreMessageItemType(item)
    if (restored !== item) changed = true
    return restored
  })
  return changed ? { ...body, input: restoredInput } : body
}

function isEasyInputMessage(item: unknown): item is Record<string, unknown> {
  return (
    isRecord(item) &&
    (item.type === undefined || item.type === 'message') &&
    typeof item.role === 'string' &&
    EASY_INPUT_MESSAGE_ROLES.has(item.role) &&
    'content' in item
  )
}

function isSDKMessage(item: unknown): item is Record<string, unknown> {
  return (
    isRecord(item) &&
    item.type === 'message' &&
    typeof item.role === 'string' &&
    EASY_INPUT_MESSAGE_ROLES.has(item.role) &&
    !isAgentMessageAnchor(item) &&
    !isAdditionalToolsAnchor(item)
  )
}

function isCallOutput(item: unknown): item is Record<string, unknown> {
  return (
    isRecord(item) &&
    (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') &&
    typeof item.call_id === 'string'
  )
}

function getNonEmptyTextFragments(content: unknown): string[] {
  if (typeof content === 'string') return content.trim().length > 0 ? [content] : []
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    if (
      !isRecord(part) ||
      (part.type !== 'input_text' && part.type !== 'output_text' && part.type !== 'text') ||
      typeof part.text !== 'string' ||
      part.text.trim().length === 0
    ) {
      return []
    }
    return [part.text]
  })
}

function areEasyMessageRolesCompatible(rawRole: unknown, sdkRole: unknown): boolean {
  if (rawRole === sdkRole) return true
  return (
    (rawRole === 'system' || rawRole === 'developer') &&
    (sdkRole === 'system' || sdkRole === 'developer')
  )
}

interface IndexedRawInputItem {
  item: Record<string, unknown>
  rawInputIndex: number
}

function takeUnconsumedRawInputIndex(
  indexes: number[] | undefined,
  consumedIndexes: Set<number>,
): number | undefined {
  while (indexes !== undefined && indexes.length > 0) {
    const rawInputIndex = indexes.shift()
    if (rawInputIndex === undefined || consumedIndexes.has(rawInputIndex)) continue
    consumedIndexes.add(rawInputIndex)
    return rawInputIndex
  }
  return undefined
}

function takeUnconsumedRawInputItem(
  items: IndexedRawInputItem[] | undefined,
  consumedIndexes: Set<number>,
): IndexedRawInputItem | undefined {
  while (items !== undefined && items.length > 0) {
    const indexedItem = items.shift()
    if (indexedItem === undefined || consumedIndexes.has(indexedItem.rawInputIndex)) continue
    consumedIndexes.add(indexedItem.rawInputIndex)
    return indexedItem
  }
  return undefined
}

function findMatchingRawEasyMessage(
  rawMessages: IndexedRawInputItem[],
  sdkMessage: Record<string, unknown>,
): number {
  const matchingRoleIndexes = rawMessages.flatMap(({ item }, index) =>
    areEasyMessageRolesCompatible(item.role, sdkMessage.role) ? [index] : [],
  )
  const contentMatch = matchingRoleIndexes.find((index) => {
    const fragments = getNonEmptyTextFragments(rawMessages[index]?.item.content)
    return (
      fragments.length > 0 &&
      fragments.every((fragment) => contentIncludesText(sdkMessage.content, fragment))
    )
  })
  return contentMatch ?? matchingRoleIndexes[0] ?? -1
}

function shouldRestoreUnmatchedEasyMessage(message: Record<string, unknown>): boolean {
  if (message.role !== 'system' && message.role !== 'developer' && message.role !== 'assistant') {
    return false
  }
  return (
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    getNonEmptyTextFragments(message.content).length === 0
  )
}

function getToolSearchItemIdentity(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined
  if (typeof item.call_id === 'string') return item.call_id
  return typeof item.id === 'string' ? item.id : undefined
}

// 当前 mapper 仅为这两类保留足够 identity，供 SDK 在 store=true 时改写为 item_reference。
function getRawItemReferenceId(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined
  if (item.type === 'compaction') return typeof item.id === 'string' ? item.id : undefined
  if (item.type === 'tool_search_output') return getToolSearchItemIdentity(item)
  return undefined
}

function getStableInputItemKey(item: unknown): string | undefined {
  if (!isRecord(item) || typeof item.type !== 'string') return undefined
  if (
    item.type === 'message' ||
    item.type === 'agent_message' ||
    item.type === 'additional_tools' ||
    item.type === 'function_call_output' ||
    item.type === 'custom_tool_call_output' ||
    // The mapper does not carry reasoning.id through the AI SDK request path.
    item.type === 'reasoning'
  ) {
    return undefined
  }

  if (item.type === 'tool_search_call' || item.type === 'tool_search_output') {
    const identity = getToolSearchItemIdentity(item)
    return identity === undefined ? undefined : `${item.type}:identity:${identity}`
  }

  if (typeof item.call_id === 'string') return `${item.type}:call_id:${item.call_id}`
  if (typeof item.id === 'string') return `${item.type}:id:${item.id}`
  return undefined
}

function mergeInstructionsWithRawContent(
  sdkContent: unknown,
  rawContent: unknown,
  instructions: string,
): unknown {
  if (!Array.isArray(rawContent)) return sdkContent
  return [{ type: 'input_text', text: instructions }, ...rawContent]
}

function restoreFilteredEasyMessage(
  sdkMessage: Record<string, unknown>,
  rawMessage: Record<string, unknown>,
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedRawMessage = restoreMessageItemType(rawMessage) as Record<string, unknown>
  const instructions = rawBody.instructions
  const keepSDKContent =
    (sdkMessage.role === 'developer' || sdkMessage.role === 'system') &&
    typeof instructions === 'string' &&
    instructions.length > 0 &&
    contentIncludesText(sdkMessage.content, instructions) &&
    !contentIncludesText(rawMessage.content, instructions)

  return {
    ...sdkMessage,
    ...normalizedRawMessage,
    content: keepSDKContent
      ? mergeInstructionsWithRawContent(sdkMessage.content, rawMessage.content, instructions)
      : normalizedRawMessage.content,
  }
}

function patchFilteredRawInputItems(
  sdkBody: Record<string, unknown>,
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  const sdkInput = sdkBody.input
  const rawInput = rawBody.input
  if (!Array.isArray(sdkInput) || !Array.isArray(rawInput)) return sdkBody

  const rawEasyMessages: IndexedRawInputItem[] = []
  const rawCallOutputs = new Map<string, IndexedRawInputItem[]>()
  const rawToolSearchOutputIndexes = new Map<string, number[]>()
  const rawItemReferenceIndexes = new Map<string, number[]>()
  const rawAgentMessageIndexes: number[] = []
  const rawAdditionalToolsIndexes: number[] = []
  const rawStableItemIndexes = new Map<string, number[]>()
  const rawUnkeyedItemIndexes = new Map<string, number[]>()
  for (let rawInputIndex = 0; rawInputIndex < rawInput.length; rawInputIndex++) {
    const item = rawInput[rawInputIndex]
    if (isEasyInputMessage(item)) rawEasyMessages.push({ item, rawInputIndex })
    if (isRecord(item) && item.type === 'agent_message') {
      rawAgentMessageIndexes.push(rawInputIndex)
    }
    if (isRecord(item) && item.type === 'additional_tools') {
      rawAdditionalToolsIndexes.push(rawInputIndex)
    }
    if (isRecord(item) && item.type === 'tool_search_output') {
      const toolSearchId = getToolSearchItemIdentity(item)
      if (toolSearchId !== undefined) {
        const queuedIndexes = rawToolSearchOutputIndexes.get(toolSearchId)
        if (queuedIndexes === undefined) {
          rawToolSearchOutputIndexes.set(toolSearchId, [rawInputIndex])
        } else {
          queuedIndexes.push(rawInputIndex)
        }
      }
    }
    const itemReferenceId = getRawItemReferenceId(item)
    if (itemReferenceId !== undefined) {
      const queuedIndexes = rawItemReferenceIndexes.get(itemReferenceId)
      if (queuedIndexes === undefined) {
        rawItemReferenceIndexes.set(itemReferenceId, [rawInputIndex])
      } else {
        queuedIndexes.push(rawInputIndex)
      }
    }
    const stableKey = getStableInputItemKey(item)
    const itemType = isRecord(item) && typeof item.type === 'string' ? item.type : undefined
    if (stableKey !== undefined) {
      const queuedIndexes = rawStableItemIndexes.get(stableKey)
      if (queuedIndexes === undefined) rawStableItemIndexes.set(stableKey, [rawInputIndex])
      else queuedIndexes.push(rawInputIndex)
    } else if (
      itemType !== undefined &&
      itemType !== 'message' &&
      itemType !== 'agent_message' &&
      itemType !== 'additional_tools' &&
      !isCallOutput(item)
    ) {
      const queuedIndexes = rawUnkeyedItemIndexes.get(itemType)
      if (queuedIndexes === undefined) rawUnkeyedItemIndexes.set(itemType, [rawInputIndex])
      else queuedIndexes.push(rawInputIndex)
    }
    if (!isCallOutput(item)) continue
    const key = `${item.type}:${item.call_id}`
    const queued = rawCallOutputs.get(key)
    const indexedItem = { item, rawInputIndex }
    if (queued === undefined) rawCallOutputs.set(key, [indexedItem])
    else queued.push(indexedItem)
  }

  const remainingEasyMessages = [...rawEasyMessages]
  const hasNativeAgentMessages = sdkInput.some(
    (item) => isRecord(item) && item.type === 'agent_message',
  )
  const hasNativeAdditionalTools = sdkInput.some(
    (item) => isRecord(item) && item.type === 'additional_tools',
  )
  const consumedRawInputIndexes = new Set<number>()
  let changed = false
  const locatedInput = sdkInput.map((item): { item: unknown; rawInputIndex?: number } => {
    if (isAgentMessageAnchor(item)) {
      if (hasNativeAgentMessages) return { item }
      const rawInputIndex = rawAgentMessageIndexes.shift()
      return rawInputIndex === undefined ? { item } : { item, rawInputIndex }
    }
    if (isRecord(item) && item.type === 'agent_message') {
      const rawInputIndex = rawAgentMessageIndexes.shift()
      return rawInputIndex === undefined ? { item } : { item, rawInputIndex }
    }
    if (isAdditionalToolsAnchor(item)) {
      if (hasNativeAdditionalTools) return { item }
      const rawInputIndex = rawAdditionalToolsIndexes.shift()
      return rawInputIndex === undefined ? { item } : { item, rawInputIndex }
    }
    if (isRecord(item) && item.type === 'additional_tools') {
      const rawInputIndex = rawAdditionalToolsIndexes.shift()
      return rawInputIndex === undefined ? { item } : { item, rawInputIndex }
    }
    if (isCallOutput(item)) {
      const key = `${item.type}:${item.call_id}`
      const queued = rawCallOutputs.get(key)
      const indexedRawItem = takeUnconsumedRawInputItem(queued, consumedRawInputIndexes)
      if (indexedRawItem !== undefined) {
        changed = true
        return indexedRawItem
      }
      if (item.type === 'function_call_output') {
        const callId = item.call_id
        if (typeof callId === 'string') {
          const rawInputIndex = takeUnconsumedRawInputIndex(
            rawToolSearchOutputIndexes.get(callId),
            consumedRawInputIndexes,
          )
          if (rawInputIndex !== undefined) return { item, rawInputIndex }
        }
      }
    }

    if (!isSDKMessage(item)) {
      const stableKey = getStableInputItemKey(item)
      const rawInputIndex =
        (isRecord(item) && item.type === 'item_reference' && typeof item.id === 'string'
          ? takeUnconsumedRawInputIndex(
              rawItemReferenceIndexes.get(item.id),
              consumedRawInputIndexes,
            )
          : undefined) ??
        (stableKey === undefined
          ? undefined
          : takeUnconsumedRawInputIndex(
              rawStableItemIndexes.get(stableKey),
              consumedRawInputIndexes,
            )) ??
        (isRecord(item) && typeof item.type === 'string'
          ? takeUnconsumedRawInputIndex(
              rawUnkeyedItemIndexes.get(item.type),
              consumedRawInputIndexes,
            )
          : undefined)
      return rawInputIndex === undefined ? { item } : { item, rawInputIndex }
    }
    const rawIndex = findMatchingRawEasyMessage(remainingEasyMessages, item)
    if (rawIndex < 0) return { item }
    const [indexedRawMessage] = remainingEasyMessages.splice(rawIndex, 1)
    changed = true
    return {
      item: restoreFilteredEasyMessage(item, indexedRawMessage!.item, rawBody),
      rawInputIndex: indexedRawMessage!.rawInputIndex,
    }
  })

  for (const indexedRawMessage of remainingEasyMessages) {
    if (!shouldRestoreUnmatchedEasyMessage(indexedRawMessage.item)) continue

    const insertAt = locatedInput.findIndex(
      (located) =>
        located.rawInputIndex !== undefined &&
        located.rawInputIndex > indexedRawMessage.rawInputIndex,
    )
    const restored = {
      item: restoreMessageItemType(indexedRawMessage.item),
      rawInputIndex: indexedRawMessage.rawInputIndex,
    }
    if (insertAt < 0) locatedInput.push(restored)
    else locatedInput.splice(insertAt, 0, restored)
    changed = true
  }

  return changed ? { ...sdkBody, input: locatedInput.map(({ item }) => item) } : sdkBody
}

function patchAgentMessagesInput(
  sdkBody: Record<string, unknown>,
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  const rawInput = rawBody.input
  if (!Array.isArray(rawInput)) return sdkBody

  const rawAgentMessages = rawInput.filter(
    (item): item is Record<string, unknown> => isRecord(item) && item.type === 'agent_message',
  )
  if (rawAgentMessages.length === 0) return sdkBody

  const sdkInput = sdkBody.input
  if (!Array.isArray(sdkInput)) {
    throw new Error('Cannot align agent_message with non-array SDK input')
  }

  const nativeAgentMessageCount = sdkInput.filter(
    (item) => isRecord(item) && item.type === 'agent_message',
  ).length
  if (nativeAgentMessageCount > 0) {
    if (nativeAgentMessageCount !== rawAgentMessages.length) {
      throw new Error(
        `Cannot align agent_message with SDK input: expected ${rawAgentMessages.length} native items, found ${nativeAgentMessageCount}`,
      )
    }
    let agentMessageIndex = 0
    const patchedInput: unknown[] = []
    for (const item of sdkInput) {
      if (isAgentMessageAnchor(item)) continue
      if (isRecord(item) && item.type === 'agent_message') {
        patchedInput.push(rawAgentMessages[agentMessageIndex++])
        continue
      }
      patchedInput.push(item)
    }
    return { ...sdkBody, input: patchedInput }
  }

  const anchorCount = sdkInput.filter(isAgentMessageAnchor).length
  if (anchorCount !== rawAgentMessages.length) {
    throw new Error(
      `Cannot align agent_message with SDK input: expected ${rawAgentMessages.length} anchors, found ${anchorCount}`,
    )
  }

  let agentMessageIndex = 0
  return {
    ...sdkBody,
    input: sdkInput.map((item) =>
      isAgentMessageAnchor(item) ? rawAgentMessages[agentMessageIndex++] : item,
    ),
  }
}

function patchAdditionalToolsInput(
  sdkBody: Record<string, unknown>,
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  const rawInput = rawBody.input
  if (!Array.isArray(rawInput)) return sdkBody
  if (!rawInput.some((item) => isRecord(item) && item.type === 'additional_tools')) {
    return sdkBody
  }

  const sdkInput = sdkBody.input
  if (!Array.isArray(sdkInput)) {
    throw new Error('Cannot align additional_tools with non-array SDK input')
  }
  if (sdkInput.some((item) => isRecord(item) && item.type === 'additional_tools')) {
    if (!sdkInput.some(isAdditionalToolsAnchor)) return sdkBody
    return { ...sdkBody, input: sdkInput.filter((item) => !isAdditionalToolsAnchor(item)) }
  }

  const rawAdditionalTools = rawInput.filter(
    (item): item is Record<string, unknown> => isRecord(item) && item.type === 'additional_tools',
  )
  const anchorCount = sdkInput.filter(isAdditionalToolsAnchor).length
  let patchedInput: unknown[]
  if (anchorCount > 0) {
    if (anchorCount !== rawAdditionalTools.length) {
      throw new Error('Cannot align additional_tools with SDK input: anchor count mismatch')
    }
    let additionalIndex = 0
    patchedInput = sdkInput.map((item) =>
      isAdditionalToolsAnchor(item) ? rawAdditionalTools[additionalIndex++] : item,
    )
  } else {
    patchedInput = []
    let sdkIndex = 0
    for (const rawItem of rawInput) {
      if (isRecord(rawItem) && rawItem.type === 'additional_tools') {
        patchedInput.push(rawItem)
        continue
      }
      if (isRecord(rawItem) && rawItem.type === 'web_search_call') continue
      if (sdkIndex >= sdkInput.length) {
        throw new Error('Cannot align additional_tools with SDK input: missing SDK item')
      }
      patchedInput.push(sdkInput[sdkIndex])
      sdkIndex += 1
    }
    if (sdkIndex !== sdkInput.length) {
      throw new Error('Cannot align additional_tools with SDK input: unused SDK items')
    }
  }

  const patched: Record<string, unknown> = {
    ...sdkBody,
    input: patchedInput,
  }
  if (Array.isArray(rawBody.tools)) patched.tools = rawBody.tools
  else delete patched.tools
  return patched
}

export function patchOpenAIResponsesPassthroughInput(
  sdkBody: Record<string, unknown>,
  rawBody: Record<string, unknown>,
  restoreFilteredInputItems: boolean,
): Record<string, unknown> {
  const restoredMessages = restoreMessageItemTypes(sdkBody)
  const restoredFilteredItems = restoreFilteredInputItems
    ? patchFilteredRawInputItems(restoredMessages, rawBody)
    : restoredMessages
  const patchedAgentMessages = patchAgentMessagesInput(restoredFilteredItems, rawBody)
  return patchAdditionalToolsInput(patchedAgentMessages, rawBody)
}

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import type { VisionToolResultArtifactsConfig } from '../config.js'
import type {
  VisionArtifactUnavailableReason,
  VisionToolResultImageCandidate,
  VisionToolResultReplacement,
} from '../providers/shared/strategy.js'

const MIME_TYPES = {
  'image/png': { extension: 'png', magic: isPng },
  'image/jpeg': { extension: 'jpg', magic: isJpeg },
  'image/gif': { extension: 'gif', magic: isGif },
  'image/webp': { extension: 'webp', magic: isWebp },
} as const

const FINAL_FILE_PATTERN =
  /^vision-(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|gif|webp)$/
const TEMP_FILE_PATTERN =
  /^vision-tmp-(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/
const TEMP_FILE_TTL_MS = 60 * 60 * 1000
const READ_WRITE_NOFOLLOW = constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)

const NOTICE_PREFIX = '[llm-proxy-ts vision fallback]'
const NOTICE_REASON =
  'The tool returned an image, but the selected model is configured without vision support.'

export type VisionArtifactPersistenceResult =
  | {
      path: string
      status: 'stored'
      artifactId: string
      agentVisiblePath: string
    }
  | {
      path: string
      status: 'unavailable'
      reason: VisionArtifactUnavailableReason
    }

export interface VisionArtifactPersistenceError {
  phase: 'vision_artifact_cleanup' | 'vision_artifact_persist'
  err: unknown
}

export interface VisionArtifactBatchResult {
  results: ReadonlyMap<string, VisionArtifactPersistenceResult>
  errors: VisionArtifactPersistenceError[]
}

interface PreparedArtifact {
  candidate: VisionToolResultImageCandidate
  data: Buffer
  mediaType: keyof typeof MIME_TYPES
  extension: (typeof MIME_TYPES)[keyof typeof MIME_TYPES]['extension']
  digest: string
}

interface DeduplicatedArtifact {
  artifactId: string
  fileName: string
  size: number
}

function isPng(data: Buffer): boolean {
  return (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  )
}

function isJpeg(data: Buffer): boolean {
  return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
}

function isGif(data: Buffer): boolean {
  if (data.length < 6) return false
  const signature = data.subarray(0, 6).toString('ascii')
  return signature === 'GIF87a' || signature === 'GIF89a'
}

function isWebp(data: Buffer): boolean {
  return (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  )
}

function parseInlineSource(
  source: VisionToolResultImageCandidate['source'],
): { mediaType: string; base64: string } | { reason: VisionArtifactUnavailableReason } {
  if (source.type === 'unavailable') return { reason: source.reason }
  if (source.type === 'base64') {
    return { mediaType: source.mediaType, base64: source.data }
  }

  const match = /^data:([^;,]+);base64,([^\r\n]*)$/.exec(source.dataUrl)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return { reason: 'unsupported_source' }
  }
  return { mediaType: match[1], base64: match[2] }
}

function decodeStrictBase64(
  value: string,
  maxBytes: number,
): { data: Buffer } | { reason: 'invalid_base64' | 'image_too_large' } {
  if (value.length === 0) return { reason: 'invalid_base64' }

  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4 + 2
  if (value.length > maxEncodedLength) return { reason: 'image_too_large' }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return { reason: 'invalid_base64' }

  const firstPaddingIndex = value.indexOf('=')
  const unpadded = firstPaddingIndex < 0 ? value : value.slice(0, firstPaddingIndex)
  const suppliedPadding = firstPaddingIndex < 0 ? 0 : value.length - firstPaddingIndex
  const remainder = unpadded.length % 4
  if (remainder === 1) return { reason: 'invalid_base64' }

  const requiredPadding = remainder === 0 ? 0 : 4 - remainder
  if (suppliedPadding !== 0 && suppliedPadding !== requiredPadding) {
    return { reason: 'invalid_base64' }
  }

  const normalized = `${unpadded}${'='.repeat(requiredPadding)}`
  const decodedBytes = (normalized.length / 4) * 3 - requiredPadding
  if (decodedBytes > maxBytes) return { reason: 'image_too_large' }

  const data = Buffer.from(normalized, 'base64')
  if (data.toString('base64') !== normalized) return { reason: 'invalid_base64' }
  return { data }
}

function prepareArtifact(
  candidate: VisionToolResultImageCandidate,
  maxImageBytes: number,
): PreparedArtifact | { reason: VisionArtifactUnavailableReason } {
  const inline = parseInlineSource(candidate.source)
  if ('reason' in inline) return inline

  const mediaType = inline.mediaType.toLowerCase() as keyof typeof MIME_TYPES
  const mediaConfig = MIME_TYPES[mediaType]
  if (mediaConfig === undefined) return { reason: 'unsupported_media_type' }

  const decoded = decodeStrictBase64(inline.base64, maxImageBytes)
  if ('reason' in decoded) return decoded
  if (!mediaConfig.magic(decoded.data)) return { reason: 'invalid_image_data' }

  return {
    candidate,
    data: decoded.data,
    mediaType,
    extension: mediaConfig.extension,
    digest: createHash('sha256').update(decoded.data).digest('hex'),
  }
}

function joinAgentVisiblePath(directory: string, fileName: string): string {
  if (/^[A-Za-z]:[\\/]/.test(directory) || directory.startsWith('\\\\')) {
    return win32.join(directory, fileName)
  }
  return posix.join(directory, fileName)
}

function unavailableResult(
  path: string,
  reason: VisionArtifactUnavailableReason,
): VisionArtifactPersistenceResult {
  return { path, status: 'unavailable', reason }
}

async function verifyArtifactForReuse(
  path: string,
  expectedSize: number,
  expectedDigest: string,
): Promise<{ reusable: boolean; retiredBytes: number }> {
  const entry = await lstat(path, { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink()) return { reusable: false, retiredBytes: 0 }

  const file = await open(path, READ_WRITE_NOFOLLOW)
  try {
    const opened = await file.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino ||
      opened.size !== entry.size
    ) {
      return { reusable: false, retiredBytes: 0 }
    }

    let digestMatches = false
    if (opened.size === BigInt(expectedSize)) {
      const digest = createHash('sha256')
        .update(await file.readFile())
        .digest('hex')
      digestMatches = digest === expectedDigest
    }

    if (digestMatches) {
      const current = await lstat(path, { bigint: true })
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      ) {
        return { reusable: false, retiredBytes: 0 }
      }

      const now = new Date()
      await file.utimes(now, now)
      return { reusable: true, retiredBytes: 0 }
    }

    const directory = dirname(path)
    const quarantinePath = resolve(directory, `vision-tmp-${Date.now()}-${randomUUID()}.tmp`)
    if (dirname(quarantinePath) !== directory) {
      throw new Error('Vision artifact quarantine path escaped the storage directory')
    }

    await rename(path, quarantinePath)
    const quarantined = await lstat(quarantinePath, { bigint: true })
    if (
      !quarantined.isFile() ||
      quarantined.isSymbolicLink() ||
      quarantined.dev !== opened.dev ||
      quarantined.ino !== opened.ino
    ) {
      throw new Error('Vision artifact changed while being retired')
    }
    await unlink(quarantinePath)
    return { reusable: false, retiredBytes: Number(opened.size) }
  } finally {
    await file.close()
  }
}

export function createVisionToolResultReplacement(
  result: VisionArtifactPersistenceResult,
): VisionToolResultReplacement {
  if (result.status === 'stored') {
    const path = JSON.stringify(result.agentVisiblePath)
    return {
      artifactStatus: 'stored',
      artifactId: result.artifactId,
      text:
        `${NOTICE_PREFIX}\n${NOTICE_REASON}\n` +
        `The original image was saved at ${path}. ` +
        'Call one already available image-analysis MCP/tool that can read this path and returns text only. ' +
        'Do not retry the image-producing tool, install or download tools, or return another image. ' +
        'If no suitable tool is available, report that the image cannot be analyzed.',
    }
  }

  return {
    artifactStatus: 'unavailable',
    unavailableReason: result.reason,
    text:
      `${NOTICE_PREFIX}\n${NOTICE_REASON}\n` +
      'No artifact path is available for this image. Check only the already available MCP/tools for a ' +
      'text-only image-analysis capability. Do not retry the image-producing tool, install or download ' +
      'tools, or return another image. If no suitable tool can access the original source, report that ' +
      'the image cannot be analyzed.',
  }
}

export class VisionArtifactStore {
  private queue: Promise<void> = Promise.resolve()
  private readonly deduplicated = new Map<string, DeduplicatedArtifact>()

  constructor(private readonly config?: VisionToolResultArtifactsConfig) {}

  persistBatch(
    candidates: readonly VisionToolResultImageCandidate[],
  ): Promise<VisionArtifactBatchResult> {
    const run = this.queue.then(
      () => this.persistBatchLocked(candidates),
      () => this.persistBatchLocked(candidates),
    )
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run.catch((err: unknown) => ({
      results: new Map(
        candidates.map((candidate) => [
          candidate.path,
          unavailableResult(candidate.path, 'storage_error'),
        ]),
      ),
      errors: [{ phase: 'vision_artifact_persist', err }],
    }))
  }

  private async persistBatchLocked(
    candidates: readonly VisionToolResultImageCandidate[],
  ): Promise<VisionArtifactBatchResult> {
    const results = new Map<string, VisionArtifactPersistenceResult>()
    const errors: VisionArtifactPersistenceError[] = []

    if (candidates.length === 0) return { results, errors }

    const prepared: PreparedArtifact[] = []
    let requestBytes = 0
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex]!
      if (candidate.source.type === 'unavailable') {
        results.set(candidate.path, unavailableResult(candidate.path, candidate.source.reason))
        continue
      }
      if (this.config === undefined) {
        results.set(candidate.path, unavailableResult(candidate.path, 'storage_not_configured'))
        continue
      }

      const artifact = prepareArtifact(candidate, this.config.maxImageBytes)
      if ('reason' in artifact) {
        results.set(candidate.path, unavailableResult(candidate.path, artifact.reason))
      } else {
        requestBytes += artifact.data.byteLength
        if (requestBytes > this.config.maxRequestBytes) {
          for (const preparedArtifact of prepared) {
            results.set(
              preparedArtifact.candidate.path,
              unavailableResult(preparedArtifact.candidate.path, 'request_too_large'),
            )
          }
          results.set(candidate.path, unavailableResult(candidate.path, 'request_too_large'))
          for (
            let remainingIndex = candidateIndex + 1;
            remainingIndex < candidates.length;
            remainingIndex += 1
          ) {
            const remaining = candidates[remainingIndex]!
            const reason =
              remaining.source.type === 'unavailable'
                ? remaining.source.reason
                : 'request_too_large'
            results.set(remaining.path, unavailableResult(remaining.path, reason))
          }
          return { results, errors }
        }
        prepared.push(artifact)
      }
    }

    if (this.config === undefined || prepared.length === 0) return { results, errors }

    const root = resolve(this.config.storageDir)
    try {
      await mkdir(root, { recursive: true, mode: 0o700 })
    } catch (err) {
      for (const artifact of prepared) {
        results.set(
          artifact.candidate.path,
          unavailableResult(artifact.candidate.path, 'storage_error'),
        )
      }
      errors.push({ phase: 'vision_artifact_persist', err })
      return { results, errors }
    }

    let totalBytes: number
    try {
      totalBytes = await this.cleanupAndMeasure(root)
    } catch (err) {
      for (const artifact of prepared) {
        results.set(
          artifact.candidate.path,
          unavailableResult(artifact.candidate.path, 'storage_error'),
        )
      }
      errors.push({ phase: 'vision_artifact_cleanup', err })
      return { results, errors }
    }

    const grouped = new Map<string, PreparedArtifact[]>()
    for (const artifact of prepared) {
      const key = `${artifact.mediaType}:${artifact.digest}`
      const group = grouped.get(key)
      if (group === undefined) grouped.set(key, [artifact])
      else group.push(artifact)
    }

    const pendingGroups: Array<[string, PreparedArtifact[]]> = []
    for (const [key, group] of grouped) {
      const existing = this.deduplicated.get(key)
      if (existing === undefined) {
        pendingGroups.push([key, group])
        continue
      }

      const finalPath = resolve(root, existing.fileName)
      if (dirname(finalPath) !== root) {
        this.deduplicated.delete(key)
        pendingGroups.push([key, group])
        continue
      }
      try {
        const verification = await verifyArtifactForReuse(
          finalPath,
          existing.size,
          group[0]!.digest,
        )
        if (!verification.reusable) {
          totalBytes = Math.max(0, totalBytes - verification.retiredBytes)
          this.deduplicated.delete(key)
          pendingGroups.push([key, group])
          continue
        }
        for (const artifact of group) {
          results.set(artifact.candidate.path, {
            path: artifact.candidate.path,
            status: 'stored',
            artifactId: existing.artifactId,
            agentVisiblePath: joinAgentVisiblePath(this.config.agentVisibleDir, existing.fileName),
          })
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ELOOP') {
          this.deduplicated.delete(key)
          pendingGroups.push([key, group])
        } else {
          for (const artifact of group) {
            results.set(
              artifact.candidate.path,
              unavailableResult(artifact.candidate.path, 'storage_error'),
            )
          }
          errors.push({ phase: 'vision_artifact_persist', err })
        }
      }
    }

    const pendingBytes = pendingGroups.reduce(
      (total, [, group]) => total + group[0]!.data.length,
      0,
    )
    if (totalBytes + pendingBytes > this.config.maxTotalBytes) {
      for (const [, group] of pendingGroups) {
        for (const artifact of group) {
          results.set(
            artifact.candidate.path,
            unavailableResult(artifact.candidate.path, 'storage_quota_exceeded'),
          )
        }
      }
      return { results, errors }
    }

    for (const [key, group] of pendingGroups) {
      const representative = group[0]!
      try {
        const stored = await this.writeArtifact(root, representative)
        this.deduplicated.set(key, {
          artifactId: stored.artifactId,
          fileName: stored.fileName,
          size: representative.data.length,
        })
        totalBytes += representative.data.length
        for (const artifact of group) {
          results.set(artifact.candidate.path, {
            path: artifact.candidate.path,
            status: 'stored',
            artifactId: stored.artifactId,
            agentVisiblePath: joinAgentVisiblePath(this.config.agentVisibleDir, stored.fileName),
          })
        }
      } catch (err) {
        for (const artifact of group) {
          results.set(
            artifact.candidate.path,
            unavailableResult(artifact.candidate.path, 'storage_error'),
          )
        }
        errors.push({ phase: 'vision_artifact_persist', err })
      }
    }

    return { results, errors }
  }

  private async cleanupAndMeasure(root: string): Promise<number> {
    const entries = await readdir(root, { withFileTypes: true })
    const now = Date.now()
    let totalBytes = 0

    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      const finalMatch = FINAL_FILE_PATTERN.exec(entry.name)
      const tempMatch = TEMP_FILE_PATTERN.exec(entry.name)
      if (finalMatch === null && tempMatch === null) continue

      const path = resolve(root, entry.name)
      if (dirname(path) !== root) continue
      const file = await lstat(path)
      if (!file.isFile() || file.isSymbolicLink()) continue

      const expired =
        finalMatch !== null
          ? now - file.mtimeMs >= this.config!.ttlMs
          : now - Number(tempMatch![1]) >= TEMP_FILE_TTL_MS
      if (expired) {
        await unlink(path)
        for (const [key, value] of this.deduplicated) {
          if (value.fileName === entry.name) this.deduplicated.delete(key)
        }
        continue
      }
      if (finalMatch !== null) totalBytes += file.size
    }

    return totalBytes
  }

  private async writeArtifact(
    root: string,
    artifact: PreparedArtifact,
  ): Promise<{ artifactId: string; fileName: string }> {
    const artifactId = randomUUID()
    const timestamp = Date.now()
    const fileName = `vision-${timestamp}-${artifactId}.${artifact.extension}`
    const tempName = `vision-tmp-${timestamp}-${randomUUID()}.tmp`
    const finalPath = resolve(root, fileName)
    const tempPath = resolve(root, tempName)
    if (dirname(finalPath) !== root || dirname(tempPath) !== root) {
      throw new Error('Vision artifact path escaped the configured storage directory')
    }

    try {
      await writeFile(tempPath, artifact.data, { flag: 'wx', mode: 0o600 })
      await rename(tempPath, finalPath)
    } finally {
      try {
        await unlink(tempPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }

    return { artifactId, fileName }
  }
}

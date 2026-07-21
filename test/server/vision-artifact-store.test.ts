import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VisionToolResultArtifactsConfig } from '../../src/config.js'
import type { VisionToolResultImageCandidate } from '../../src/providers/shared/strategy.js'
import {
  createVisionToolResultReplacement,
  VisionArtifactStore,
  type VisionArtifactBatchResult,
  type VisionArtifactPersistenceResult,
} from '../../src/server/vision-artifact-store.js'

const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02])
const PNG_C = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03])

function base64Candidate(
  path: string,
  data: Buffer = PNG_A,
  mediaType = 'image/png',
): VisionToolResultImageCandidate {
  return {
    path,
    source: { type: 'base64', mediaType, data: data.toString('base64') },
  }
}

function dataUrlCandidate(path: string, data: Buffer = PNG_A): VisionToolResultImageCandidate {
  return {
    path,
    source: { type: 'data_url', dataUrl: `data:image/png;base64,${data.toString('base64')}` },
  }
}

function getResult(
  batch: VisionArtifactBatchResult,
  path: string,
): VisionArtifactPersistenceResult {
  const result = batch.results.get(path)
  if (result === undefined) throw new Error(`Missing persistence result for ${path}`)
  return result
}

describe('VisionArtifactStore', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-vision-artifacts-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  function config(
    overrides: Partial<VisionToolResultArtifactsConfig> = {},
  ): VisionToolResultArtifactsConfig {
    return {
      storageDir: join(tempDir, 'artifacts'),
      agentVisibleDir: '/agent-visible/vision',
      ttlMs: 60 * 60 * 1000,
      maxImageBytes: 1024,
      maxRequestBytes: 2048,
      maxTotalBytes: 4096,
      ...overrides,
    }
  }

  it('defaults to notice-only when artifact storage is not configured', async () => {
    const batch = await new VisionArtifactStore().persistBatch([base64Candidate('/tool/image')])
    const result = getResult(batch, '/tool/image')

    expect(result).toEqual({
      path: '/tool/image',
      status: 'unavailable',
      reason: 'storage_not_configured',
    })
    expect(batch.errors).toEqual([])

    const replacement = createVisionToolResultReplacement(result)
    expect(replacement).toMatchObject({
      artifactStatus: 'unavailable',
      unavailableReason: 'storage_not_configured',
    })
    expect(replacement.text).toContain('[llm-proxy-ts vision fallback]')
    expect(replacement.text).toContain('No artifact path is available')
    expect(replacement.text).toContain('text-only image-analysis capability')
    expect(replacement.text).not.toContain(PNG_A.toString('base64'))
  })

  it('preserves typed remote URL and file-id unavailability without touching storage', async () => {
    const store = new VisionArtifactStore(config())
    const candidates: VisionToolResultImageCandidate[] = [
      { path: '/remote', source: { type: 'unavailable', reason: 'remote_url' } },
      { path: '/file-id', source: { type: 'unavailable', reason: 'file_id' } },
    ]

    const batch = await store.persistBatch(candidates)

    expect(getResult(batch, '/remote')).toEqual({
      path: '/remote',
      status: 'unavailable',
      reason: 'remote_url',
    })
    expect(getResult(batch, '/file-id')).toEqual({
      path: '/file-id',
      status: 'unavailable',
      reason: 'file_id',
    })
    expect(batch.errors).toEqual([])
    expect(await readdir(tempDir)).toEqual([])
  })

  it('atomically persists valid PNG base64 and data URLs with agent-visible paths', async () => {
    const options = config()
    const batch = await new VisionArtifactStore(options).persistBatch([
      base64Candidate('/base64', PNG_A),
      dataUrlCandidate('/data-url', PNG_B),
    ])

    const base64Result = getResult(batch, '/base64')
    const dataUrlResult = getResult(batch, '/data-url')
    expect(base64Result.status).toBe('stored')
    expect(dataUrlResult.status).toBe('stored')
    if (base64Result.status !== 'stored' || dataUrlResult.status !== 'stored') {
      throw new Error('Expected both artifacts to be stored')
    }

    const base64File = basename(base64Result.agentVisiblePath)
    const dataUrlFile = basename(dataUrlResult.agentVisiblePath)
    expect(base64File).toMatch(/^vision-\d{13}-[0-9a-f-]{36}\.png$/)
    expect(dataUrlFile).toMatch(/^vision-\d{13}-[0-9a-f-]{36}\.png$/)
    expect(base64Result.agentVisiblePath).toBe(`/agent-visible/vision/${base64File}`)
    expect(dataUrlResult.agentVisiblePath).toBe(`/agent-visible/vision/${dataUrlFile}`)
    expect(await readFile(join(options.storageDir, base64File))).toEqual(PNG_A)
    expect(await readFile(join(options.storageDir, dataUrlFile))).toEqual(PNG_B)
    expect((await readdir(options.storageDir)).sort()).toEqual([base64File, dataUrlFile].sort())
    expect(batch.errors).toEqual([])

    const replacement = createVisionToolResultReplacement(base64Result)
    expect(replacement).toMatchObject({
      artifactStatus: 'stored',
      artifactId: base64Result.artifactId,
    })
    expect(replacement.text).toContain(JSON.stringify(base64Result.agentVisiblePath))
    expect(replacement.text).toContain('returns text only')
  })

  it.each([
    ['illegal characters', '%%%'],
    ['impossible length', 'A'],
    ['incorrect padding', 'TQ='],
    ['excess padding', 'TQ==='],
  ])('strictly rejects invalid base64 with %s', async (_label, data) => {
    const candidate: VisionToolResultImageCandidate = {
      path: '/invalid',
      source: { type: 'base64', mediaType: 'image/png', data },
    }

    const batch = await new VisionArtifactStore(config()).persistBatch([candidate])

    expect(getResult(batch, '/invalid')).toEqual({
      path: '/invalid',
      status: 'unavailable',
      reason: 'invalid_base64',
    })
    expect(batch.errors).toEqual([])
  })

  it('rejects MIME magic mismatches and unsupported media types before writing', async () => {
    const options = config()
    const batch = await new VisionArtifactStore(options).persistBatch([
      base64Candidate('/bad-magic', Buffer.from('not a PNG')),
      base64Candidate('/unsupported-mime', PNG_A, 'image/svg+xml'),
    ])

    expect(getResult(batch, '/bad-magic')).toEqual({
      path: '/bad-magic',
      status: 'unavailable',
      reason: 'invalid_image_data',
    })
    expect(getResult(batch, '/unsupported-mime')).toEqual({
      path: '/unsupported-mime',
      status: 'unavailable',
      reason: 'unsupported_media_type',
    })
    expect(batch.errors).toEqual([])
    expect(await readdir(tempDir)).toEqual([])
  })

  it('enforces the per-image byte limit', async () => {
    const batch = await new VisionArtifactStore(
      config({ maxImageBytes: PNG_A.length - 1 }),
    ).persistBatch([base64Candidate('/too-large')])

    expect(getResult(batch, '/too-large')).toEqual({
      path: '/too-large',
      status: 'unavailable',
      reason: 'image_too_large',
    })
    expect(batch.errors).toEqual([])
  })

  it('rejects all otherwise valid artifacts when the request byte limit is exceeded', async () => {
    const store = new VisionArtifactStore(
      config({
        maxImageBytes: PNG_A.length,
        maxRequestBytes: PNG_A.length + PNG_B.length - 1,
      }),
    )

    const batch = await store.persistBatch([
      base64Candidate('/first', PNG_A),
      base64Candidate('/second', PNG_B),
    ])

    expect(getResult(batch, '/first')).toMatchObject({
      status: 'unavailable',
      reason: 'request_too_large',
    })
    expect(getResult(batch, '/second')).toMatchObject({
      status: 'unavailable',
      reason: 'request_too_large',
    })
    expect(batch.errors).toEqual([])
    expect(await readdir(tempDir)).toEqual([])
  })

  it('stops decoding later images as soon as the request byte limit is exceeded', async () => {
    let deferredDataReads = 0
    const deferredCandidate: VisionToolResultImageCandidate = {
      path: '/not-decoded',
      source: {
        type: 'base64',
        mediaType: 'image/png',
        get data() {
          deferredDataReads += 1
          return PNG_C.toString('base64')
        },
      },
    }
    const store = new VisionArtifactStore(
      config({
        maxImageBytes: PNG_A.length,
        maxRequestBytes: PNG_A.length + PNG_B.length - 1,
      }),
    )

    const batch = await store.persistBatch([
      base64Candidate('/first', PNG_A),
      base64Candidate('/limit-crossing', PNG_B),
      deferredCandidate,
      { path: '/remote', source: { type: 'unavailable', reason: 'remote_url' } },
    ])

    expect(deferredDataReads).toBe(0)
    expect(getResult(batch, '/first')).toMatchObject({
      status: 'unavailable',
      reason: 'request_too_large',
    })
    expect(getResult(batch, '/limit-crossing')).toMatchObject({
      status: 'unavailable',
      reason: 'request_too_large',
    })
    expect(getResult(batch, '/not-decoded')).toMatchObject({
      status: 'unavailable',
      reason: 'request_too_large',
    })
    expect(getResult(batch, '/remote')).toEqual({
      path: '/remote',
      status: 'unavailable',
      reason: 'remote_url',
    })
    expect(batch.errors).toEqual([])
  })

  it('counts existing owned artifacts against the total storage quota', async () => {
    const options = config({
      maxImageBytes: PNG_A.length,
      maxRequestBytes: PNG_A.length,
      maxTotalBytes: PNG_A.length,
    })
    const store = new VisionArtifactStore(options)

    const first = await store.persistBatch([base64Candidate('/first', PNG_A)])
    const second = await store.persistBatch([base64Candidate('/second', PNG_B)])

    expect(getResult(first, '/first').status).toBe('stored')
    expect(getResult(second, '/second')).toEqual({
      path: '/second',
      status: 'unavailable',
      reason: 'storage_quota_exceeded',
    })
    expect(second.errors).toEqual([])
    expect(await readdir(options.storageDir)).toHaveLength(1)
  })

  it('expires only store-owned files and leaves unrelated old files untouched', async () => {
    const options = config({ ttlMs: 1000 })
    await mkdir(options.storageDir, { recursive: true })

    const now = Date.now()
    const expiredFinal = `vision-${now - 5000}-00000000-0000-4000-8000-000000000000.png`
    const expiredTemp = `vision-tmp-${now - 2 * 60 * 60 * 1000}-00000000-0000-4000-8000-000000000001.tmp`
    const unrelated = 'customer-image.png'
    const similarButUnowned = `vision-${now - 5000}-NOT-OWNED.png`
    await Promise.all([
      writeFile(join(options.storageDir, expiredFinal), PNG_A),
      writeFile(join(options.storageDir, expiredTemp), PNG_A),
      writeFile(join(options.storageDir, unrelated), PNG_A),
      writeFile(join(options.storageDir, similarButUnowned), PNG_A),
    ])
    const old = new Date(now - 5000)
    await Promise.all([
      utimes(join(options.storageDir, expiredFinal), old, old),
      utimes(join(options.storageDir, unrelated), old, old),
      utimes(join(options.storageDir, similarButUnowned), old, old),
    ])

    const batch = await new VisionArtifactStore(options).persistBatch([
      base64Candidate('/new', PNG_C),
    ])
    const names = await readdir(options.storageDir)

    expect(getResult(batch, '/new').status).toBe('stored')
    expect(names).not.toContain(expiredFinal)
    expect(names).not.toContain(expiredTemp)
    expect(names).toContain(unrelated)
    expect(names).toContain(similarButUnowned)
  })

  it('deduplicates identical bytes in-process and refreshes the artifact mtime', async () => {
    const options = config()
    const store = new VisionArtifactStore(options)
    const firstBatch = await store.persistBatch([
      base64Candidate('/first', PNG_A),
      dataUrlCandidate('/duplicate', PNG_A),
    ])
    const first = getResult(firstBatch, '/first')
    const duplicate = getResult(firstBatch, '/duplicate')
    expect(first.status).toBe('stored')
    expect(duplicate.status).toBe('stored')
    if (first.status !== 'stored' || duplicate.status !== 'stored') {
      throw new Error('Expected duplicate artifacts to be stored')
    }
    expect(duplicate.artifactId).toBe(first.artifactId)
    expect(duplicate.agentVisiblePath).toBe(first.agentVisiblePath)

    const fileName = basename(first.agentVisiblePath)
    const artifactPath = join(options.storageDir, fileName)
    const old = new Date(Date.now() - 5 * 60 * 1000)
    await utimes(artifactPath, old, old)

    const secondBatch = await store.persistBatch([base64Candidate('/later', PNG_A)])
    const later = getResult(secondBatch, '/later')
    expect(later.status).toBe('stored')
    if (later.status !== 'stored') throw new Error('Expected duplicate artifact to be reused')
    expect(later.artifactId).toBe(first.artifactId)
    expect(later.agentVisiblePath).toBe(first.agentVisiblePath)
    expect((await stat(artifactPath)).mtimeMs).toBeGreaterThan(old.getTime())
    expect(await readdir(options.storageDir)).toEqual([fileName])
  })

  it('does not reuse a deduplicated artifact whose bytes changed without changing size', async () => {
    expect(PNG_B).toHaveLength(PNG_A.length)
    const options = config()
    const store = new VisionArtifactStore(options)
    const firstBatch = await store.persistBatch([base64Candidate('/first', PNG_A)])
    const first = getResult(firstBatch, '/first')
    expect(first.status).toBe('stored')
    if (first.status !== 'stored') throw new Error('Expected the first artifact to be stored')

    const firstFileName = basename(first.agentVisiblePath)
    await writeFile(join(options.storageDir, firstFileName), PNG_B)

    const secondBatch = await store.persistBatch([base64Candidate('/second', PNG_A)])
    const second = getResult(secondBatch, '/second')
    expect(second.status).toBe('stored')
    if (second.status !== 'stored')
      throw new Error('Expected the replacement artifact to be stored')

    expect(second.artifactId).not.toBe(first.artifactId)
    expect(second.agentVisiblePath).not.toBe(first.agentVisiblePath)
    expect(await readFile(join(options.storageDir, basename(second.agentVisiblePath)))).toEqual(
      PNG_A,
    )
    expect(secondBatch.errors).toEqual([])
  })

  it('retires a tampered managed artifact before applying the total storage quota', async () => {
    const options = config({
      maxImageBytes: PNG_A.length,
      maxRequestBytes: PNG_A.length,
      maxTotalBytes: PNG_A.length,
    })
    const store = new VisionArtifactStore(options)
    const firstBatch = await store.persistBatch([base64Candidate('/first', PNG_A)])
    const first = getResult(firstBatch, '/first')
    expect(first.status).toBe('stored')
    if (first.status !== 'stored') throw new Error('Expected the first artifact to be stored')

    await writeFile(join(options.storageDir, basename(first.agentVisiblePath)), PNG_B)

    const secondBatch = await store.persistBatch([base64Candidate('/second', PNG_A)])
    const second = getResult(secondBatch, '/second')
    expect(second.status).toBe('stored')
    if (second.status !== 'stored')
      throw new Error('Expected the replacement artifact to be stored')

    expect(second.artifactId).not.toBe(first.artifactId)
    expect(await readdir(options.storageDir)).toEqual([basename(second.agentVisiblePath)])
    expect(await readFile(join(options.storageDir, basename(second.agentVisiblePath)))).toEqual(
      PNG_A,
    )
    expect(secondBatch.errors).toEqual([])
  })

  it('serializes concurrent requests so the total quota cannot be oversubscribed', async () => {
    const options = config({
      maxImageBytes: PNG_A.length,
      maxRequestBytes: PNG_A.length,
      maxTotalBytes: PNG_A.length,
    })
    const store = new VisionArtifactStore(options)

    const [first, second] = await Promise.all([
      store.persistBatch([base64Candidate('/first', PNG_A)]),
      store.persistBatch([base64Candidate('/second', PNG_B)]),
    ])

    expect(getResult(first, '/first').status).toBe('stored')
    expect(getResult(second, '/second')).toEqual({
      path: '/second',
      status: 'unavailable',
      reason: 'storage_quota_exceeded',
    })
    expect(first.errors).toEqual([])
    expect(second.errors).toEqual([])
    expect(await readdir(options.storageDir)).toHaveLength(1)
  })

  it('returns the complete I/O error instead of rejecting the persistence call', async () => {
    const blockedStoragePath = join(tempDir, 'storage-is-a-file')
    await writeFile(blockedStoragePath, 'not a directory')
    const store = new VisionArtifactStore(config({ storageDir: blockedStoragePath }))

    const batch = await store.persistBatch([base64Candidate('/image')])

    expect(getResult(batch, '/image')).toEqual({
      path: '/image',
      status: 'unavailable',
      reason: 'storage_error',
    })
    expect(batch.errors).toHaveLength(1)
    expect(batch.errors[0]?.phase).toBe('vision_artifact_persist')
    expect(batch.errors[0]?.err).toBeInstanceOf(Error)
    const error = batch.errors[0]?.err as Error
    expect(error.message).not.toBe('')
    expect(error.stack).toContain(error.message)
  })
})

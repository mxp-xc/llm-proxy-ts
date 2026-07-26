import { modify, applyEdits } from 'jsonc-parser'
import type { BigIntStats } from 'node:fs'
import {
  chmod,
  chown,
  link,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import type { ModelRouteInput } from '../../config.js'

export interface WriteModelsOptions {
  settingsPath: string
  rawText: string
  providerName: string
  newModels: Record<string, ModelRouteInput>
}

export function computeModelsEdits(
  rawText: string,
  providerName: string,
  newModels: Record<string, ModelRouteInput>,
): string {
  const edits = modify(rawText, ['providers', providerName, 'models'], newModels, {
    formattingOptions: {
      tabSize: 2,
      insertSpaces: true,
    },
  })
  return applyEdits(rawText, edits)
}

export function applyMultipleProviderModels(
  rawText: string,
  changes: Array<{ providerName: string; newModels: Record<string, ModelRouteInput> }>,
): string {
  let current = rawText
  for (const { providerName, newModels } of changes) {
    current = computeModelsEdits(current, providerName, newModels)
  }
  return current
}

const SETTINGS_CHANGED_ERROR = 'settings file changed since it was loaded; refusing to overwrite'

interface SettingsLock {
  path: string
  handle: FileHandle
}

interface SettingsLockMetadata {
  pid: number
  createdAt: string
}

interface SettingsLockSnapshot {
  stats: BigIntStats
  text: string
  metadata: SettingsLockMetadata
}

const MAX_POSIX_PID = 2_147_483_647

function isErrorWithCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code
}

function isUnchangedFile(snapshot: BigIntStats, current: BigIntStats): boolean {
  return (
    snapshot.ino !== 0n &&
    current.ino !== 0n &&
    snapshot.dev === current.dev &&
    snapshot.ino === current.ino &&
    snapshot.mode === current.mode &&
    snapshot.uid === current.uid &&
    snapshot.gid === current.gid &&
    snapshot.size === current.size &&
    snapshot.mtimeNs === current.mtimeNs &&
    snapshot.ctimeNs === current.ctimeNs
  )
}

function lockConflict(lockPath: string, reason: string, cause?: unknown): Error {
  const message = `another settings update is already in progress at ${lockPath}; ${reason}`
  return cause === undefined ? new Error(message) : new Error(message, { cause })
}

function parseSettingsLockMetadata(lockPath: string, text: string): SettingsLockMetadata {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw lockConflict(
      lockPath,
      'invalid lock metadata: expected strict JSON; lock was not removed',
      err,
    )
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw lockConflict(lockPath, 'invalid lock metadata: expected an object; lock was not removed')
  }

  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('pid') || !keys.includes('createdAt')) {
    throw lockConflict(
      lockPath,
      'invalid lock metadata: expected only pid and createdAt; lock was not removed',
    )
  }

  const metadata = value as Record<string, unknown>
  if (
    typeof metadata.pid !== 'number' ||
    !Number.isSafeInteger(metadata.pid) ||
    metadata.pid <= 0 ||
    metadata.pid > MAX_POSIX_PID
  ) {
    throw lockConflict(
      lockPath,
      'invalid lock metadata: pid must be a positive process identifier; lock was not removed',
    )
  }

  if (typeof metadata.createdAt !== 'string') {
    throw lockConflict(
      lockPath,
      'invalid lock metadata: createdAt must be an ISO timestamp; lock was not removed',
    )
  }
  const createdAtMillis = Date.parse(metadata.createdAt)
  if (
    !Number.isFinite(createdAtMillis) ||
    new Date(createdAtMillis).toISOString() !== metadata.createdAt
  ) {
    throw lockConflict(
      lockPath,
      'invalid lock metadata: createdAt must be a canonical ISO timestamp; lock was not removed',
    )
  }

  return { pid: metadata.pid, createdAt: metadata.createdAt }
}

async function readSettingsLockSnapshot(lockPath: string): Promise<SettingsLockSnapshot> {
  let beforeRead: BigIntStats
  let text: string
  let afterRead: BigIntStats
  try {
    beforeRead = await lstat(lockPath, { bigint: true })
    if (!beforeRead.isFile() || beforeRead.ino === 0n) {
      throw lockConflict(lockPath, 'lock is not an identifiable regular file; lock was not removed')
    }
    text = await readFile(lockPath, 'utf8')
    afterRead = await lstat(lockPath, { bigint: true })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('another settings update')) {
      throw err
    }
    throw lockConflict(lockPath, 'could not inspect lock metadata; lock was not removed', err)
  }

  if (!isUnchangedFile(beforeRead, afterRead)) {
    throw lockConflict(
      lockPath,
      'lock changed while stale lock recovery was checking it; lock was not removed',
    )
  }

  return {
    stats: afterRead,
    text,
    metadata: parseSettingsLockMetadata(lockPath, text),
  }
}

async function removeStaleSettingsLock(lockPath: string): Promise<void> {
  const snapshot = await readSettingsLockSnapshot(lockPath)
  const { pid, createdAt } = snapshot.metadata

  if (pid === process.pid) {
    throw lockConflict(
      lockPath,
      `lock created at ${createdAt} belongs to the current process ${pid}; lock was not removed`,
    )
  }
  if (process.platform === 'win32') {
    throw lockConflict(
      lockPath,
      `cannot reliably probe process ${pid} on Windows; lock created at ${createdAt} was not removed`,
    )
  }

  try {
    process.kill(pid, 0)
  } catch (err) {
    if (isErrorWithCode(err, 'EPERM')) {
      throw lockConflict(
        lockPath,
        `process ${pid} could not be signaled (EPERM) and is treated as active; lock created at ${createdAt} was not removed`,
        err,
      )
    }
    if (!isErrorWithCode(err, 'ESRCH')) {
      throw lockConflict(
        lockPath,
        `process ${pid} could not be reliably probed; lock created at ${createdAt} was not removed`,
        err,
      )
    }

    let beforeRead: BigIntStats
    let currentText: string
    let afterRead: BigIntStats
    try {
      beforeRead = await lstat(lockPath, { bigint: true })
      currentText = await readFile(lockPath, 'utf8')
      afterRead = await lstat(lockPath, { bigint: true })
    } catch (inspectionErr) {
      throw lockConflict(
        lockPath,
        'lock changed while stale lock recovery was checking it; lock was not removed',
        inspectionErr,
      )
    }

    if (
      !isUnchangedFile(snapshot.stats, beforeRead) ||
      !isUnchangedFile(snapshot.stats, afterRead) ||
      currentText !== snapshot.text
    ) {
      throw lockConflict(
        lockPath,
        'lock changed while stale lock recovery was checking it; lock was not removed',
      )
    }

    try {
      await unlink(lockPath)
    } catch (unlinkErr) {
      throw lockConflict(
        lockPath,
        `dead process ${pid} was confirmed, but its lock could not be removed`,
        unlinkErr,
      )
    }
    return
  }

  throw lockConflict(
    lockPath,
    `process ${pid} is still running; lock created at ${createdAt} was not removed`,
  )
}

async function acquireSettingsLock(lockPath: string): Promise<SettingsLock> {
  let handle: FileHandle
  let recoveryAttempted = false
  while (true) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
      break
    } catch (err) {
      if (!isErrorWithCode(err, 'EEXIST')) {
        throw err
      }
      if (recoveryAttempted) {
        throw lockConflict(
          lockPath,
          'lock was acquired by another writer after stale lock recovery; lock was not removed',
          err,
        )
      }
      await removeStaleSettingsLock(lockPath)
      recoveryAttempted = true
    }
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      'utf8',
    )
    return { path: lockPath, handle }
  } catch (err) {
    const cleanupErrors: unknown[] = []
    try {
      await handle.close()
    } catch (cleanupErr) {
      cleanupErrors.push(cleanupErr)
    }
    try {
      await rm(lockPath, { force: true })
    } catch (cleanupErr) {
      cleanupErrors.push(cleanupErr)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [err, ...cleanupErrors],
        'Failed to create settings lock and clean it up',
      )
    }
    throw err
  }
}

export async function writeSettingsFile(
  settingsPath: string,
  modifiedTextOrUpdater: string | ((currentText: string) => string | Promise<string>),
  originalText: string,
): Promise<void> {
  const targetPath = await realpath(settingsPath)
  const directory = dirname(targetPath)
  const filename = basename(targetPath)
  const uniqueName = `${process.pid}.${randomUUID()}`
  const lock = await acquireSettingsLock(join(directory, `.${filename}.lock`))
  const snapshotPath = join(directory, `.${filename}.${uniqueName}.snapshot`)
  const temporaryPath = join(directory, `.${filename}.${uniqueName}.tmp`)
  let operationSucceeded = false
  let operationError: unknown
  const cleanupErrors: unknown[] = []

  try {
    await link(targetPath, snapshotPath)
    const snapshotStats = await stat(snapshotPath, { bigint: true })
    const snapshotText = await readFile(snapshotPath, 'utf8')
    if (snapshotText !== originalText) {
      throw new Error(SETTINGS_CHANGED_ERROR)
    }

    const modifiedText =
      typeof modifiedTextOrUpdater === 'string'
        ? modifiedTextOrUpdater
        : await modifiedTextOrUpdater(snapshotText)
    const temporaryHandle = await open(temporaryPath, 'wx', 0o600)
    let temporaryWriteError: unknown
    let temporaryWriteFailed = false
    try {
      await temporaryHandle.writeFile(modifiedText, 'utf8')
      await temporaryHandle.sync()
    } catch (err) {
      temporaryWriteError = err
      temporaryWriteFailed = true
    }
    try {
      await temporaryHandle.close()
    } catch (closeError) {
      if (temporaryWriteFailed) {
        throw new AggregateError(
          [temporaryWriteError, closeError],
          'Failed to write and close temporary settings file',
        )
      }
      throw closeError
    }
    if (temporaryWriteFailed) {
      throw temporaryWriteError
    }
    if (process.platform !== 'win32') {
      await chown(temporaryPath, Number(snapshotStats.uid), Number(snapshotStats.gid))
    }
    await chmod(temporaryPath, Number(snapshotStats.mode & 0o7777n))

    if ((await readFile(snapshotPath, 'utf8')) !== originalText) {
      throw new Error(SETTINGS_CHANGED_ERROR)
    }

    let currentStats: BigIntStats
    try {
      currentStats = await stat(targetPath, { bigint: true })
    } catch (err) {
      throw new Error(SETTINGS_CHANGED_ERROR, { cause: err })
    }
    if (!isUnchangedFile(snapshotStats, currentStats)) {
      throw new Error(SETTINGS_CHANGED_ERROR)
    }

    // POSIX has no portable rename-if-inode-unchanged operation. The lock serializes this tool's
    // writers, but an editor that ignores it can still change the target before this rename.
    await rename(temporaryPath, targetPath)
    operationSucceeded = true
  } catch (err) {
    operationError = err
  } finally {
    for (const path of [temporaryPath, snapshotPath]) {
      try {
        await rm(path, { force: true })
      } catch (cleanupErr) {
        cleanupErrors.push(cleanupErr)
      }
    }
    try {
      await lock.handle.close()
    } catch (cleanupErr) {
      cleanupErrors.push(cleanupErr)
    }
    try {
      await rm(lock.path, { force: true })
    } catch (cleanupErr) {
      cleanupErrors.push(cleanupErr)
    }
  }

  if (!operationSucceeded) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        'Failed to write settings and clean temporary files',
      )
    }
    throw operationError
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Settings updated, but temporary file cleanup failed')
  }
}

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export async function createTempDir(
  prefix = 'llm-proxy-test-',
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export async function writeTempSettings(
  content: string,
  prefix = 'llm-proxy-config-',
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const settingsPath = join(dir, 'settings.jsonc')
  await writeFile(settingsPath, content, 'utf8')
  return { path: settingsPath, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

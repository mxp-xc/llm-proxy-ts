import { Command } from 'commander'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { logger } from '../server/logging.js'

export function createServeCommand(): Command {
  return new Command('serve')
    .description('Start the Hono HTTP server')
    .option('--watch', 'Enable watch mode (default: disabled)')
    .action((opts) => {
      const cliDir = dirname(fileURLToPath(import.meta.url))
      const serverPath = resolve(cliDir, '../server/server.ts')
      // 优先 bun 提速；未安装回退 tsx（运行时选择独立于外层脚本）
      const runner = hasBun() ? 'bun' : 'tsx'
      const args = opts.watch ? [runner === 'bun' ? '--watch' : 'watch', serverPath] : [serverPath]
      logger.info(`${runner} ${args.join(' ')}`)
      const child = spawn(runner, args, { stdio: 'inherit', shell: true })
      child.on('exit', (code) => {
        process.exit(code ?? 0)
      })
    })
}

function hasBun(): boolean {
  try {
    return spawnSync('bun', ['--version'], { stdio: 'ignore', shell: true }).status === 0
  } catch {
    return false
  }
}

import { Command } from 'commander'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export function createServeCommand(): Command {
  return new Command('serve')
    .description('Start the Hono HTTP server')
    .option('--no-watch', 'Disable watch mode (default: watch enabled)')
    .action((opts) => {
      const cliDir = dirname(fileURLToPath(import.meta.url))
      const serverPath = resolve(cliDir, '../../../../apps/server/src/server.ts')
      const cmd = opts.watch ? `tsx watch "${serverPath}"` : `tsx "${serverPath}"`
      const child = spawn(cmd, { stdio: 'inherit', shell: true })
      child.on('exit', (code) => {
        process.exit(code ?? 0)
      })
    })
}

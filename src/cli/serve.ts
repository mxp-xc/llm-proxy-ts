import { Command } from 'commander'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export function createServeCommand(): Command {
  return new Command('serve')
    .description('Start the Hono HTTP server')
    .option('--watch', 'Enable watch mode (default: disabled)')
    .action((opts) => {
      const cliDir = dirname(fileURLToPath(import.meta.url))
      const serverPath = resolve(cliDir, '../server/server.ts')
      const runner = 'bun'
      const args = opts.watch ? ['--watch', serverPath] : [serverPath]
      console.info(`${runner} ${args.join(' ')}`)
      const child = spawn(runner, args, { stdio: 'inherit', shell: true })
      child.on('exit', (code) => {
        process.exit(code ?? 0)
      })
    })
}

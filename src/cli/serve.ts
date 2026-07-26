import { Command, InvalidArgumentError } from 'commander'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

function parsePort(value: string): number {
  const port = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('Port must be an integer between 1 and 65535')
  }
  return port
}

export function createServeCommand(): Command {
  return new Command('serve')
    .description('Start the Hono HTTP server')
    .option('--watch', 'Enable watch mode (default: disabled)')
    .option('-p, --port <port>', 'Override the configured server port', parsePort)
    .action((opts) => {
      const cliDir = dirname(fileURLToPath(import.meta.url))
      const serverPath = resolve(cliDir, '../server/server.ts')
      const runner = 'bun'
      const args = opts.watch ? ['--watch', serverPath] : [serverPath]
      console.info(`${runner} ${args.join(' ')}`)
      const env =
        opts.port === undefined
          ? process.env
          : { ...process.env, LLM_PROXY_PORT: String(opts.port) }
      const child = spawn(runner, args, { stdio: 'inherit', shell: true, env })
      child.on('exit', (code) => {
        process.exit(code ?? 0)
      })
    })
}

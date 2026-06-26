import { Command } from 'commander'

export function createCodexInstallCommand(): Command {
  return new Command('install')
    .description('Install llm-proxy as a codex model provider in ~/.codex/config.toml')
    .action(async () => {
      const { runCodexInstall } = await import('./install-run.js')
      const { resolveCliContext } = await import('../context.js')
      const { settingsPath } = resolveCliContext()
      await runCodexInstall({ settingsPath })
    })
}

import { Command } from 'commander'

export function createModelsListCommand(): Command {
  return new Command('list')
    .description('Display all configured models from settings')
    .action(async () => {
      const { runModelsList } = await import('./list-run.js')
      const { resolveCliContext } = await import('../context.js')
      const { settingsPath } = resolveCliContext()
      await runModelsList({ settingsPath })
    })
}

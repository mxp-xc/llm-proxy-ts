import { Command } from 'commander'

export function createModelsSyncCommand(): Command {
  return new Command('sync')
    .description('Discover and select models from upstream providers')
    .option('-p, --provider <name>', 'Skip provider selection, sync specific provider')
    .option('--dry-run', 'Preview changes without writing to settings')
    .action(async (opts) => {
      const { runModelsSync } = await import('./sync-run.js')
      const { resolveCliContext } = await import('../context.js')
      const { settingsPath } = resolveCliContext()
      const syncOpts: Parameters<typeof runModelsSync>[0] = {
        settingsPath,
        dryRun: opts.dryRun ?? false,
      }
      if (opts.provider !== undefined) syncOpts.provider = opts.provider
      await runModelsSync(syncOpts)
    })
}

import { Command } from 'commander'
import { createModelsSyncCommand } from './models-sync.js'
import { createModelsListCommand } from './models-list.js'

export function createModelsCommand(): Command {
  return new Command('models')
    .description('Model management commands')
    .addCommand(createModelsSyncCommand())
    .addCommand(createModelsListCommand())
}

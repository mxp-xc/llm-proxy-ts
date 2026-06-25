import { Command } from 'commander'
import { createModelsSyncCommand } from './sync.js'
import { createModelsListCommand } from './list.js'

export function createModelsCommand(): Command {
  return new Command('models')
    .description('Model management commands')
    .addCommand(createModelsSyncCommand())
    .addCommand(createModelsListCommand())
}

import { Command } from 'commander'
import { createServeCommand } from './serve.js'
import { createModelsCommand } from './models.js'
import { createCodexCommand } from './codex.js'

const program = new Command()
  .name('llm-proxy')
  .description('LLM proxy CLI')
  .version('0.1.0')
  .addCommand(createServeCommand())
  .addCommand(createModelsCommand())
  .addCommand(createCodexCommand())

program.parse()

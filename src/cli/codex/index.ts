import { Command } from 'commander'
import { createCodexInstallCommand } from './install.js'

export function createCodexCommand(): Command {
  return new Command('codex').description('Codex integration commands').addCommand(createCodexInstallCommand())
}

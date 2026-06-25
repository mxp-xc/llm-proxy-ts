import { Command } from 'commander'
import { createCodexInstallCommand } from './codex-install.js'

export function createCodexCommand(): Command {
  return new Command('codex').description('Codex integration commands').addCommand(createCodexInstallCommand())
}

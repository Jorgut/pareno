// Desktop-only helpers that touch the local file system.
// This module must never be imported statically from code that runs on mobile:
// Obsidian mobile has no Node runtime, so eager imports would break plugin load.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

const EXTRA_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

export function resolveAgentCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed || isAbsolute(trimmed)) return trimmed;
  const home = homedir();
  const directories = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const directory of [
    ...EXTRA_DIRECTORIES,
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.cargo', 'bin')
  ]) {
    if (!directories.includes(directory)) directories.push(directory);
  }
  for (const directory of directories) {
    const candidate = join(directory, trimmed);
    if (existsSync(candidate)) return candidate;
  }
  return trimmed;
}

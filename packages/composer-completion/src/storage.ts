/** Shared on-disk namespace for completion state and experiments. */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Resolve DSH_HOME with the same home-directory expansion as the reference store. */
export function completionStoragePath(...parts: string[]): string {
  const configured = process.env.DSH_HOME
  let root = configured === undefined || configured.trim() === '' ? join(homedir(), '.dsh') : configured
  if (root === '~') root = homedir()
  else if (root.startsWith('~/') || root.startsWith('~\\')) root = join(homedir(), root.slice(2))
  return join(resolve(root), 'composer-completion', ...parts)
}

import path from 'node:path'
import { checkIdentities, fileIdentity, type ItemCheck, type PathIdentity } from './file-identity'
import { fs } from './real-fs'

export {
  fileIdentity,
  sameEntry,
  sameObject,
  type FileIdentity,
  type ItemCheck,
  type PathIdentity
} from './file-identity'

export async function ancestorIdentities(target: string): Promise<PathIdentity[]> {
  const identities: PathIdentity[] = []
  let current = path.dirname(target)
  while (true) {
    identities.push({ path: current, stats: fileIdentity(await fs.lstat(current)) })
    const parent = path.dirname(current)
    if (parent === current) return identities
    current = parent
  }
}

export function assertUnchanged(identities: PathIdentity[], check: ItemCheck): Promise<void> {
  return checkIdentities(identities, check, (target) => fs.lstat(target))
}

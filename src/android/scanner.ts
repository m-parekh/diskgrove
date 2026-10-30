import path from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { DeleteMode } from '@shared/types'
import {
  checkIdentities,
  fileIdentity,
  isDirMode,
  isLinkMode,
  sameEntry,
  type FileIdentity,
  type ItemCheck,
  type PathIdentity
} from '../main/file-identity'
import { type HashMode, type PendingDir, SAMPLE_HEAD, SAMPLE_TAIL, ScanResults } from '../main/scan-results'
import { joinPath, NONE } from '../main/scan-tree'
import { statsOf, type DiskGroveNativePlugin, type NativeStats } from './native-api'

const S_IFMT = 0o170000
const S_IFREG = 0o100000

/** Every folder above `target`, nearest first. */
function ancestorPaths(target: string): string[] {
  const paths: string[] = []
  for (let current = path.dirname(target); ; current = path.dirname(current)) {
    paths.push(current)
    if (path.dirname(current) === current) return paths
  }
}

/**
 * Where a scan of `root` actually happens: its real location when the path runs through a link, as
 * /sdcard does. Folders above the root that the app may not look at are taken to be plain folders.
 */
export async function resolveScanRoot(native: DiskGroveNativePlugin, root: string): Promise<string> {
  const resolved = path.resolve(root)
  const chain = [resolved, ...(resolved === '/' ? [] : ancestorPaths(resolved))]
  const { results } = await native.statMany({ paths: chain, follow: false })
  for (let i = 0; i < chain.length; i++) {
    const result = results[i]
    if (i > 0 && (!result || 'error' in result)) continue
    if (isLinkMode(statsOf(result, chain[i]).mode)) return (await native.realPath({ path: resolved })).path
  }
  return resolved
}

/** Scans shared storage through the DiskGroveNative plugin, one folder listing per bridge call. */
export class AndroidScanner extends ScanResults {
  /** Real locations of the folders walked while following links, to stop at cycles. */
  private realPaths = new Map<number, string>()
  private rootAncestors: PathIdentity[] = []

  constructor(private readonly native: DiskGroveNativePlugin) {
    super()
  }

  cancel(): void {
    super.cancel()
    this.native.cancelHashes().catch(() => undefined)
  }

  cancelDuplicates(): void {
    super.cancelDuplicates()
    this.native.cancelHashes().catch(() => undefined)
  }

  protected normalizeRoot(root: string): string {
    return path.resolve(root)
  }

  protected async prepare(root: string): Promise<{ rootPath: string; stats: NativeStats; name?: string }> {
    this.realPaths.clear()
    const rootPath = await resolveScanRoot(this.native, root)
    const ancestors = rootPath === '/' ? [] : ancestorPaths(rootPath)
    const [own, target, mounted] = await Promise.all([
      this.native.statMany({ paths: [rootPath, ...ancestors], follow: false }),
      this.native.statMany({ paths: [rootPath], follow: true }),
      this.native.volumes().catch(() => ({ volumes: [] }))
    ])
    const stats = statsOf(own.results[0], rootPath)
    if (!isDirMode(statsOf(target.results[0], rootPath).mode)) throw new Error('Select a directory to scan')
    // A folder the app cannot stat now could not be checked later either.
    this.rootAncestors = []
    ancestors.forEach((ancestor, i) => {
      const result = own.results[i + 1]
      if (result && 'stats' in result) this.rootAncestors.push({ path: ancestor, stats: fileIdentity(result.stats) })
    })
    // A volume's folder is named after its user or ID, such as "0", so it goes by the volume's label.
    const name = mounted.volumes.find((volume) => volume.path === rootPath)?.label || undefined
    return { rootPath, stats, name }
  }

  protected walkWorkers(): number {
    return 4
  }

  protected afterWalk(): void {
    this.realPaths.clear()
  }

  protected async walk(dir: PendingDir, enqueue: (dir: PendingDir) => void): Promise<void> {
    if (this.cancelled) return
    const tree = this.tree
    this.currentPath = dir.path

    try {
      const listing = await this.native.listDir({ path: dir.path, followLinks: this.followLinks })
      if (this.followLinks && listing.realPath) {
        const real = listing.realPath
        this.realPaths.set(dir.id, real)
        for (let ancestor = tree.parent[dir.id]; ancestor !== NONE; ancestor = tree.parent[ancestor]) {
          if (this.realPaths.get(ancestor) === real) return
        }
      }
      let visited = 0
      for (const entry of listing.entries) {
        if (this.cancelled || tree !== this.tree) return
        if (++visited % 4096 === 0) await yieldToLoop()
        if (this.shouldSkip(entry.name)) continue
        const identity = entry.lstat
        if (!identity || entry.error) {
          this.noteUnreadable(dir.id, entry.name, 'file', { code: entry.error ?? 'UNKNOWN' })
          continue
        }
        const link = isLinkMode(identity.mode)
        if (link && !this.followLinks) continue
        const st = link ? entry.stat : identity
        if (!st) continue
        if (isDirMode(st.mode)) {
          const child = this.addDir(dir.id, entry.name, identity, st)
          enqueue({ id: child, path: joinPath(dir.path, entry.name) })
          continue
        }
        if ((st.mode & S_IFMT) !== S_IFREG) continue
        const size = Number(st.size) || 0
        this.addFile(dir.id, entry.name, identity, st, size, Math.max(0, st.blocks) * 512)
      }
    } catch (error) {
      this.noteUnreadable(dir.id, null, 'dir', error)
    }
  }

  protected async checkIdentities(identities: PathIdentity[], check: ItemCheck): Promise<void> {
    const all = [...identities, ...this.rootAncestors]
    const { results } = await this.native.statMany({ paths: all.map((item) => item.path), follow: false })
    const current = new Map(all.map((item, i) => [item.path, results[i]]))
    await checkIdentities(all, check, async (target) => statsOf(current.get(target), target))
  }

  protected async hashFile(
    filePath: string,
    size: number,
    mode: HashMode,
    identity: FileIdentity,
    stopped: () => boolean
  ): Promise<string> {
    if (stopped()) throw new Error('Duplicate search stopped')
    const result = await this.native.hashFile({ path: filePath, size, mode, head: SAMPLE_HEAD, tail: SAMPLE_TAIL })
    if (!sameEntry(identity, result.before)) throw new Error('File changed since the scan')
    if (!sameEntry(identity, result.after)) throw new Error('File changed while hashing')
    return result.hash
  }

  protected async removeItem(itemPath: string, mode: DeleteMode): Promise<void> {
    if (mode === 'trash') throw new Error('Android has no Trash for these files. Delete them permanently instead.')
    await this.native.remove({ path: itemPath })
  }
}

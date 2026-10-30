import { shell } from 'electron'
import { createHash, type Hash } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { DeleteMode } from '@shared/types'
import { forEachConcurrent } from './concurrency'
import {
  ancestorIdentities,
  assertUnchanged,
  sameEntry,
  type FileIdentity,
  type ItemCheck,
  type PathIdentity
} from './file-safety'
import { firmlinkDuplicates, virtualDevices } from './mounts'
import { fs } from './real-fs'
import { type HashMode, type PendingDir, SAMPLE_HEAD, SAMPLE_TAIL, ScanResults } from './scan-results'
import { joinPath, NONE } from './scan-tree'

const CLUSTER = 4096

function nativePath(p: string): string {
  if (process.platform !== 'win32') return p
  const normalized = path.resolve(p)
  if (normalized.startsWith('\\\\?\\')) return normalized
  // Stat calls on a prefixed volume root (\\?\C:\) fail with EISDIR; roots are short anyway.
  if (path.parse(normalized).root === normalized) return normalized
  if (normalized.startsWith('\\\\')) return `\\\\?\\UNC\\${normalized.slice(2)}`
  return `\\\\?\\${normalized}`
}

function displayPath(p: string): string {
  return p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
}

/**
 * Where a scan of `root` actually happens. A root reached through a link (macOS /tmp and /var, a
 * symlinked home folder, a Windows junction) would fail every later identity check, so it becomes
 * its real location. Paths without links keep their spelling: realpath would also turn a mapped
 * Windows drive into its UNC share.
 */
export async function resolveScanRoot(root: string): Promise<string> {
  const resolved = displayPath(path.resolve(root))
  for (let current = resolved; ; current = path.dirname(current)) {
    if ((await fs.lstat(nativePath(current))).isSymbolicLink()) {
      return displayPath(await fs.realpath(nativePath(resolved)))
    }
    if (path.dirname(current) === current) return resolved
  }
}

function allocatedOf(size: number, stats: Stats): number {
  if (typeof stats.blocks === 'number') {
    // Outside Windows a zero block count is exact: sparse, inline and virtual files occupy nothing.
    if (stats.blocks > 0 || process.platform !== 'win32') return stats.blocks * 512
  }
  if (size <= 0) return 0
  return Math.ceil(size / CLUSTER) * CLUSTER
}

function isLink(entry: Dirent): boolean {
  if (entry.isSymbolicLink()) return true
  const maybe = entry as Dirent & { isJunction?: () => boolean }
  return typeof maybe.isJunction === 'function' && maybe.isJunction()
}

/** Scans a local disk through Node's filesystem API. */
export class Scanner extends ScanResults {
  /** Real locations of the folders walked while following links, to stop at cycles. */
  private realPaths = new Map<number, string>()
  private rootAncestors: PathIdentity[] = []
  private virtualDevices = new Set<number>()
  private duplicatePaths = new Set<string>()

  protected normalizeRoot(root: string): string {
    return displayPath(path.resolve(root))
  }

  protected async prepare(root: string): Promise<{ rootPath: string; stats: Stats }> {
    this.realPaths.clear()
    const rootPath = await resolveScanRoot(root)
    const stats = await fs.lstat(nativePath(rootPath))
    const target = await fs.stat(nativePath(rootPath))
    if (!target.isDirectory()) throw new Error('Select a directory to scan')
    this.rootAncestors = await ancestorIdentities(rootPath)
    this.virtualDevices = await virtualDevices()
    // A virtual filesystem chosen as the scan root is still scanned as asked.
    this.virtualDevices.delete(target.dev)
    this.duplicatePaths = await firmlinkDuplicates(rootPath)
    return { rootPath, stats }
  }

  protected walkWorkers(): number {
    return Math.min(8, Math.max(2, os.availableParallelism()))
  }

  protected afterWalk(): void {
    this.realPaths.clear()
  }

  protected async walk(dir: PendingDir, enqueue: (dir: PendingDir) => void): Promise<void> {
    if (this.cancelled) return
    const tree = this.tree
    this.currentPath = dir.path

    try {
      if (this.followLinks) {
        const real = await fs.realpath(nativePath(dir.path))
        this.realPaths.set(dir.id, real)
        for (let ancestor = tree.parent[dir.id]; ancestor !== NONE; ancestor = tree.parent[ancestor]) {
          if (this.realPaths.get(ancestor) === real) return
        }
      }
      const handle = await fs.opendir(nativePath(dir.path), { bufferSize: 256 })
      const processChunk = async (chunk: Dirent[]) => {
        await forEachConcurrent(chunk, 4, async (entry) => {
          if (this.cancelled) return
          if (this.shouldSkip(entry.name)) return
          if (!this.followLinks && isLink(entry)) return

          const childPath = joinPath(dir.path, entry.name)
          if (this.duplicatePaths.has(childPath)) return
          try {
            const identity = await fs.lstat(nativePath(childPath))
            if (identity.isSymbolicLink() && !this.followLinks) return
            const st = identity.isSymbolicLink() ? await fs.stat(nativePath(childPath)) : identity
            // Mount points of virtual filesystems are listed but their contents are not real data.
            const virtual = this.virtualDevices.has(st.dev)
            if (st.isDirectory()) {
              const child = this.addDir(dir.id, entry.name, identity, st)
              if (!virtual) enqueue({ id: child, path: childPath })
              return
            }
            if (!st.isFile() || virtual) return

            const size = Number(st.size) || 0
            this.addFile(dir.id, entry.name, identity, st, size, allocatedOf(size, st))
          } catch (error) {
            this.noteUnreadable(dir.id, entry.name, entry.isDirectory() ? 'dir' : 'file', error)
          }
        })
        await yieldToLoop()
      }
      let chunk: Dirent[] = []
      for await (const entry of handle) {
        if (this.cancelled) break
        chunk.push(entry)
        if (chunk.length === 64) {
          await processChunk(chunk)
          chunk = []
        }
      }
      if (!this.cancelled && chunk.length) await processChunk(chunk)
    } catch (error) {
      this.noteUnreadable(dir.id, null, 'dir', error)
    }
  }

  protected checkIdentities(identities: PathIdentity[], check: ItemCheck): Promise<void> {
    const native = identities.map((item) => ({ path: nativePath(item.path), stats: item.stats }))
    return assertUnchanged([...native, ...this.rootAncestors], check)
  }

  protected hashFile(
    filePath: string,
    size: number,
    mode: HashMode,
    identity: FileIdentity,
    stopped: () => boolean
  ): Promise<string> {
    return hashFile(filePath, size, mode, identity, stopped)
  }

  protected async removeItem(itemPath: string, mode: DeleteMode): Promise<void> {
    const native = nativePath(itemPath)
    const st = await fs.lstat(native)
    const isLinkNow = st.isSymbolicLink()
    const isDirNow = !isLinkNow && st.isDirectory()

    if (mode === 'trash') {
      await shell.trashItem(itemPath)
    } else if (isLinkNow) {
      await removeLink(native)
    } else if (isDirNow) {
      await fs.rm(native, { recursive: true, force: false })
    } else {
      await fs.unlink(native)
    }
  }
}

async function removeLink(native: string): Promise<void> {
  try {
    await fs.unlink(native)
  } catch (err) {
    // Windows reports directory symlinks and junctions as directories: rmdir removes just the link.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EISDIR') throw err
    await fs.rmdir(native)
  }
}

async function digestRange(
  hash: Hash,
  file: FileHandle,
  start: number,
  end: number,
  stopped: () => boolean
): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = start
  while (position < end) {
    if (stopped()) throw new Error('Duplicate search stopped')
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position)
    if (!bytesRead) throw new Error('File was truncated while hashing')
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
}

async function hashFile(
  filePath: string,
  size: number,
  mode: HashMode,
  identity: FileIdentity,
  stopped: () => boolean
): Promise<string> {
  const hash = createHash('sha256')
  const file = await fs.open(nativePath(filePath), 'r')
  try {
    if (!sameEntry(identity, await file.stat())) throw new Error('File changed since the scan')
    if (mode === 'full' || size <= SAMPLE_HEAD) {
      await digestRange(hash, file, 0, size, stopped)
    } else {
      await digestRange(hash, file, 0, SAMPLE_HEAD, stopped)
      await digestRange(hash, file, Math.max(0, size - SAMPLE_TAIL), size, stopped)
    }
    if (!sameEntry(identity, await file.stat())) throw new Error('File changed while hashing')
    hash.update(String(size))
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}

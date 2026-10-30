import path from 'node:path'
import { extensionOf } from '@shared/format'
import type { NodeKind } from '@shared/types'
import type { EntryStats, FileIdentity } from './file-identity'

/** No item: the root's parent, an empty child list, the end of a sibling list. */
export const NONE = -1

const DIR = 1
const REMOVED = 2
const UNREADABLE = 4

type Column = Float64Array | Int32Array | Uint32Array | Uint8Array

function grown<T extends Column>(column: T, capacity: number): T {
  const next = new (column.constructor as new (length: number) => T)(capacity)
  next.set(column)
  return next
}

/** The path of the item called `name` inside the folder at `parent`. Names never contain a separator. */
export function joinPath(parent: string, name: string): string {
  return parent.endsWith(path.sep) ? parent + name : parent + path.sep + name
}

/**
 * The items of one scan, one row each, stored column by column in typed arrays. An item is its row
 * number: the root is 0, and a folder always has a smaller id than anything inside it. Rows of objects
 * with full paths took about 470 bytes of heap per item; these columns take well under half of that,
 * and the garbage collector never has to trace them. Paths are not stored but rebuilt from the names
 * up the parent chain.
 */
export class ScanTree {
  count = 0
  readonly names: string[] = []
  flags = new Uint8Array(0)
  parent = new Int32Array(0)
  firstChild = new Int32Array(0)
  lastChild = new Int32Array(0)
  nextSibling = new Int32Array(0)
  size = new Float64Array(0)
  allocated = new Float64Array(0)
  mtime = new Float64Array(0)
  atime = new Float64Array(0)
  ctime = new Float64Array(0)
  fileCount = new Uint32Array(0)
  folderCount = new Uint32Array(0)
  private extIndex = new Uint32Array(0)
  // What lstat said about the item itself, to tell later whether it was replaced (see file-identity).
  private dev = new Float64Array(0)
  private ino = new Float64Array(0)
  private birthtime = new Float64Array(0)
  private mode = new Uint32Array(0)
  private ownSize = new Float64Array(0)
  private ownMtime = new Float64Array(0)
  private readonly extNames: string[] = ['']
  private readonly extIds = new Map<string, number>([['', 0]])
  private readonly prefix: string

  constructor(readonly rootPath: string) {
    this.prefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep
  }

  /** Adds an item as the last child of `parent`; `stats` is its own lstat. */
  add(name: string, kind: NodeKind, parent: number, stats: EntryStats): number {
    if (this.count === this.flags.length) this.grow()
    const id = this.count++
    this.names.push(name)
    this.flags[id] = kind === 'dir' ? DIR : 0
    this.parent[id] = parent
    this.firstChild[id] = NONE
    this.lastChild[id] = NONE
    this.nextSibling[id] = NONE
    this.extIndex[id] = kind === 'file' ? this.internExt(extensionOf(name)) : 0
    this.dev[id] = stats.dev
    this.ino[id] = stats.ino
    this.birthtime[id] = stats.birthtimeMs
    this.mode[id] = stats.mode
    this.ownSize[id] = stats.size
    this.ownMtime[id] = stats.mtimeMs
    if (parent !== NONE) {
      const last = this.lastChild[parent]
      if (last === NONE) this.firstChild[parent] = id
      else this.nextSibling[last] = id
      this.lastChild[parent] = id
    }
    return id
  }

  private internExt(ext: string): number {
    let index = this.extIds.get(ext)
    if (index === undefined) {
      index = this.extNames.length
      this.extNames.push(ext)
      this.extIds.set(ext, index)
    }
    return index
  }

  private grow(): void {
    const capacity = Math.max(1024, Math.ceil(this.flags.length * 1.5))
    this.flags = grown(this.flags, capacity)
    this.parent = grown(this.parent, capacity)
    this.firstChild = grown(this.firstChild, capacity)
    this.lastChild = grown(this.lastChild, capacity)
    this.nextSibling = grown(this.nextSibling, capacity)
    this.size = grown(this.size, capacity)
    this.allocated = grown(this.allocated, capacity)
    this.mtime = grown(this.mtime, capacity)
    this.atime = grown(this.atime, capacity)
    this.ctime = grown(this.ctime, capacity)
    this.fileCount = grown(this.fileCount, capacity)
    this.folderCount = grown(this.folderCount, capacity)
    this.extIndex = grown(this.extIndex, capacity)
    this.dev = grown(this.dev, capacity)
    this.ino = grown(this.ino, capacity)
    this.birthtime = grown(this.birthtime, capacity)
    this.mode = grown(this.mode, capacity)
    this.ownSize = grown(this.ownSize, capacity)
    this.ownMtime = grown(this.ownMtime, capacity)
  }

  setTimes(id: number, stats: EntryStats): void {
    this.mtime[id] = stats.mtimeMs
    this.atime[id] = stats.atimeMs
    this.ctime[id] = stats.ctimeMs
  }

  kind(id: number): NodeKind {
    return this.flags[id] & DIR ? 'dir' : 'file'
  }

  isDir(id: number): boolean {
    return (this.flags[id] & DIR) !== 0
  }

  /** Deleted after the scan, or inside something that was. */
  isRemoved(id: number): boolean {
    return (this.flags[id] & REMOVED) !== 0
  }

  /** A folder the scan could not list, completely or at all. */
  isUnreadable(id: number): boolean {
    return (this.flags[id] & UNREADABLE) !== 0
  }

  markUnreadable(id: number): void {
    this.flags[id] |= UNREADABLE
  }

  ext(id: number): string {
    return this.extNames[this.extIndex[id]]
  }

  /** Index into the extension table; equal indexes mean equal extensions. */
  extId(id: number): number {
    return this.extIndex[id]
  }

  extName(index: number): string {
    return this.extNames[index]
  }

  /** Index of `ext` in the extension table, or null when no file has it. */
  extIndexOf(ext: string): number | null {
    return this.extIds.get(ext) ?? null
  }

  identity(id: number): FileIdentity {
    return {
      dev: this.dev[id],
      ino: this.ino[id],
      birthtimeMs: this.birthtime[id],
      mode: this.mode[id],
      size: this.ownSize[id],
      mtimeMs: this.ownMtime[id]
    }
  }

  *children(id: number): Generator<number> {
    for (let child = this.firstChild[id]; child !== NONE; child = this.nextSibling[child]) yield child
  }

  pushChildren(id: number, stack: number[]): void {
    for (let child = this.firstChild[id]; child !== NONE; child = this.nextSibling[child]) stack.push(child)
  }

  hasSubdirs(id: number): boolean {
    for (let child = this.firstChild[id]; child !== NONE; child = this.nextSibling[child]) {
      if (this.flags[child] & DIR) return true
    }
    return false
  }

  pathOf(id: number): string {
    if (id === 0) return this.rootPath
    const names: string[] = []
    for (let n = id; n > 0; n = this.parent[n]) names.push(this.names[n])
    return this.prefix + names.reverse().join(path.sep)
  }

  /** The path of the folder holding `id`, given the item's own path; null for the root. */
  parentPath(id: number, itemPath: string): string | null {
    const parent = this.parent[id]
    if (parent === NONE) return null
    if (parent === 0) return this.rootPath
    return itemPath.slice(0, itemPath.length - this.names[id].length - path.sep.length)
  }

  /** The item at exactly this path, as the scan spells it. */
  find(target: string): number | null {
    if (!this.count) return null
    if (target === this.rootPath) return 0
    if (!target.startsWith(this.prefix)) return null
    let id = 0
    for (const name of target.slice(this.prefix.length).split(path.sep)) {
      let child = this.firstChild[id]
      while (child !== NONE && this.names[child] !== name) child = this.nextSibling[child]
      if (child === NONE) return null
      id = child
    }
    return id
  }

  addToAncestors(id: number, size: number, allocated: number, files: number, folders: number): void {
    for (let n = id; n !== NONE; n = this.parent[n]) {
      this.size[n] += size
      this.allocated[n] += allocated
      this.fileCount[n] += files
      this.folderCount[n] += folders
    }
  }

  /** Takes `id` out of its folder and its totals, and marks everything below it removed. */
  remove(id: number): void {
    const parent = this.parent[id]
    if (parent !== NONE) {
      let previous = NONE
      let child = this.firstChild[parent]
      while (child !== NONE && child !== id) {
        previous = child
        child = this.nextSibling[child]
      }
      if (child === NONE) return
      if (previous === NONE) this.firstChild[parent] = this.nextSibling[id]
      else this.nextSibling[previous] = this.nextSibling[id]
      if (this.lastChild[parent] === id) this.lastChild[parent] = previous
      const folders = this.folderCount[id] + (this.isDir(id) ? 1 : 0)
      for (let n = parent; n !== NONE; n = this.parent[n]) {
        this.size[n] = Math.max(0, this.size[n] - this.size[id])
        this.allocated[n] = Math.max(0, this.allocated[n] - this.allocated[id])
        this.fileCount[n] = Math.max(0, this.fileCount[n] - this.fileCount[id])
        this.folderCount[n] = Math.max(0, this.folderCount[n] - folders)
      }
    }
    const stack = [id]
    while (stack.length) {
      const n = stack.pop()!
      this.flags[n] |= REMOVED
      this.pushChildren(n, stack)
    }
  }
}

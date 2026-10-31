import { createHash } from 'node:crypto'
import { promises as fs, type Stats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))
import { Scanner } from '../src/main/scanner'
import { SAMPLE_HEAD, SAMPLE_TAIL, type ScanResults } from '../src/main/scan-results'
import type { AndroidAccess, DuplicateGroup, InstalledApp, MediaFile, MediaKind, MediaSummary } from '@shared/types'
import { createAndroidApi, MEDIA_PATH, type SettingsStorage } from '../src/android/api'
import { ICON_PATH, THUMB_PATH } from '../src/android/features'
import type { DiskGroveNativePlugin, NativeStats, NativeVolume } from '../src/android/native-api'
import { AndroidScanner, resolveScanRoot } from '../src/android/scanner'
import * as shim from '../src/android/shims/path'
import { canOpenFolders, revealLabel, trashName } from '../src/renderer/src/lib/platform'
import { appTotal, lastActive, lastUsedText, unusedFor } from '@shared/apps'

function toNative(st: Stats): NativeStats {
  const { dev, ino, mode, size, blocks, mtimeMs, atimeMs, ctimeMs, birthtimeMs } = st
  return { dev, ino, mode, size, blocks, mtimeMs, atimeMs, ctimeMs, birthtimeMs }
}

function errnoOf(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? 'EIO'
}

async function readRange(file: fs.FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, end - start))
  const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
  return buffer.subarray(0, bytesRead)
}

/** The DiskGroveNative plugin's contract, served from the local filesystem the way the Java plugin serves it. */
function fakeNative(volumes: NativeVolume[] = []) {
  const exports = new Map<string, string>()
  const native = {
    confirmed: false,
    exportId: 'doc-1' as string | null,
    exports,
    access: {
      sdk: 37,
      files: true,
      allFilesSetting: true,
      usage: false,
      appSizes: true,
      packages: true,
      uninstall: true,
      clearCache: true
    } as AndroidAccess,
    apps: [] as InstalledApp[],
    /** What the media index lists; files of every kind, which mediaFiles picks from by type. */
    media: [] as MediaFile[],
    async listDir({ path: dir, followLinks }: { path: string; followLinks: boolean }) {
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch (err) {
        throw Object.assign(new Error(errnoOf(err)), { code: errnoOf(err) })
      }
      const entries = await Promise.all(
        names.map(async (name) => {
          const full = path.join(dir, name)
          try {
            const lstat = await fs.lstat(full)
            if (!followLinks || !lstat.isSymbolicLink()) return { name, lstat: toNative(lstat) }
            const stat = await fs.stat(full).then(toNative, () => undefined)
            return { name, lstat: toNative(lstat), stat }
          } catch (err) {
            return { name, error: errnoOf(err) }
          }
        })
      )
      return followLinks ? { entries, realPath: await fs.realpath(dir) } : { entries }
    },
    async statMany({ paths, follow }: { paths: string[]; follow: boolean }) {
      const results = await Promise.all(
        paths.map((p) =>
          (follow ? fs.stat(p) : fs.lstat(p)).then(
            (st) => ({ stats: toNative(st) }),
            (err) => ({ error: errnoOf(err) })
          )
        )
      )
      return { results }
    },
    async realPath({ path: p }: { path: string }) {
      return { path: await fs.realpath(p) }
    },
    async hashFile(options: { path: string; size: number; mode: 'sample' | 'full'; head: number; tail: number }) {
      const file = await fs.open(options.path, 'r')
      try {
        const before = toNative(await file.stat())
        const hash = createHash('sha256')
        if (options.mode === 'full' || options.size <= options.head) {
          hash.update(await readRange(file, 0, options.size))
        } else {
          hash.update(await readRange(file, 0, options.head))
          hash.update(await readRange(file, Math.max(0, options.size - options.tail), options.size))
        }
        const after = toNative(await file.stat())
        hash.update(String(options.size))
        return { hash: hash.digest('hex'), before, after }
      } finally {
        await file.close()
      }
    },
    cancelHashes: vi.fn(async () => undefined),
    remove: vi.fn(async ({ path: p }: { path: string }) => {
      const st = await fs.lstat(p)
      if (st.isDirectory()) await fs.rm(p, { recursive: true })
      else await fs.unlink(p)
    }),
    async volumes() {
      return { volumes }
    },
    async space() {
      return { total: 1000, free: 400 }
    },
    async pickFolder() {
      return { path: null }
    },
    openFile: vi.fn(async () => undefined),
    async readFile({ path: p, offset, length }: { path: string; offset: number; length: number }) {
      const file = await fs.open(p, 'r')
      try {
        const size = (await file.stat()).size
        const bytes = await readRange(file, offset, Math.min(size, offset + length))
        return { data: bytes.toString('base64'), offset, size }
      } finally {
        await file.close()
      }
    },
    confirm: vi.fn(async (_options: { title: string; message: string; detail: string; confirm: string }) => ({
      confirmed: native.confirmed
    })),
    async exportBegin({ name }: { name: string; type: string }) {
      if (native.exportId) exports.set(native.exportId, '')
      return { id: native.exportId, name }
    },
    async exportWrite({ id, data }: { id: string; data: string }) {
      exports.set(id, (exports.get(id) ?? '') + data)
    },
    exportEnd: vi.fn(async (_options: { id: string; ok: boolean }) => undefined),
    async storageAccess() {
      return { granted: true }
    },
    async requestStorageAccess() {
      return { granted: true }
    },
    async home() {
      return { path: volumes[0]?.path ?? '/storage/emulated/0' }
    },
    async setWindowColors() {},
    async accessStatus() {
      return { ...native.access }
    },
    async requestUsageAccess() {
      native.access.usage = true
      return { ...native.access }
    },
    async deviceStorage() {
      return { total: 1000, free: 400 }
    },
    async listApps() {
      return { apps: native.apps.map((a) => ({ ...a })), usageAccess: native.access.usage }
    },
    async appInfo({ package: pkg }: { package: string }) {
      return { app: native.apps.find((a) => a.package === pkg) ?? null }
    },
    openApp: vi.fn(async (_options: { package: string }) => undefined),
    appDetails: vi.fn(async ({ package: pkg }: { package: string }) => ({
      app: native.apps.find((a) => a.package === pkg) ?? null
    })),
    uninstallApp: vi.fn(async ({ package: pkg }: { package: string }) => {
      native.apps = native.apps.filter((a) => a.package !== pkg)
      return { app: null }
    }),
    clearAppCaches: vi.fn(async () => ({ cleared: true })),
    manageStorage: vi.fn(async () => undefined),
    async mediaSummary() {
      const summary = {} as MediaSummary
      for (const kind of ['images', 'videos', 'audio', 'documents', 'archives', 'apks', 'other'] as const) {
        const files = native.media.filter((f) => f.type === kind)
        summary[kind] = { count: files.length, bytes: files.reduce((n, f) => n + f.size, 0) }
      }
      for (const kind of ['downloads', 'screenshots', 'oldScreenshots', 'large', 'trash'] as const)
        summary[kind] = { count: 0, bytes: 0 }
      return summary
    },
    mediaFiles: vi.fn(async ({ kind, limit }: { kind: MediaKind; limit: number }) => {
      const files = native.media.filter((f) => f.type === kind).sort((a, b) => b.size - a.size)
      const bytes = files.reduce((n, f) => n + f.size, 0)
      return { count: files.length, bytes, files: files.slice(0, limit) }
    }),
    shareFiles: vi.fn(async (_options: { paths: string[] }) => undefined)
  }
  return native satisfies DiskGroveNativePlugin
}

function memoryStorage(initial: Record<string, string> = {}): SettingsStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    }
  }
}

function snapshotOf(scanner: ScanResults) {
  return scanner
    .flatten()
    .slice(1)
    .map((n) => ({ path: n.path, kind: n.kind, size: n.size, allocated: n.allocated, files: n.fileCount }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

let fixture: string
let root: string

beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-test-'))
  root = path.join(fixture, 'scan')
  await fs.mkdir(root)
})

afterEach(async () => {
  if (
    path.dirname(fixture) !== (await fs.realpath(os.tmpdir())) ||
    !path.basename(fixture).startsWith('diskgrove-test-')
  ) {
    throw new Error('Unexpected fixture path')
  }
  await fs.rm(fixture, { recursive: true, force: true })
})

async function buildTree(): Promise<void> {
  const big = Buffer.alloc(SAMPLE_HEAD + SAMPLE_TAIL + 4096, 7)
  // Same head and tail as `big`, different middle: sampled hashes match but full hashes do not.
  const nearlyBig = Buffer.from(big)
  nearlyBig[SAMPLE_HEAD + 100] = 9
  await fs.mkdir(path.join(root, 'Music', 'Albums'), { recursive: true })
  await fs.mkdir(path.join(root, 'Download'))
  await fs.mkdir(path.join(root, 'Empty'))
  await fs.writeFile(path.join(root, 'notes.txt'), 'hello world')
  await fs.writeFile(path.join(root, '.nomedia'), '')
  await fs.writeFile(path.join(root, 'Music', 'song.mp3'), 'not really audio')
  await fs.writeFile(path.join(root, 'Music', 'Albums', 'copy.mp3'), 'not really audio')
  await fs.writeFile(path.join(root, 'Download', 'big.bin'), big)
  await fs.writeFile(path.join(root, 'Download', 'big-copy.bin'), big)
  await fs.writeFile(path.join(root, 'Download', 'nearly-big.bin'), nearlyBig)
  await fs.symlink(path.join(root, 'Music'), path.join(root, 'Download', 'music-link'))
}

describe('path shim', () => {
  const posix = path.posix
  const samples = [
    '/',
    '//',
    '/a',
    '/a/',
    '/a/b/c.txt',
    '/a//b/../c/./d',
    '/a/..',
    '/a.b/c',
    'a',
    'a/',
    'a/..',
    'a/../',
    '../a',
    '..',
    '...',
    '.',
    '',
    'file.tar.gz'
  ]

  it('normalizes, splits and parses paths like node:path', () => {
    for (const p of samples) {
      expect(shim.normalize(p), `normalize ${p}`).toBe(posix.normalize(p))
      expect(shim.isAbsolute(p), `isAbsolute ${p}`).toBe(posix.isAbsolute(p))
      expect(shim.basename(p), `basename ${p}`).toBe(posix.basename(p))
      expect(shim.extname(p), `extname ${p}`).toBe(posix.extname(p))
      if (p) expect(shim.dirname(p), `dirname ${p}`).toBe(posix.dirname(p))
    }
    for (const p of ['/home/u/file.txt', '/home/u/', 'file.tar.gz', '/', '.bashrc', 'dir/a.']) {
      expect(shim.parse(p), `parse ${p}`).toEqual(posix.parse(p))
    }
    expect(shim.basename('/a/b.txt', '.txt')).toBe('b')
    expect(shim.basename('/a/.txt', '.txt')).toBe(posix.basename('/a/.txt', '.txt'))
  })

  it('joins and resolves absolute paths like node:path', () => {
    const joins = [
      ['/a', 'b', '../c'],
      ['a', '', 'b/'],
      ['/', '..'],
      ['', ''],
      ['/a/', '/b']
    ]
    for (const parts of joins) expect(shim.join(...parts), parts.join(' + ')).toBe(posix.join(...parts))
    const resolves = [['/a', 'b'], ['/a', '/b', 'c/..'], ['/a/b/', '../../..'], ['/x', ''], ['/storage/emulated/0/']]
    for (const parts of resolves) expect(shim.resolve(...parts), parts.join(' + ')).toBe(posix.resolve(...parts))
  })
})

describe.skipIf(process.platform === 'win32')('AndroidScanner', () => {
  it('scans and finds duplicates exactly like the desktop scanner', async () => {
    await buildTree()
    const desktop = new Scanner()
    const android = new AndroidScanner(fakeNative())
    await desktop.start(root)
    await android.start(root)
    const space = { total: 0, free: 0 }
    const { elapsedMs: _a, ...desktopTotals } = desktop.finish(space)
    const { elapsedMs: _b, ...androidTotals } = android.finish(space)
    expect(androidTotals).toEqual(desktopTotals)
    expect(androidTotals.files).toBe(7)
    expect(snapshotOf(android)).toEqual(snapshotOf(desktop))

    // Files within a group come in the order their hashes finish, which varies between runs.
    const sorted = (groups: DuplicateGroup[]) =>
      groups.map((g) => ({ ...g, files: [...g.files].sort((a, b) => a.path.localeCompare(b.path)) }))
    const desktopGroups = sorted(await desktop.findDuplicates(null))
    const androidGroups = sorted(await android.findDuplicates(null))
    expect(androidGroups).toEqual(desktopGroups)
    expect(androidGroups.map((g) => g.files.map((f) => f.name))).toEqual([
      ['big-copy.bin', 'big.bin'],
      ['copy.mp3', 'song.mp3']
    ])
  })

  it('follows links and skips hidden files like the desktop scanner', async () => {
    await buildTree()
    await fs.symlink(root, path.join(root, 'Music', 'Albums', 'loop'))
    const desktop = new Scanner()
    const android = new AndroidScanner(fakeNative())
    const options = { followLinks: true, skipHidden: true }
    await desktop.start(root, options)
    await android.start(root, options)
    const space = { total: 0, free: 0 }
    const { elapsedMs: _a, ...desktopTotals } = desktop.finish(space)
    const { elapsedMs: _b, ...androidTotals } = android.finish(space)
    expect(androidTotals).toEqual(desktopTotals)
    expect(snapshotOf(android)).toEqual(snapshotOf(desktop))
    expect(android.getNode(path.join(root, '.nomedia'))).toBeNull()
    expect(android.getNode(path.join(root, 'Download', 'music-link', 'song.mp3'))?.kind).toBe('file')
  })

  it('names a volume root after its label without changing its paths', async () => {
    await fs.writeFile(path.join(root, 'notes.txt'), 'hello')
    const volume = { path: root, label: 'Internal shared storage', primary: true, removable: false, total: 1, free: 1 }
    const scanner = new AndroidScanner(fakeNative([volume]))
    await scanner.start(root)
    expect(scanner.getNode(root)).toMatchObject({ name: 'Internal shared storage', path: root })
    expect(scanner.getChildren(root, { key: 'name', dir: 'asc' }).files.map((f) => f.path)).toEqual([
      path.join(root, 'notes.txt')
    ])

    await fs.mkdir(path.join(root, 'sub'))
    await scanner.start(path.join(root, 'sub'))
    expect(scanner.getNode(path.join(root, 'sub'))?.name).toBe('sub')
  })

  it('scans a root reached through a link at its real location', async () => {
    const link = path.join(fixture, 'sdcard')
    await fs.symlink(root, link)
    const native = fakeNative()
    expect(await resolveScanRoot(native, link)).toBe(root)
    expect(await resolveScanRoot(native, root)).toBe(root)
    const scanner = new AndroidScanner(native)
    await scanner.start(link)
    expect(scanner.getRootPath()).toBe(root)
  })

  it('reports folders it cannot list as unreadable', async () => {
    await fs.mkdir(path.join(root, 'Android', 'data'), { recursive: true })
    const native = fakeNative()
    const listDir = native.listDir
    native.listDir = async (options) => {
      if (options.path.endsWith(`${path.sep}data`)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return listDir(options)
    }
    const scanner = new AndroidScanner(native)
    await scanner.start(root)
    expect(scanner.finish({ total: 0, free: 0 }).unreadable).toBe(1)
    expect(scanner.getUnreadable(10).items.map((i) => i.path)).toEqual([path.join(root, 'Android', 'data')])
  })

  it('refuses to move items to a Trash it does not have', async () => {
    await fs.writeFile(path.join(root, 'notes.txt'), 'hello')
    const native = fakeNative()
    const scanner = new AndroidScanner(native)
    await scanner.start(root)
    const result = await scanner.deleteMany([path.join(root, 'notes.txt')], 'trash')
    expect(result.deleted).toEqual([])
    expect(result.failed[0].error).toMatch(/no Trash/)
    expect(native.remove).not.toHaveBeenCalled()
    await expect(fs.stat(path.join(root, 'notes.txt'))).resolves.toBeTruthy()
  })
})

describe.skipIf(process.platform === 'win32')('Android API', () => {
  async function scannedApi(native = fakeNative(), storage = memoryStorage()) {
    const applyFontScale = vi.fn()
    const minimize = vi.fn()
    const api = createAndroidApi({ native, storage, origin: 'https://localhost', applyFontScale, minimize })
    const complete = vi.fn()
    api.onComplete(complete)
    await api.startScan(root, { followLinks: false, skipHidden: false })
    return { api, native, storage, complete, applyFontScale, minimize }
  }

  it('scans, reports completion and remembers the scan', async () => {
    await buildTree()
    const { api, complete } = await scannedApi()
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ rootPath: root, files: 7, totalSpace: 1000 }))
    const children = await api.getChildren(root, { key: 'name', dir: 'asc' })
    expect(children.dirs.map((d) => d.name)).toEqual(['Download', 'Empty', 'Music'])
    expect((await api.getSettings()).recents[0]).toMatchObject({ path: root, files: 7 })
    expect(await api.getMeta()).toMatchObject({ platform: 'android' })
  })

  it('checks arguments and keeps reads inside the scan', async () => {
    await buildTree()
    const outside = path.join(fixture, 'outside.txt')
    await fs.writeFile(outside, 'secret')
    const { api } = await scannedApi()
    await expect(api.getChildren('relative/path', { key: 'size', dir: 'desc' })).rejects.toThrow(/absolute/)
    await expect(api.readFile(outside, 0, 10)).rejects.toThrow(/not part of the current scan/)
    await expect(api.readFile(path.join(root, 'Music'), 0, 10)).rejects.toThrow(/Only files/)
    const chunk = await api.readFile(path.join(root, 'notes.txt'), 6, 100)
    expect(new TextDecoder().decode(chunk.bytes)).toBe('world')
    expect(chunk.size).toBe(11)
  })

  it('deletes only after the system dialog confirms, and never the scan root', async () => {
    await buildTree()
    const { api, native } = await scannedApi()
    const notes = path.join(root, 'notes.txt')

    expect(await api.deleteItems([notes], 'permanent')).toEqual({ mode: 'permanent', deleted: [], failed: [] })
    expect(native.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Delete permanently', detail: expect.stringContaining(JSON.stringify(notes)) })
    )
    await expect(fs.stat(notes)).resolves.toBeTruthy()

    native.confirmed = true
    await expect(api.deleteItems([notes], 'trash')).rejects.toThrow(/no Trash/)
    await expect(api.deleteItems([root], 'permanent')).rejects.toThrow(/scan root/)
    await expect(api.deleteItems([path.join(fixture, 'other')], 'permanent')).rejects.toThrow(/current scan/)
    const result = await api.deleteItems([notes], 'permanent')
    expect(result.deleted).toEqual([notes])
    await expect(fs.stat(notes)).rejects.toThrow()
    expect(await api.getNode(notes)).toBeNull()
  })

  it('opens scanned files and checks they have not changed', async () => {
    await buildTree()
    const { api, native } = await scannedApi()
    const notes = path.join(root, 'notes.txt')
    await api.openPath(notes)
    expect(native.openFile).toHaveBeenCalledWith({ path: notes })
    await fs.rm(notes)
    await fs.writeFile(notes, 'replaced')
    await expect(api.openPath(notes)).rejects.toThrow()
    expect(native.openFile).toHaveBeenCalledOnce()
  })

  it('writes reports in chunks and closes the document', async () => {
    await buildTree()
    const { api, native } = await scannedApi()
    expect(await api.exportReport('json')).toBe('diskgrove-report.json')
    expect(native.exportEnd).toHaveBeenCalledWith({ id: 'doc-1', ok: true })
    expect(JSON.parse(native.exports.get('doc-1') ?? '')).toMatchObject({ scan: { rootPath: root } })

    native.exportId = null
    expect(await api.exportReport('csv')).toBeNull()
  })

  it('builds media URLs on the app origin', async () => {
    const { api } = await scannedApi()
    const url = new URL(api.mediaUrl!('/storage/emulated/0/Movies/a b#1.mp4', 3))
    expect(url.origin).toBe('https://localhost')
    expect(url.pathname).toBe(MEDIA_PATH)
    expect(url.searchParams.get('path')).toBe('/storage/emulated/0/Movies/a b#1.mp4')
    expect(url.searchParams.get('type')).toBe('video/mp4')
    expect(url.searchParams.get('v')).toBe('3')
  })

  it('keeps sanitized settings and applies the font scale', async () => {
    const storage = memoryStorage({ 'diskgrove:settings': '{not json' })
    const { api, applyFontScale } = await scannedApi(fakeNative(), storage)
    expect((await api.getSettings()).theme).toBeDefined()
    const next = await api.setSettings({ fontScale: 110, theme: 'no-such-theme' } as never)
    expect(next.fontScale).toBe(110)
    expect(applyFontScale).toHaveBeenCalledWith(110)
    expect(JSON.parse(storage.data['diskgrove:settings']).theme).not.toBe('no-such-theme')
  })

  it('gives the back button to the newest handler first, then leaves the app', async () => {
    const { api, minimize } = await scannedApi()
    const first = vi.fn(() => true)
    const second = vi.fn(() => false)
    const offFirst = api.onBackButton!(first)
    api.onBackButton!(second)
    expect(api.handleBack()).toBe(true)
    expect(second).toHaveBeenCalledBefore(first)
    offFirst()
    expect(api.handleBack()).toBe(false)
    expect(minimize).toHaveBeenCalledOnce()
  })

  it('shares only scanned files, after checking they have not changed', async () => {
    await buildTree()
    const many = path.join(root, 'many')
    await fs.mkdir(many)
    const manyFiles = Array.from({ length: 101 }, (_, i) => path.join(many, `${i}.txt`))
    await Promise.all(manyFiles.map((f) => fs.writeFile(f, 'x')))
    const { api, native } = await scannedApi()
    const notes = path.join(root, 'notes.txt')
    await expect(api.shareItems!([path.join(root, 'Music')])).rejects.toThrow(/Only files/)
    await expect(api.shareItems!([path.join(fixture, 'elsewhere.txt')])).rejects.toThrow(/current scan/)
    await expect(api.shareItems!(manyFiles)).rejects.toThrow(/between 1 and 100/)
    await api.shareItems!([notes, notes])
    expect(native.shareFiles).toHaveBeenCalledWith({ paths: [notes] })
    await fs.writeFile(notes, 'changed after the scan')
    await expect(api.shareItems!([notes])).rejects.toThrow()
    expect(native.shareFiles).toHaveBeenCalledOnce()
  })
})

describe.skipIf(process.platform === 'win32')('Android features', () => {
  const app = (pkg: string, extra: Partial<InstalledApp> = {}): InstalledApp => ({
    package: pkg,
    label: pkg,
    version: '1.0',
    installed: 1,
    updated: 1,
    system: false,
    updatedSystem: false,
    enabled: true,
    launchable: true,
    self: false,
    apkBytes: 100,
    ...extra
  })

  async function listed(p: string, type: MediaFile['type']): Promise<MediaFile> {
    const st = await fs.stat(p)
    return { path: p, name: path.basename(p), size: st.size, modified: st.mtimeMs, mime: '', type }
  }

  function features(native = fakeNative()) {
    const api = createAndroidApi({ native, storage: memoryStorage(), origin: 'https://localhost' })
    return { api, android: api.android, native }
  }

  it('reports access and asks for more through the system settings', async () => {
    const { android } = features()
    expect(await android.access()).toMatchObject({ files: true, usage: false, sdk: 37 })
    expect(await android.requestUsageAccess()).toMatchObject({ usage: true })
    expect(await android.requestFilesAccess()).toMatchObject({ files: true, usage: true })
  })

  it('acts only on apps from the app list', async () => {
    const native = fakeNative()
    native.apps = [app('com.example.notes', { cacheBytes: 50 }), app('org.sample.game')]
    const { android } = features(native)
    await expect(android.openApp('com.example.notes')).rejects.toThrow(/app list/)
    const list = await android.listApps()
    expect(list.apps.map((a) => a.package)).toEqual(['com.example.notes', 'org.sample.game'])
    await expect(android.openApp('not a package')).rejects.toThrow(/package name/)
    await expect(android.openApp('com.other.app')).rejects.toThrow(/app list/)

    await android.openApp('com.example.notes')
    expect(native.openApp).toHaveBeenCalledWith({ package: 'com.example.notes' })
    expect(await android.appDetails('com.example.notes')).toMatchObject({ cacheBytes: 50 })

    expect(await android.uninstallApp('org.sample.game')).toBeNull()
    expect(native.uninstallApp).toHaveBeenCalledWith({ package: 'org.sample.game' })
    // Once Android reports it gone, the app is no longer something to act on.
    await expect(android.appInfo('org.sample.game')).rejects.toThrow(/app list/)
    expect(await android.clearAppCaches()).toBe(true)
  })

  it('lists files by kind and acts only on listed files', async () => {
    await buildTree()
    const native = fakeNative()
    const song = path.join(root, 'Music', 'song.mp3')
    native.media = [await listed(song, 'audio'), await listed(path.join(root, 'notes.txt'), 'documents')]
    const { android } = features(native)
    await expect(android.mediaFiles('everything' as MediaKind, 10)).rejects.toThrow(/kind of file/)
    await expect(android.openMediaFile(song)).rejects.toThrow(/file list/)

    const audio = await android.mediaFiles('audio', 99999)
    expect(native.mediaFiles).toHaveBeenLastCalledWith({ kind: 'audio', limit: 2000 })
    expect(audio).toMatchObject({ kind: 'audio', count: 1, files: [{ path: song }] })
    await android.openMediaFile(song)
    expect(native.openFile).toHaveBeenCalledWith({ path: song })
    await android.shareMediaFiles([song])
    expect(native.shareFiles).toHaveBeenCalledWith({ paths: [song] })
    await expect(android.shareMediaFiles([path.join(root, 'notes.txt')])).rejects.toThrow(/file list/)
    expect((await android.mediaSummary()).audio).toEqual({ count: 1, bytes: audio.bytes })
  })

  it('deletes listed files only after the system dialog confirms, and skips files that changed', async () => {
    await buildTree()
    const native = fakeNative()
    const song = path.join(root, 'Music', 'song.mp3')
    const copy = path.join(root, 'Music', 'Albums', 'copy.mp3')
    native.media = [await listed(song, 'audio'), await listed(copy, 'audio')]
    const { android } = features(native)
    await android.mediaFiles('audio', 10)

    expect(await android.deleteMediaFiles([song])).toEqual({ mode: 'permanent', deleted: [], failed: [] })
    expect(native.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete permanently' }))
    await expect(fs.stat(song)).resolves.toBeTruthy()

    native.confirmed = true
    await fs.writeFile(copy, 'this file grew after it was listed')
    const result = await android.deleteMediaFiles([song, copy])
    expect(result.deleted).toEqual([song])
    expect(result.failed).toEqual([{ path: copy, error: expect.stringMatching(/changed/) }])
    await expect(fs.stat(song)).rejects.toThrow()
    await expect(fs.stat(copy)).resolves.toBeTruthy()
    // A deleted file leaves the list it came from.
    await expect(android.openMediaFile(song)).rejects.toThrow(/file list/)
  })

  it('deletes scanned files through the scan, so its totals stay right', async () => {
    await buildTree()
    const native = fakeNative()
    const notes = path.join(root, 'notes.txt')
    native.media = [await listed(notes, 'documents')]
    const { api, android } = features(native)
    await api.startScan(root, { followLinks: false, skipHidden: false })
    const before = (await api.getNode(root))!.size
    await android.mediaFiles('documents', 10)
    native.confirmed = true
    expect((await android.deleteMediaFiles([notes])).deleted).toEqual([notes])
    expect(await api.getNode(notes)).toBeNull()
    expect((await api.getNode(root))!.size).toBe(before - 11)
  })

  it('builds icon and thumbnail URLs on the app origin', () => {
    const { android } = features()
    const icon = new URL(android.iconUrl('com.example.notes'))
    expect(icon.origin).toBe('https://localhost')
    expect(icon.pathname).toBe(ICON_PATH)
    expect(icon.searchParams.get('package')).toBe('com.example.notes')
    expect(() => android.iconUrl('../etc')).toThrow(/package name/)

    const photo = { path: '/storage/emulated/0/DCIM/a b#1.jpg', mime: 'image/jpeg', type: 'images' } as const
    const thumb = new URL(android.thumbnailUrl(photo)!)
    expect(thumb.pathname).toBe(THUMB_PATH)
    expect(thumb.searchParams.get('path')).toBe(photo.path)
    expect(thumb.searchParams.get('type')).toBe('image/jpeg')
    expect(
      new URL(android.thumbnailUrl({ path: '/x/clip.bin', mime: '', type: 'videos' })!).searchParams.get('type')
    ).toBe('video/*')
    expect(android.thumbnailUrl({ path: '/x/a.pdf', mime: 'application/pdf', type: 'documents' })).toBeNull()
  })
})

describe('platform wording', () => {
  it('describes what each platform can do with items', () => {
    expect(canOpenFolders('android')).toBe(false)
    expect(canOpenFolders('darwin')).toBe(true)
    expect(revealLabel('android')).toBeNull()
    expect(revealLabel('darwin')).toBe('Reveal in Finder')
    expect(trashName('android')).toBeNull()
    expect(trashName('win32')).toBe('Recycle Bin')
    expect(trashName('linux')).toBe('Trash')
  })
})

describe('app usage', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.UTC(2026, 0, 31)
  const app = (over: Partial<InstalledApp>): InstalledApp => ({
    package: 'com.example',
    label: 'Example',
    version: '1',
    installed: now - 400 * DAY,
    updated: now - 400 * DAY,
    system: false,
    updatedSystem: false,
    enabled: true,
    launchable: true,
    self: false,
    apkBytes: 10,
    ...over
  })

  it('counts an app unopened since a recent install as recently active', () => {
    const fresh = app({ installed: now - DAY, lastUsed: 0 })
    expect(lastActive(fresh)).toBe(now - DAY)
    expect(unusedFor(fresh, 30, now)).toBe(false)
    expect(lastUsedText(fresh, now)).toBe('Not since it was installed')
    expect(unusedFor(app({ lastUsed: 0 }), 30, now)).toBe(true)
    expect(lastUsedText(app({ installed: now - 900 * DAY, lastUsed: 0 }), now)).toBe('Not in the last 2 years')
  })

  it('knows nothing about use without usage access', () => {
    expect(lastActive(app({}))).toBeUndefined()
    expect(unusedFor(app({}), 1, now)).toBe(false)
    expect(lastUsedText(app({}), now)).toBe('Unknown')
  })

  it('describes the last use and totals the app', () => {
    expect(lastUsedText(app({ lastUsed: now - 3 * DAY }), now)).toBe('3 days ago')
    expect(lastUsedText(app({ lastUsed: now - 2 * DAY + 1 }), now)).toBe('Yesterday')
    expect(lastUsedText(app({ lastUsed: now - 61 * DAY }), now)).toBe('2 months ago')
    expect(unusedFor(app({ lastUsed: now - 31 * DAY }), 30, now)).toBe(true)
    expect(appTotal(app({}))).toBe(10)
    expect(appTotal(app({ appBytes: 5, dataBytes: 3, cacheBytes: 2 }))).toBe(10)
  })
})

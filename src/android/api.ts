import { MAX_PREVIEW_READ, mediaTypeOf } from '@shared/preview'
import { DEFAULT_SETTINGS, sanitizeSettings, withRecent } from '@shared/settings'
import type {
  AndroidFeatures,
  AppSettings,
  DiskGroveAPI,
  DriveInfo,
  DupProgress,
  NodeSummary,
  ScanComplete,
  ScanProgress
} from '@shared/types'
import { describeFileAction } from '../main/confirm-text'
import { OperationGate } from '../main/operations'
import { reportParts } from '../main/report'
import {
  asDeleteMode,
  asFileGroup,
  asFormat,
  asInt,
  asNumber,
  asOptionalPath,
  asPath,
  asPathList,
  asQuery,
  asScanOptions,
  asSort
} from '../main/validate'
import { statsOf, type DiskGroveNativePlugin } from './native-api'
import { createAndroidFeatures, MAX_SHARE_FILES } from './features'
import { AndroidScanner, resolveScanRoot } from './scanner'

/** The path the app's WebView serves scanned media from; MainActivity answers these requests. */
export const MEDIA_PATH = '/_diskgrove_media_'

const SETTINGS_KEY = 'diskgrove:settings'
// Reports reach the native side as strings; this keeps each bridge message small.
const EXPORT_CHUNK = 256 * 1024

const REPORT_TYPES = { csv: 'text/csv', json: 'application/json', html: 'text/html' } as const

class Emitter<T> {
  private listeners: Array<(payload: T) => void> = []

  on(listener: (payload: T) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  emit(payload: T): void {
    for (const listener of [...this.listeners]) listener(payload)
  }
}

export interface SettingsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Settings kept in the WebView's local storage, checked the same way desktop checks its settings file. */
export class SettingsStore {
  private cache: AppSettings | null = null

  constructor(private readonly storage: SettingsStorage) {}

  load(): AppSettings {
    if (this.cache) return this.cache
    let next: AppSettings
    try {
      const raw = this.storage.getItem(SETTINGS_KEY)
      next = raw ? sanitizeSettings(JSON.parse(raw), DEFAULT_SETTINGS) : { ...DEFAULT_SETTINGS }
    } catch {
      next = { ...DEFAULT_SETTINGS }
    }
    this.cache = next
    return next
  }

  save(partial: unknown): AppSettings {
    const next = sanitizeSettings(partial, this.load())
    this.storage.setItem(SETTINGS_KEY, JSON.stringify(next))
    this.cache = next
    return next
  }
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export interface AndroidApiOptions {
  native: DiskGroveNativePlugin
  storage: SettingsStorage
  /** Origin of the app's pages, such as https://localhost. */
  origin: string
  /** Shows the page at `scale` percent. */
  applyFontScale?: (scale: number) => void
  /** Sends the app to the background, when nothing on screen took a back press. */
  minimize?: () => void
}

/**
 * The DiskGrove API for the Android app. It runs in the WebView next to the renderer, and checks what
 * it is given just as the desktop main process checks IPC calls.
 */
export function createAndroidApi(options: AndroidApiOptions): DiskGroveAPI & {
  scanner: AndroidScanner
  android: AndroidFeatures
  /** Runs the back-button handlers; returns whether one of them took the press. */
  handleBack(): boolean
  /** Tells the page the user came back to the app. */
  handleResume(): void
} {
  const { native, origin, applyFontScale, minimize } = options
  const store = new SettingsStore(options.storage)
  const scanner = new AndroidScanner(native)
  const operations = new OperationGate()
  let lastComplete: ScanComplete | null = null

  const progress = new Emitter<ScanProgress>()
  const complete = new Emitter<ScanComplete>()
  const dupProgress = new Emitter<DupProgress>()
  const resumed = new Emitter<void>()
  let backHandlers: Array<() => boolean> = []

  scanner.onProgress = (p) => progress.emit(p)
  scanner.onComplete = (r) => complete.emit(r)
  scanner.onDupProgress = (p) => dupProgress.emit(p)

  function scannedNode(target: unknown): NodeSummary {
    const node = scanner.getNode(asPath(target))
    if (!node) throw new Error('That item is not part of the current scan')
    return node
  }

  function scannedFile(target: unknown): NodeSummary {
    const node = scannedNode(target)
    if (node.kind !== 'file') throw new Error('Only files can be previewed')
    return node
  }

  async function volumeRoots(): Promise<Set<string>> {
    try {
      return new Set((await native.volumes()).volumes.map((v) => v.path))
    } catch {
      return new Set()
    }
  }

  async function spaceAt(target: string): Promise<{ total: number; free: number; volumeRoot: boolean }> {
    const roots = await volumeRoots()
    const volumeRoot = roots.has(target) || roots.has(scanner.getRootPath())
    try {
      const { total, free } = await native.space({ path: target })
      return { total, free, volumeRoot }
    } catch {
      return { total: 0, free: 0, volumeRoot }
    }
  }

  function scanChanged(): void {
    if (!lastComplete) return
    lastComplete = scanner.finish({
      total: lastComplete.totalSpace,
      free: lastComplete.freeSpace,
      volumeRoot: lastComplete.isVolumeRoot
    })
  }

  const android = createAndroidFeatures({
    native,
    origin,
    operations,
    scanner,
    scanChanged,
    onResume: (cb) => resumed.on(cb)
  })

  return {
    scanner,

    handleBack() {
      for (const handler of [...backHandlers].reverse()) if (handler()) return true
      minimize?.()
      return false
    },

    handleResume() {
      resumed.emit()
    },

    async getMeta() {
      return { platform: 'android', home: (await native.home()).path }
    },

    async listDrives(): Promise<DriveInfo[]> {
      const { volumes } = await native.volumes()
      return volumes.map((v) => ({
        path: v.path,
        label: v.label,
        name: v.path,
        fsType: '',
        total: v.total,
        free: v.free,
        used: Math.max(0, v.total - v.free),
        kind: v.removable ? 'removable' : 'fixed'
      }))
    },

    async pickFolder() {
      return (await native.pickFolder()).path
    },

    async resolveScanRoot(target) {
      return resolveScanRoot(native, asPath(target))
    },

    startScan: (target, scanOptions) =>
      operations.run('the scan', async () => {
        const root = asPath(target)
        const opts = asScanOptions(scanOptions)
        lastComplete = null
        await scanner.start(root, opts)
        lastComplete = scanner.finish(await spaceAt(root))
        // A stopped scan's totals are partial; keep them out of the recent list.
        if (lastComplete.cancelled) return
        const recents = withRecent(store.load().recents, {
          path: lastComplete.rootPath,
          scannedAt: Date.now(),
          size: lastComplete.bytes,
          files: lastComplete.files
        })
        store.save({ recents })
      }),

    async cancelScan() {
      scanner.cancel()
    },

    getChildren: async (target, sort) => scanner.getChildren(asPath(target), asSort(sort)),
    getNode: async (target) => scanner.getNode(asPath(target)),
    getTopFiles: (target, limit) => scanner.getTopFiles(asOptionalPath(target), asInt(limit, 1, 5000, 200)),
    getExtensions: (target) => scanner.getExtensions(asOptionalPath(target)),
    getAgeStats: (target) => scanner.getAgeStats(asOptionalPath(target)),
    getGroupFiles: (group, target, limit) =>
      scanner.getGroupFiles(asFileGroup(group), asOptionalPath(target), asInt(limit, 1, 5000, 2000)),
    getTreemap: async (target, maxDepth, minPercent) =>
      scanner.getTreemap(asPath(target), asInt(maxDepth, 1, 12, 3), asNumber(minPercent, 0, 100, 0)),
    search: (query, target, limit) =>
      scanner.search(asQuery(query), asOptionalPath(target), asInt(limit, 1, 2000, 400)),
    getUnreadable: async (limit) => scanner.getUnreadable(asInt(limit, 1, 5000, 1000)),
    findDuplicates: (target) =>
      operations.run('duplicate detection', () => scanner.findDuplicates(asOptionalPath(target))),
    async cancelDuplicates() {
      scanner.cancelDuplicates()
    },

    // The system app chooser is the confirmation here: nothing opens until an app is picked there.
    openPath: (target) =>
      operations.run('opening the item', async () => {
        const node = scannedNode(target)
        await scanner.assertCurrent(node.path, 'act')
        await native.openFile({ path: node.path })
      }),

    async revealPath() {
      throw new Error('Android has no file manager view to show items in')
    },

    // The share sheet is the confirmation here: nothing is sent until the user picks an app there.
    shareItems: (targets) =>
      operations.run('sharing', async () => {
        const nodes = [...new Set(asPathList(targets))].map((p) => scannedNode(p))
        if (nodes.some((n) => n.kind !== 'file')) throw new Error('Only files can be shared')
        if (nodes.length === 0 || nodes.length > MAX_SHARE_FILES) {
          throw new Error(`Share between 1 and ${MAX_SHARE_FILES} files at a time`)
        }
        for (const node of nodes) await scanner.assertCurrent(node.path, 'act')
        await native.shareFiles({ paths: nodes.map((n) => n.path) })
      }),

    async readFile(target, offset, length) {
      const node = scannedFile(target)
      await scanner.assertCurrent(node.path, 'read')
      const chunk = await native.readFile({
        path: node.path,
        offset: asInt(offset, 0, Number.MAX_SAFE_INTEGER, 0),
        length: asInt(length, 0, MAX_PREVIEW_READ, 0)
      })
      return { bytes: decodeBase64(chunk.data), offset: chunk.offset, size: chunk.size }
    },

    async getItemTimes(target) {
      const node = scannedNode(target)
      await scanner.assertCurrent(node.path, 'read')
      const { results } = await native.statMany({ paths: [node.path], follow: false })
      const stats = statsOf(results[0], node.path)
      return { created: stats.birthtimeMs, modified: stats.mtimeMs, accessed: stats.atimeMs }
    },

    deleteItems: (targets, mode) =>
      operations.run('deletion', async () => {
        const paths = [...new Set(asPathList(targets))].map((p) => scannedNode(p).path)
        const deleteMode = asDeleteMode(mode)
        if (paths.includes(scanner.getRootPath())) throw new Error('Cannot delete the scan root')
        if (deleteMode === 'trash')
          throw new Error('Android has no Trash for these files. Delete them permanently instead.')
        const { label, message, detail } = describeFileAction(paths, deleteMode)
        const { confirmed } = await native.confirm({ title: label, message, detail, confirm: label })
        if (!confirmed) return { mode: deleteMode, deleted: [], failed: [] }
        const result = await scanner.deleteMany(paths, deleteMode)
        scanChanged()
        return result
      }),

    exportReport: (format) =>
      operations.run('the export', async () => {
        const fmt = asFormat(format)
        const root = scanner.getRootPath()
        if (!root) return null
        const [extensions, topFiles, age] = await Promise.all([
          scanner.getExtensions(root),
          scanner.getTopFiles(root, 50),
          scanner.getAgeStats(root)
        ])
        const { id, name } = await native.exportBegin({ name: `diskgrove-report.${fmt}`, type: REPORT_TYPES[fmt] })
        if (!id) return null
        let ok = false
        try {
          let buffer = ''
          for (const part of reportParts(scanner, lastComplete, extensions, topFiles, age, fmt)) {
            buffer += part
            if (buffer.length >= EXPORT_CHUNK) {
              await native.exportWrite({ id, data: buffer })
              buffer = ''
            }
          }
          if (buffer) await native.exportWrite({ id, data: buffer })
          ok = true
        } finally {
          await native.exportEnd({ id, ok })
        }
        return name
      }),

    async getSettings() {
      return store.load()
    },

    async setSettings(partial) {
      const next = store.save(partial)
      applyFontScale?.(next.fontScale)
      return next
    },

    onSettingsChanged: () => () => undefined,
    onProgress: (cb) => progress.on(cb),
    onComplete: (cb) => complete.on(cb),
    onError: () => () => undefined,
    onDupProgress: (cb) => dupProgress.on(cb),

    async minimize() {
      minimize?.()
    },
    toggleMaximize: async () => false,
    async closeWindow() {},
    isMaximized: async () => false,
    onMaximized: () => () => undefined,
    isFullScreen: async () => false,
    onFullScreen: () => () => undefined,

    mediaUrl(target, version) {
      const params = new URLSearchParams({
        path: target,
        type: mediaTypeOf(target) ?? 'application/octet-stream',
        v: String(version)
      })
      return `${origin}${MEDIA_PATH}?${params}`
    },

    onBackButton(cb) {
      backHandlers.push(cb)
      return () => {
        backHandlers = backHandlers.filter((h) => h !== cb)
      }
    },

    android
  }
}

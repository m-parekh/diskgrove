import type {
  AndroidFeatures,
  DeleteResult,
  InstalledApp,
  MediaCollection,
  MediaFile,
  MediaKind,
  MediaType
} from '@shared/types'
import { describeFileAction } from '../main/confirm-text'
import type { OperationGate } from '../main/operations'
import { asInt, asPath, asPathList, IpcArgumentError } from '../main/validate'
import { statsOf, type DiskGroveNativePlugin } from './native-api'
import type { AndroidScanner } from './scanner'

/** The paths the app's WebView serves thumbnails and app icons from; MediaWebViewClient answers them. */
export const THUMB_PATH = '/_diskgrove_thumb_'
export const ICON_PATH = '/_diskgrove_icon_'

export const MEDIA_TYPES: readonly MediaType[] = ['images', 'videos', 'audio', 'documents', 'archives', 'apks', 'other']
export const MEDIA_COLLECTIONS: readonly MediaCollection[] = [
  'downloads',
  'screenshots',
  'oldScreenshots',
  'large',
  'trash'
]
const MEDIA_KINDS: ReadonlySet<string> = new Set([...MEDIA_TYPES, ...MEDIA_COLLECTIONS])
/** The most files one mediaFiles call lists; the native side caps it too. */
export const MAX_MEDIA_FILES = 2000
/** The most files one share sheet takes; DiskGroveNativePlugin.shareFiles refuses more. */
export const MAX_SHARE_FILES = 100

// Matches isPackageName in AppsInspector.java.
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/
const S_IFMT = 0o170000
const S_IFREG = 0o100000

export function isPackageName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && PACKAGE_NAME.test(value)
}

function asMediaKind(value: unknown): MediaKind {
  if (typeof value !== 'string' || !MEDIA_KINDS.has(value)) throw new IpcArgumentError('unknown kind of file')
  return value as MediaKind
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface AndroidFeatureOptions {
  native: DiskGroveNativePlugin
  origin: string
  operations: OperationGate
  scanner: AndroidScanner
  /** Recomputes the scan's totals after items were deleted from it. */
  scanChanged: () => void
  onResume: (cb: () => void) => () => void
}

/**
 * Android's own features. Like the rest of the API, they act only on what the app listed itself: apps
 * from the last app list, and files from the media lists it handed out.
 */
export function createAndroidFeatures(options: AndroidFeatureOptions): AndroidFeatures {
  const { native, origin, operations, scanner, scanChanged, onResume } = options
  let knownApps = new Set<string>()
  // The last list of each kind, so a file stays usable while any open list shows it.
  const listed = new Map<MediaKind, Map<string, MediaFile>>()

  function knownApp(value: unknown): string {
    if (!isPackageName(value)) throw new IpcArgumentError('expected a package name')
    if (!knownApps.has(value)) throw new Error('That app is not in the app list')
    return value
  }

  function listedFile(path: string): MediaFile {
    for (const files of listed.values()) {
      const file = files.get(path)
      if (file) return file
    }
    throw new Error('That file is not in a file list')
  }

  function forget(paths: string[]): void {
    for (const files of listed.values()) for (const path of paths) files.delete(path)
  }

  async function app(pkg: string, call: Promise<{ app: InstalledApp | null }>): Promise<InstalledApp | null> {
    const result = (await call).app ?? null
    if (!result) knownApps.delete(pkg)
    return result
  }

  /** Removes listed files the scan does not cover, after checking each is still the file that was listed. */
  async function removeUnscanned(files: MediaFile[], result: DeleteResult): Promise<void> {
    if (files.length === 0) return
    const { results } = await native.statMany({ paths: files.map((f) => f.path), follow: false })
    for (const [i, file] of files.entries()) {
      try {
        const stats = statsOf(results[i], file.path)
        if ((stats.mode & S_IFMT) !== S_IFREG || stats.size !== file.size)
          throw new Error('This file changed after it was listed. Refresh the list and try again.')
        await native.remove({ path: file.path })
        result.deleted.push(file.path)
      } catch (err) {
        result.failed.push({ path: file.path, error: errorText(err) })
      }
    }
  }

  return {
    access: () => native.accessStatus(),

    async requestFilesAccess() {
      await native.requestStorageAccess()
      return native.accessStatus()
    },

    requestUsageAccess: () => native.requestUsageAccess(),

    deviceStorage: () => native.deviceStorage(),

    async listApps() {
      const list = await native.listApps()
      knownApps = new Set(list.apps.map((a) => a.package))
      return list
    },

    async appInfo(pkg) {
      const name = knownApp(pkg)
      return app(name, native.appInfo({ package: name }))
    },

    async openApp(pkg) {
      await native.openApp({ package: knownApp(pkg) })
    },

    async appDetails(pkg) {
      const name = knownApp(pkg)
      return app(name, native.appDetails({ package: name }))
    },

    // Android's uninstall dialog is the confirmation: nothing is removed unless the user confirms there.
    async uninstallApp(pkg) {
      const name = knownApp(pkg)
      return app(name, native.uninstallApp({ package: name }))
    },

    async clearAppCaches() {
      return (await native.clearAppCaches()).cleared
    },

    manageStorage: () => native.manageStorage(),

    mediaSummary: () => native.mediaSummary(),

    async mediaFiles(kind, limit) {
      const which = asMediaKind(kind)
      const result = await native.mediaFiles({ kind: which, limit: asInt(limit, 1, MAX_MEDIA_FILES, 200) })
      listed.set(which, new Map(result.files.map((f) => [f.path, f])))
      return { kind: which, count: result.count, bytes: result.bytes, files: result.files }
    },

    // The system app chooser is the confirmation here: nothing opens until an app is picked there.
    async openMediaFile(path) {
      await native.openFile({ path: listedFile(asPath(path)).path })
    },

    async shareMediaFiles(paths) {
      const files = [...new Set(asPathList(paths))].map((p) => listedFile(p).path)
      if (files.length === 0 || files.length > MAX_SHARE_FILES) {
        throw new IpcArgumentError(`Share between 1 and ${MAX_SHARE_FILES} files at a time`)
      }
      await native.shareFiles({ paths: files })
    },

    deleteMediaFiles: (paths) =>
      operations.run('deletion', async () => {
        const files = [...new Set(asPathList(paths))].map((p) => listedFile(p))
        const targets = files.map((f) => f.path)
        const { label, message, detail } = describeFileAction(targets, 'permanent')
        const { confirmed } = await native.confirm({ title: label, message, detail, confirm: label })
        const result: DeleteResult = { mode: 'permanent', deleted: [], failed: [] }
        if (!confirmed) return result
        // Files in the current scan go through it, so its totals and lists stay right.
        const scanned = files.filter((f) => scanner.getNode(f.path)?.kind === 'file')
        const others = files.filter((f) => !scanned.includes(f))
        if (scanned.length > 0) {
          const fromScan = await scanner.deleteMany(
            scanned.map((f) => f.path),
            'permanent'
          )
          result.deleted.push(...fromScan.deleted)
          result.failed.push(...fromScan.failed)
          if (fromScan.deleted.length > 0) scanChanged()
        }
        await removeUnscanned(others, result)
        forget(result.deleted)
        return result
      }),

    iconUrl(pkg) {
      if (!isPackageName(pkg)) throw new IpcArgumentError('expected a package name')
      return `${origin}${ICON_PATH}?${new URLSearchParams({ package: pkg })}`
    },

    thumbnailUrl(file) {
      if (file.type !== 'images' && file.type !== 'videos') return null
      const family = file.type === 'images' ? 'image/' : 'video/'
      const type = file.mime.startsWith(family) ? file.mime : `${family}*`
      return `${origin}${THUMB_PATH}?${new URLSearchParams({ path: asPath(file.path), type })}`
    },

    onResume
  }
}

import type { EntryStats } from '../main/file-identity'
import type {
  AndroidAccess,
  AppList,
  DeviceStorage,
  InstalledApp,
  MediaFile,
  MediaKind,
  MediaSummary
} from '@shared/types'

/** What lstat or stat reported, as numbers the shared identity checks compare. */
export interface NativeStats extends EntryStats {
  blocks: number
}

/** One item of a folder listing. */
export interface NativeEntry {
  name: string
  /** The entry's own lstat; absent when `error` is set. */
  lstat?: NativeStats
  /** Where a link leads, given only while following links. */
  stat?: NativeStats
  /** The errno name (EACCES, ELOOP…) when the entry could not be read. */
  error?: string
}

export interface NativeListing {
  entries: NativeEntry[]
  /** The folder's canonical location, given only while following links. */
  realPath?: string
}

export type NativeStatResult = { stats: NativeStats } | { error: string }

export interface NativeVolume {
  path: string
  label: string
  primary: boolean
  removable: boolean
  total: number
  free: number
}

export interface DiskGroveNativePlugin {
  /** Lists `path`, with the lstat of every entry. Rejects with the errno name as its code. */
  listDir(options: { path: string; followLinks: boolean }): Promise<NativeListing>
  /** lstat (or with `follow`, stat) of each path, in order. */
  statMany(options: { paths: string[]; follow: boolean }): Promise<{ results: NativeStatResult[] }>
  realPath(options: { path: string }): Promise<{ path: string }>
  /** SHA-256 of all of a file, or of its head and tail, with fstat before and after reading it. */
  hashFile(options: {
    path: string
    size: number
    mode: 'sample' | 'full'
    head: number
    tail: number
  }): Promise<{ hash: string; before: NativeStats; after: NativeStats }>
  /** Stops every hash running now. */
  cancelHashes(): Promise<void>
  /** Deletes a file, link or folder tree for good. Links are removed, never followed. */
  remove(options: { path: string }): Promise<void>
  volumes(): Promise<{ volumes: NativeVolume[] }>
  space(options: { path: string }): Promise<{ total: number; free: number }>
  /** The folder picked in the system picker, as a filesystem path; null when cancelled or not a local folder. */
  pickFolder(): Promise<{ path: string | null }>
  /** Offers the file to the apps that can view it. */
  openFile(options: { path: string }): Promise<void>
  /** Up to `length` bytes of a regular file from `offset`, base64 encoded. */
  readFile(options: {
    path: string
    offset: number
    length: number
  }): Promise<{ data: string; offset: number; size: number }>
  /** A system confirmation dialog; resolves true only when the confirm button was pressed. */
  confirm(options: { title: string; message: string; detail: string; confirm: string }): Promise<{ confirmed: boolean }>
  /** Asks where to save a new document; null when cancelled. */
  exportBegin(options: { name: string; type: string }): Promise<{ id: string | null; name: string }>
  exportWrite(options: { id: string; data: string }): Promise<void>
  /** Closes the document, deleting it when `ok` is false. */
  exportEnd(options: { id: string; ok: boolean }): Promise<void>
  /** Whether the app may read and write all of shared storage. */
  storageAccess(): Promise<{ granted: boolean }>
  /** Sends the user to grant storage access; resolves with the outcome. */
  requestStorageAccess(): Promise<{ granted: boolean }>
  /** Primary shared storage, such as /storage/emulated/0. */
  home(): Promise<{ path: string }>
  /** Colours the area behind the status and navigation bars, with icons that suit it. */
  setWindowColors(options: { background: string; dark: boolean }): Promise<void>

  /** What the user has granted, and what this Android version offers. */
  accessStatus(): Promise<AndroidAccess>
  /** Opens the usage access switch; resolves with the access once the user is back. */
  requestUsageAccess(): Promise<AndroidAccess>
  deviceStorage(): Promise<DeviceStorage>
  listApps(): Promise<AppList>
  /** null when the app is not installed. */
  appInfo(options: { package: string }): Promise<{ app: InstalledApp | null }>
  openApp(options: { package: string }): Promise<void>
  /** The system App info page; resolves with the app's figures once the user is back. */
  appDetails(options: { package: string }): Promise<{ app: InstalledApp | null }>
  /** Android's uninstall dialog; resolves with the app, or null once it was removed. */
  uninstallApp(options: { package: string }): Promise<{ app: InstalledApp | null }>
  /** Android's dialog for clearing every app's cache in shared storage. */
  clearAppCaches(): Promise<{ cleared: boolean }>
  /** The system's free-up-space screen; resolves once the user is back. */
  manageStorage(): Promise<void>
  mediaSummary(): Promise<MediaSummary>
  /** The largest `limit` files of a kind, with the count and size of all of them. */
  mediaFiles(options: { kind: MediaKind; limit: number }): Promise<{ count: number; bytes: number; files: MediaFile[] }>
  /** Offers regular files to other apps through the share sheet. */
  shareFiles(options: { paths: string[] }): Promise<void>
}

/** The error a failed stat reported, carrying its errno name like Node's errors do. */
export class NativeFsError extends Error {
  constructor(
    readonly code: string,
    readonly path: string
  ) {
    super(`${code}: ${path}`)
    this.name = 'NativeFsError'
  }
}

export function statsOf(result: NativeStatResult | undefined, path: string): NativeStats {
  if (!result) throw new NativeFsError('EIO', path)
  if ('error' in result) throw new NativeFsError(result.error, path)
  return result.stats
}

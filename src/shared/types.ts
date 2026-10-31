import type { ThemeMode } from './themes'

export type { ThemeMode }

export type NodeKind = 'file' | 'dir'

export type DriveKind = 'fixed' | 'removable' | 'network' | 'optical' | 'unknown'

export type RightTab =
  'details' | 'treemap' | 'pie' | 'bar' | 'extensions' | 'topfiles' | 'age' | 'duplicates' | 'search'

export type SortKey = 'name' | 'size' | 'allocated' | 'files' | 'folders' | 'mtime' | 'percent'

export type SortDir = 'asc' | 'desc'

export type DeleteMode = 'trash' | 'permanent'

/** `folder` searches the folder selected in the tree; `all` searches the whole scan. */
export type SearchScope = 'folder' | 'all'

export interface DriveInfo {
  path: string
  label: string
  name: string
  fsType: string
  total: number
  free: number
  used: number
  kind: DriveKind
}

export interface NodeSummary {
  path: string
  name: string
  kind: NodeKind
  size: number
  allocated: number
  mtime: number
  atime: number
  ctime: number
  fileCount: number
  folderCount: number
  ext: string
  parentPath: string | null
  hasSubdirs: boolean
  unreadable?: boolean
}

export interface ChildrenResult {
  dirs: NodeSummary[]
  files: NodeSummary[]
  parent: NodeSummary | null
}

export interface SortSpec {
  key: SortKey
  dir: SortDir
}

export interface ScanProgress {
  running: boolean
  rootPath: string
  files: number
  folders: number
  bytes: number
  allocated: number
  unreadable: number
  currentPath: string
  elapsedMs: number
}

export interface ScanComplete {
  rootPath: string
  files: number
  folders: number
  bytes: number
  allocated: number
  unreadable: number
  elapsedMs: number
  freeSpace: number
  totalSpace: number
  /** Scan root is a whole drive or mount, so its free space belongs in the charts. */
  isVolumeRoot: boolean
  /** The scan was stopped early, so the totals cover only what it reached. */
  cancelled: boolean
}

export interface ExtensionStat {
  ext: string
  category: string
  count: number
  size: number
  percent: number
}

export interface AgeBucket {
  id: string
  label: string
  count: number
  size: number
  percent: number
}

/** The files behind one row of the File types or File age view. */
export type FileGroup = { by: 'ext'; ext: string } | { by: 'age'; id: string }

export interface TreemapNode {
  path: string
  name: string
  kind: NodeKind
  value: number
  ext: string
  children?: TreemapNode[]
}

export interface SearchResult {
  /** The folder that was searched, subfolders included. */
  root: string
  /** The largest matches, at most the requested number. */
  hits: NodeSummary[]
  /** Every match in the folder, including those beyond the limit. */
  total: number
}

export interface UnreadableItem {
  path: string
  kind: NodeKind
  folder: string
  code: string
}

export interface UnreadableList {
  folders: number
  files: number
  /** The first ones found, at most the requested number. */
  items: UnreadableItem[]
}

export interface DuplicateFile {
  path: string
  name: string
  mtime: number
}

export interface DuplicateGroup {
  hash: string
  size: number
  count: number
  wasted: number
  files: DuplicateFile[]
}

export interface DeleteFailure {
  path: string
  error: string
}

export interface DeleteResult {
  mode: DeleteMode
  deleted: string[]
  failed: DeleteFailure[]
}

export interface RecentScan {
  path: string
  scannedAt: number
  size: number
  files: number
}

export interface AppSettings {
  theme: ThemeMode
  followLinks: boolean
  skipHidden: boolean
  showFreeSpace: boolean
  showPreview: boolean
  fontScale: number
  searchScope: SearchScope
  recents: RecentScan[]
}

export interface AppMeta {
  platform: string
  home: string
}

export interface FileChunk {
  bytes: Uint8Array
  offset: number
  size: number
}

export interface ItemTimes {
  created: number
  modified: number
  accessed: number
}

export interface DupProgress {
  phase: 'grouping' | 'hashing' | 'done' | 'cancelled'
  hashed: number
  total: number
}

/** What the user has let DiskGrove reach on Android, and what this Android version offers. */
export interface AndroidAccess {
  sdk: number
  /** All files access from Android 11; the storage permission before it. */
  files: boolean
  /** All files access is a switch in the system settings (Android 11+), not a permission prompt. */
  allFilesSetting: boolean
  /** Usage access: other apps' storage figures and when each app was last used. */
  usage: boolean
  /** Android reports app, data and cache sizes (8.0+). */
  appSizes: boolean
  /** Every installed app is visible, not only those Android shows any app. Granted at install. */
  packages: boolean
  /** May hand apps to Android's uninstall dialog. Granted at install. */
  uninstall: boolean
  /** Android can clear every app's cache in shared storage at the user's request (11+). */
  clearCache: boolean
}

export interface InstalledApp {
  package: string
  label: string
  version: string
  installed: number
  updated: number
  system: boolean
  /** A preinstalled app with an update on top, which uninstalling removes. */
  updatedSystem: boolean
  enabled: boolean
  launchable: boolean
  /** DiskGrove itself. */
  self: boolean
  /** Size of the app's APK files; known without usage access. */
  apkBytes: number
  /** The rest are known only with usage access, except for DiskGrove itself. */
  appBytes?: number
  /** User data, not counting the cache. */
  dataBytes?: number
  cacheBytes?: number
  /** The part of the cache kept in shared storage (Android 12+). */
  externalCacheBytes?: number
  /** When the app was last used; 0 when not in about two years; absent without usage access. */
  lastUsed?: number
}

export interface AppList {
  apps: InstalledApp[]
  usageAccess: boolean
}

/** Every file in shared storage has one of these types. */
export type MediaType = 'images' | 'videos' | 'audio' | 'documents' | 'archives' | 'apks' | 'other'
/** Groups of files across types. */
export type MediaCollection = 'downloads' | 'screenshots' | 'oldScreenshots' | 'large' | 'trash'
export type MediaKind = MediaType | MediaCollection

export interface FileTotal {
  count: number
  bytes: number
}

export type MediaSummary = Record<MediaKind, FileTotal>

export interface MediaFile {
  path: string
  name: string
  size: number
  modified: number
  mime: string
  type: MediaType
}

/** The largest files of a kind, with the count and size of all of them. */
export interface MediaFileList extends FileTotal {
  kind: MediaKind
  files: MediaFile[]
}

export interface DeviceStorage {
  total: number
  free: number
}

/** Features only the Android app has: installed apps, the media index and the system's storage tools. */
export interface AndroidFeatures {
  access(): Promise<AndroidAccess>
  /** Opens the system's all files access switch (or the permission prompt) and reports what was chosen. */
  requestFilesAccess(): Promise<AndroidAccess>
  /** Opens the system's usage access switch and reports what was chosen. */
  requestUsageAccess(): Promise<AndroidAccess>
  deviceStorage(): Promise<DeviceStorage>
  listApps(): Promise<AppList>
  /** The app's current figures; null once it is uninstalled. */
  appInfo(pkg: string): Promise<InstalledApp | null>
  openApp(pkg: string): Promise<void>
  /** Shows the system's App info page; resolves with the app's figures once the user comes back. */
  appDetails(pkg: string): Promise<InstalledApp | null>
  /** Shows Android's uninstall dialog; resolves null when the app was removed. */
  uninstallApp(pkg: string): Promise<InstalledApp | null>
  /** Asks Android to clear every app's cache in shared storage; true when it did. */
  clearAppCaches(): Promise<boolean>
  /** Opens the system's free-up-space screen. */
  manageStorage(): Promise<void>
  mediaSummary(): Promise<MediaSummary>
  mediaFiles(kind: MediaKind, limit: number): Promise<MediaFileList>
  /** Files from a mediaFiles list. */
  openMediaFile(path: string): Promise<void>
  shareMediaFiles(paths: string[]): Promise<void>
  deleteMediaFiles(paths: string[]): Promise<DeleteResult>
  iconUrl(pkg: string): string
  /** A small preview image of a photo or video; null for other files. */
  thumbnailUrl(file: Pick<MediaFile, 'path' | 'mime' | 'type'>): string | null
  /** Runs when the user comes back to the app, such as from the system settings. */
  onResume(cb: () => void): () => void
}

export interface DiskGroveAPI {
  getMeta(): Promise<AppMeta>
  listDrives(): Promise<DriveInfo[]>
  pickFolder(): Promise<string | null>
  /** The path a scan of `path` will report: its real location when the path runs through a link. */
  resolveScanRoot(path: string): Promise<string>
  startScan(path: string, options?: { followLinks?: boolean; skipHidden?: boolean }): Promise<void>
  cancelScan(): Promise<void>
  getChildren(path: string, sort: SortSpec): Promise<ChildrenResult>
  getNode(path: string): Promise<NodeSummary | null>
  getTopFiles(path: string | null, limit: number): Promise<NodeSummary[]>
  getExtensions(path: string | null): Promise<ExtensionStat[]>
  getAgeStats(path: string | null): Promise<AgeBucket[]>
  /** Files below `path` (the scan root when null) in `group`, largest first. */
  getGroupFiles(group: FileGroup, path: string | null, limit: number): Promise<SearchResult>
  getTreemap(path: string, maxDepth: number, minPercent: number): Promise<TreemapNode | null>
  /** Matches below `path` (the scan root when null), largest first. */
  search(query: string, path: string | null, limit: number): Promise<SearchResult>
  getUnreadable(limit: number): Promise<UnreadableList>
  findDuplicates(path: string | null): Promise<DuplicateGroup[]>
  cancelDuplicates(): Promise<void>
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  readFile(path: string, offset: number, length: number): Promise<FileChunk>
  getItemTimes(path: string): Promise<ItemTimes>
  deleteItems(paths: string[], mode: DeleteMode): Promise<DeleteResult>
  exportReport(format: 'csv' | 'json' | 'html'): Promise<string | null>
  getSettings(): Promise<AppSettings>
  setSettings(partial: Partial<AppSettings>): Promise<AppSettings>
  onSettingsChanged(cb: (settings: AppSettings) => void): () => void
  onProgress(cb: (p: ScanProgress) => void): () => void
  onComplete(cb: (r: ScanComplete) => void): () => void
  onError(cb: (e: { message: string }) => void): () => void
  onDupProgress(cb: (p: DupProgress) => void): () => void
  minimize(): Promise<void>
  toggleMaximize(): Promise<boolean>
  closeWindow(): Promise<void>
  isMaximized(): Promise<boolean>
  onMaximized(cb: (maximized: boolean) => void): () => void
  isFullScreen(): Promise<boolean>
  onFullScreen(cb: (fullScreen: boolean) => void): () => void
  /** A URL that streams a scanned media file; desktop serves these through its media protocol instead. */
  mediaUrl?(path: string, version: number): string
  /**
   * Hardware back button (Android). Handlers run newest first until one returns true; when none
   * does, the app goes to the background.
   */
  onBackButton?(cb: () => boolean): () => void
  /** Offers scanned files to other apps (Android's share sheet). */
  shareItems?(paths: string[]): Promise<void>
  android?: AndroidFeatures
}

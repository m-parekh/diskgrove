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
}

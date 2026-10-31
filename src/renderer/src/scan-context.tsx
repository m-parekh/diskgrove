import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import type {
  AgeBucket,
  AppMeta,
  AppSettings,
  ChildrenResult,
  DeleteMode,
  DeleteResult,
  DriveInfo,
  DuplicateGroup,
  DupProgress,
  ExtensionStat,
  NodeSummary,
  RightTab,
  ScanComplete,
  ScanProgress,
  SearchResult,
  SearchScope,
  SortSpec,
  TreemapNode
} from '@shared/types'
import { formatNumber } from '@shared/format'
import { isWithin, pathCrumbs } from '@shared/paths'
import { resolveTheme, themeIsDark } from '@shared/themes'
import { DEFAULT_FONT_SCALE } from '@shared/font-scale'
import { trashName as trashNameFor } from '@/lib/platform'

const DEFAULT_SORT: SortSpec = { key: 'size', dir: 'desc' }

// The IPC handler caps a search at 2000 hits; the results list is virtualized.
const SEARCH_LIMIT = 2000
const SEARCH_DEBOUNCE_MS = 200
const LIVE_REFRESH_MS = 2000

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  followLinks: false,
  skipHidden: false,
  showFreeSpace: true,
  showPreview: true,
  fontScale: DEFAULT_FONT_SCALE,
  searchScope: 'folder',
  recents: []
}

/** A finished search and the query it answered; `root` is the folder it covered. */
export interface SearchResults extends SearchResult {
  query: string
}

interface ScanContextValue {
  meta: AppMeta | null
  settings: AppSettings
  drives: DriveInfo[]
  view: 'start' | 'scan'
  rootPath: string | null
  selectedPath: string | null
  selectedNode: NodeSummary | null
  expanded: Record<string, boolean>
  childrenOf: Record<string, ChildrenResult>
  sort: SortSpec
  tab: RightTab
  scanning: boolean
  progress: ScanProgress | null
  complete: ScanComplete | null
  query: string
  searchScope: SearchScope
  /** Folder a search covers now: the selected folder, or the scan root for the entire scan. */
  searchTarget: string | null
  searchResult: SearchResults | null
  searching: boolean
  searchInputRef: RefObject<HTMLInputElement | null>
  /** Path the details table should put its cursor on once the row is listed. */
  focusRequest: string | null
  extensions: ExtensionStat[]
  topFiles: NodeSummary[]
  age: AgeBucket[]
  treemap: TreemapNode | null
  treemapDepth: number
  treemapMin: number
  duplicates: DuplicateGroup[]
  dupProgress: DupProgress | null
  dupLoading: boolean
  pendingDelete: NodeSummary[] | null
  previewItem: NodeSummary | null
  toast: string | null
  showToast: (message: string) => void
  setTab: (tab: RightTab) => void
  setSort: (sort: SortSpec) => void
  setQuery: (q: string) => void
  clearSearch: () => void
  setSearchScope: (scope: SearchScope) => void
  focusSearch: () => void
  searchInFolder: (path: string) => void
  locateItem: (item: Pick<NodeSummary, 'kind' | 'path' | 'parentPath'>) => void
  clearFocusRequest: () => void
  setTreemapDepth: (n: number) => void
  setTreemapMin: (n: number) => void
  setPendingDelete: (items: NodeSummary[] | null) => void
  setPreviewItem: (item: NodeSummary | null) => void
  applySettings: (partial: Partial<AppSettings>) => Promise<void>
  refreshDrives: () => Promise<void>
  startScan: (path: string) => Promise<void>
  cancelScan: () => Promise<void>
  goHome: () => void
  selectPath: (path: string) => void
  toggleExpanded: (path: string) => void
  runSearch: () => Promise<void>
  loadDuplicates: () => Promise<void>
  cancelDuplicates: () => Promise<void>
  confirmDelete: (mode: DeleteMode) => Promise<void>
  exportReport: (format: 'csv' | 'json' | 'html') => Promise<void>
  openItem: (path: string) => Promise<void>
  revealItem: (path: string) => Promise<void>
}

const ScanContext = createContext<ScanContextValue | null>(null)

function applyTheme(theme: AppSettings['theme']): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const dark = themeIsDark(theme, prefersDark)
  const resolved = resolveTheme(theme, prefersDark)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.setAttribute('data-theme', resolved)
  root.style.colorScheme = dark ? 'dark' : 'light'
}

export function ScanProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [view, setView] = useState<'start' | 'scan'>('start')
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<NodeSummary | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [childrenOf, setChildrenOf] = useState<Record<string, ChildrenResult>>({})
  const [sort, setSort] = useState<SortSpec>(DEFAULT_SORT)
  const [tab, setTab] = useState<RightTab>('details')
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [complete, setComplete] = useState<ScanComplete | null>(null)
  const [query, setQuery] = useState('')
  const [searchResult, setSearchResult] = useState<SearchResults | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchNonce, setSearchNonce] = useState(0)
  const [focusRequest, setFocusRequest] = useState<string | null>(null)
  const [extensions, setExtensions] = useState<ExtensionStat[]>([])
  const [topFiles, setTopFiles] = useState<NodeSummary[]>([])
  const [age, setAge] = useState<AgeBucket[]>([])
  const [treemap, setTreemap] = useState<TreemapNode | null>(null)
  const [treemapDepth, setTreemapDepth] = useState(3)
  const [treemapMin, setTreemapMin] = useState(0.4)
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([])
  const [dupProgress, setDupProgress] = useState<DupProgress | null>(null)
  const [dupLoading, setDupLoading] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<NodeSummary[] | null>(null)
  const [previewItem, setPreviewItem] = useState<NodeSummary | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const scanInFlight = useRef(false)
  const branchesInFlight = useRef<Promise<void> | null>(null)
  const branchRefreshEpoch = useRef(0)
  const sideDataEpoch = useRef(0)
  const sideDataInFlight = useRef(false)
  const searchEpoch = useRef(0)
  const searchNow = useRef(false)
  const lastSearchedTerm = useRef('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 3200)
  }, [])

  const refreshDrives = useCallback(async () => {
    setDrives(await window.diskgrove.listDrives())
  }, [])

  useEffect(() => {
    const api = window.diskgrove
    if (!api) {
      setToast('Desktop API failed to load. Restart the app with npm run dev.')
      return
    }
    void (async () => {
      const [m, s] = await Promise.all([api.getMeta(), api.getSettings()])
      setMeta(m)
      setSettings(s)
      await refreshDrives()
    })().catch((err) => showToast(err instanceof Error ? err.message : 'Could not load app settings'))
    const offP = api.onProgress((p) => {
      setProgress(p)
      setScanning(p.running)
    })
    const offC = api.onComplete((r) => {
      setComplete(r)
      setScanning(false)
      setProgress((prev) =>
        prev
          ? {
              ...prev,
              running: false,
              files: r.files,
              folders: r.folders,
              bytes: r.bytes,
              allocated: r.allocated,
              unreadable: r.unreadable,
              elapsedMs: r.elapsedMs
            }
          : null
      )
    })
    const offD = api.onDupProgress(setDupProgress)
    const offS = api.onSettingsChanged(setSettings)
    return () => {
      offP()
      offC()
      offD()
      offS()
    }
  }, [refreshDrives, showToast])

  useEffect(() => {
    applyTheme(settings.theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(settings.theme)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [settings.theme])

  const refreshVisible = useCallback(async () => {
    if (!rootPath) return
    const epoch = ++branchRefreshEpoch.current
    await branchesInFlight.current?.catch(() => undefined)
    if (epoch !== branchRefreshEpoch.current) return
    const update = async () => {
      const paths = new Set<string>([rootPath])
      for (const [p, on] of Object.entries(expanded)) if (on) paths.add(p)
      if (selectedPath) paths.add(selectedPath)
      const branches: Record<string, ChildrenResult> = {}
      for (const p of paths) {
        branches[p] = await window.diskgrove.getChildren(p, sort)
        if (epoch !== branchRefreshEpoch.current) return
      }
      const focus = selectedPath ?? rootPath
      const node = await window.diskgrove.getNode(focus)
      if (epoch !== branchRefreshEpoch.current) return
      setChildrenOf(branches)
      setSelectedNode(node)
    }
    const pending = update()
    branchesInFlight.current = pending
    try {
      await pending
    } finally {
      if (branchesInFlight.current === pending) branchesInFlight.current = null
    }
  }, [rootPath, expanded, selectedPath, sort])

  useEffect(() => {
    if (view !== 'scan' || !rootPath) return
    void refreshVisible()
    if (!scanning) return
    const id = window.setInterval(() => void refreshVisible(), LIVE_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [view, rootPath, scanning, refreshVisible])

  const loadSideData = useCallback(
    async (live = false) => {
      if (!selectedPath || view !== 'scan') return
      // A live refresh skips its turn while the last one is still walking a large scan.
      if (live && sideDataInFlight.current) return
      // Whole-tree queries run in slices, so answers can come back out of order: only the latest counts.
      const epoch = ++sideDataEpoch.current
      const latest = () => epoch === sideDataEpoch.current
      sideDataInFlight.current = true
      try {
        if (tab === 'extensions') {
          const stats = await window.diskgrove.getExtensions(selectedPath)
          if (latest()) setExtensions(stats)
        }
        if (tab === 'topfiles') {
          const files = await window.diskgrove.getTopFiles(selectedPath, 200)
          if (latest()) setTopFiles(files)
        }
        if (tab === 'age') {
          const buckets = await window.diskgrove.getAgeStats(selectedPath)
          if (latest()) setAge(buckets)
        }
        if (tab === 'treemap' || tab === 'pie' || tab === 'bar') {
          const tree = await window.diskgrove.getTreemap(selectedPath, treemapDepth, treemapMin)
          if (latest()) setTreemap(tree)
        }
      } finally {
        if (latest()) sideDataInFlight.current = false
      }
    },
    [selectedPath, view, tab, treemapDepth, treemapMin]
  )

  useEffect(() => {
    void loadSideData()
    if (!scanning) return
    const id = window.setInterval(() => void loadSideData(true), LIVE_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [loadSideData, scanning])

  // A scan resolves only once it ends, after a new root has been rendered, so it must refresh with the
  // latest callbacks: the ones it closed over still hold the previous root and would replace the new tree.
  const latestRefreshVisible = useRef(refreshVisible)
  latestRefreshVisible.current = refreshVisible
  const latestLoadSideData = useRef(loadSideData)
  latestLoadSideData.current = loadSideData

  const applySettings = useCallback(async (partial: Partial<AppSettings>) => {
    const next = await window.diskgrove.setSettings(partial)
    setSettings(next)
  }, [])

  const startScan = useCallback(
    async (requested: string) => {
      if (scanInFlight.current || scanning || dupLoading) {
        showToast('Wait for the current scan or duplicate search to finish')
        return
      }
      scanInFlight.current = true
      // Tree state is keyed by the paths the scanner reports, which differ when the folder is reached through a link.
      let path: string
      try {
        path = await window.diskgrove.resolveScanRoot(requested)
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Scan failed')
        scanInFlight.current = false
        return
      }
      branchRefreshEpoch.current++
      setView('scan')
      setRootPath(path)
      setSelectedPath(path)
      setExpanded({ [path]: true })
      setChildrenOf({})
      setPreviewItem(null)
      setComplete(null)
      setDuplicates([])
      searchEpoch.current++
      setSearchResult(null)
      setSearching(false)
      setFocusRequest(null)
      setTab('details')
      setScanning(true)
      setProgress({
        running: true,
        rootPath: path,
        files: 0,
        folders: 0,
        bytes: 0,
        allocated: 0,
        unreadable: 0,
        currentPath: path,
        elapsedMs: 0
      })
      try {
        await window.diskgrove.startScan(path, {
          followLinks: settings.followLinks,
          skipHidden: settings.skipHidden
        })
        const s = await window.diskgrove.getSettings()
        setSettings(s)
        await latestRefreshVisible.current()
        await latestLoadSideData.current()
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Scan failed')
        setScanning(false)
      } finally {
        scanInFlight.current = false
      }
    },
    [settings.followLinks, settings.skipHidden, scanning, dupLoading, showToast]
  )

  const cancelScan = useCallback(async () => {
    await window.diskgrove.cancelScan()
  }, [])

  const goHome = useCallback(() => {
    branchRefreshEpoch.current++
    if (scanning) void window.diskgrove.cancelScan()
    setView('start')
    setRootPath(null)
    setSelectedPath(null)
    setSelectedNode(null)
    setPreviewItem(null)
    setProgress(null)
    setComplete(null)
    searchEpoch.current++
    setSearchResult(null)
    setSearching(false)
    setFocusRequest(null)
    void refreshDrives()
  }, [scanning, refreshDrives])

  const selectPath = useCallback((path: string) => {
    setSelectedPath(path)
    setPreviewItem(null)
    setFocusRequest(null)
    setExpanded((prev) => ({ ...prev, [path]: true }))
  }, [])

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((prev) => ({ ...prev, [path]: !prev[path] }))
  }, [])

  const term = query.trim()
  const searchScope = settings.searchScope
  const searchTarget =
    view === 'scan' && rootPath ? (searchScope === 'all' ? rootPath : (selectedPath ?? rootPath)) : null
  // Results are only fetched while the search tab is open, and always for the current scope.
  const searchActive = tab === 'search' && term !== '' && searchTarget !== null

  const dropSearchResult = useCallback(() => {
    searchEpoch.current++
    setSearchResult(null)
    setSearching(false)
  }, [])

  useEffect(() => {
    if (!searchActive || !searchTarget) return
    // Typing waits for a pause; a new scope or folder, Enter or a refresh searches at once.
    const immediate = searchNow.current || term === lastSearchedTerm.current
    searchNow.current = false
    const id = window.setTimeout(
      () => {
        lastSearchedTerm.current = term
        const epoch = ++searchEpoch.current
        setSearching(true)
        window.diskgrove
          .search(term, searchTarget, SEARCH_LIMIT)
          .then(
            (result) => {
              if (epoch === searchEpoch.current) setSearchResult({ ...result, query: term })
            },
            (err) => {
              if (epoch === searchEpoch.current) showToast(err instanceof Error ? err.message : 'Search failed')
            }
          )
          .finally(() => {
            if (epoch === searchEpoch.current) setSearching(false)
          })
      },
      immediate ? 0 : SEARCH_DEBOUNCE_MS
    )
    return () => window.clearTimeout(id)
    // `scanning` is listed so the search runs once more when a scan finishes.
  }, [searchActive, searchTarget, term, searchNonce, scanning, showToast])

  // Results follow a running scan, like the other views.
  useEffect(() => {
    if (!searchActive || !scanning) return
    const id = window.setInterval(() => setSearchNonce((n) => n + 1), LIVE_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [searchActive, scanning])

  const clearSearch = useCallback(() => {
    setQuery('')
    dropSearchResult()
    setTab((current) => (current === 'search' ? 'details' : current))
  }, [dropSearchResult])

  const updateQuery = useCallback(
    (q: string) => {
      setQuery(q)
      if (q.trim()) {
        setTab('search')
      } else {
        dropSearchResult()
        setTab((current) => (current === 'search' ? 'details' : current))
      }
    },
    [dropSearchResult]
  )

  const runSearch = useCallback(async () => {
    if (!query.trim()) {
      clearSearch()
      return
    }
    if (!rootPath) return
    searchNow.current = true
    setTab('search')
    setSearchNonce((n) => n + 1)
  }, [rootPath, query, clearSearch])

  const setSearchScope = useCallback(
    (scope: SearchScope) => {
      setSettings((prev) => (prev.searchScope === scope ? prev : { ...prev, searchScope: scope }))
      window.diskgrove
        .setSettings({ searchScope: scope })
        .then(setSettings, (err) => showToast(err instanceof Error ? err.message : 'Could not save the search scope'))
    },
    [showToast]
  )

  // Ctrl/Cmd+F and "Search in this folder": an existing query shows its results again.
  const focusSearch = useCallback(() => {
    const input = searchInputRef.current
    if (!input || input.disabled) return
    input.focus()
    input.select()
    if (input.value.trim()) void runSearch()
  }, [runSearch])

  const searchInFolder = useCallback(
    (path: string) => {
      selectPath(path)
      setSearchScope('folder')
    },
    [selectPath, setSearchScope]
  )

  const locateItem = useCallback(
    (item: Pick<NodeSummary, 'kind' | 'path' | 'parentPath'>) => {
      if (!rootPath) return
      const folder = item.kind === 'dir' ? item.path : (item.parentPath ?? rootPath)
      if (!isWithin(rootPath, folder)) return
      setExpanded((prev) => {
        const next = { ...prev }
        for (const crumb of pathCrumbs(rootPath, folder)) next[crumb.path] = true
        return next
      })
      setSelectedPath(folder)
      setPreviewItem(null)
      setFocusRequest(item.kind === 'dir' ? null : item.path)
      setTab('details')
    },
    [rootPath]
  )

  const clearFocusRequest = useCallback(() => setFocusRequest(null), [])

  const loadDuplicates = useCallback(async () => {
    if (!selectedPath) return
    setDupLoading(true)
    try {
      setDuplicates(await window.diskgrove.findDuplicates(selectedPath))
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Duplicate scan failed')
    } finally {
      setDupLoading(false)
    }
  }, [selectedPath, showToast])

  const cancelDuplicates = useCallback(async () => {
    await window.diskgrove.cancelDuplicates()
  }, [])

  const confirmDelete = useCallback(
    async (mode: DeleteMode) => {
      const items = pendingDelete
      if (!items || items.length === 0) return
      let result: DeleteResult
      try {
        result = await window.diskgrove.deleteItems(
          items.map((i) => i.path),
          mode
        )
      } catch (err) {
        setPendingDelete(null)
        showToast(err instanceof Error ? err.message : 'Delete failed')
        return
      }
      setPendingDelete(null)
      if (result.deleted.length === 0 && result.failed.length === 0) return

      const trashName = trashNameFor(meta?.platform) ?? 'Trash'
      const count = result.deleted.length
      const what =
        count === 1 && items.length === 1 ? items[0].name : `${formatNumber(count)} item${count === 1 ? '' : 's'}`
      const verb = mode === 'trash' ? `Moved ${what} to ${trashName}` : `Deleted ${what}`
      if (result.failed.length === 0) showToast(verb)
      else if (count === 0) showToast(`Delete failed: ${result.failed[0].error}`)
      else showToast(`${verb} · ${formatNumber(result.failed.length)} failed: ${result.failed[0].error}`)

      const gone = new Set(result.deleted)
      if (gone.size) {
        setDuplicates([])
        setSearchNonce((n) => n + 1)
        setPreviewItem((current) => (current && gone.has(current.path) ? null : current))
      }
      if (selectedPath && gone.has(selectedPath)) {
        const parent = items.find((i) => i.path === selectedPath)?.parentPath
        if (parent) setSelectedPath(parent)
      }
      await refreshVisible()
      await loadSideData()
    },
    [pendingDelete, selectedPath, meta, refreshVisible, loadSideData, showToast]
  )

  const exportReport = useCallback(
    async (format: 'csv' | 'json' | 'html') => {
      try {
        const saved = await window.diskgrove.exportReport(format)
        if (saved) showToast(`Saved ${saved}`)
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Export failed')
      }
    },
    [showToast]
  )

  const openItem = useCallback(
    async (path: string) => {
      try {
        await window.diskgrove.openPath(path)
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Could not open')
      }
    },
    [showToast]
  )

  const revealItem = useCallback(
    async (path: string) => {
      try {
        await window.diskgrove.revealPath(path)
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Could not reveal item')
      }
    },
    [showToast]
  )

  const value = useMemo<ScanContextValue>(
    () => ({
      meta,
      settings,
      drives,
      view,
      rootPath,
      selectedPath,
      selectedNode,
      expanded,
      childrenOf,
      sort,
      tab,
      scanning,
      progress,
      complete,
      query,
      searchScope,
      searchTarget,
      searchResult,
      searching,
      searchInputRef,
      focusRequest,
      extensions,
      topFiles,
      age,
      treemap,
      treemapDepth,
      treemapMin,
      duplicates,
      dupProgress,
      dupLoading,
      pendingDelete,
      previewItem,
      toast,
      showToast,
      setTab,
      setSort,
      setQuery: updateQuery,
      clearSearch,
      setSearchScope,
      focusSearch,
      searchInFolder,
      locateItem,
      clearFocusRequest,
      setTreemapDepth,
      setTreemapMin,
      setPendingDelete,
      setPreviewItem,
      applySettings,
      refreshDrives,
      startScan,
      cancelScan,
      goHome,
      selectPath,
      toggleExpanded,
      runSearch,
      loadDuplicates,
      cancelDuplicates,
      confirmDelete,
      exportReport,
      openItem,
      revealItem
    }),
    [
      meta,
      settings,
      drives,
      view,
      rootPath,
      selectedPath,
      selectedNode,
      expanded,
      childrenOf,
      sort,
      tab,
      scanning,
      progress,
      complete,
      query,
      searchScope,
      searchTarget,
      searchResult,
      searching,
      focusRequest,
      extensions,
      topFiles,
      age,
      treemap,
      treemapDepth,
      treemapMin,
      duplicates,
      dupProgress,
      dupLoading,
      pendingDelete,
      previewItem,
      toast,
      showToast,
      applySettings,
      refreshDrives,
      startScan,
      cancelScan,
      goHome,
      selectPath,
      toggleExpanded,
      runSearch,
      updateQuery,
      clearSearch,
      setSearchScope,
      focusSearch,
      searchInFolder,
      locateItem,
      clearFocusRequest,
      loadDuplicates,
      cancelDuplicates,
      confirmDelete,
      exportReport,
      openItem,
      revealItem
    ]
  )

  return <ScanContext.Provider value={value}>{children}</ScanContext.Provider>
}

export function useScan(): ScanContextValue {
  const ctx = useContext(ScanContext)
  if (!ctx) throw new Error('useScan must be used within ScanProvider')
  return ctx
}

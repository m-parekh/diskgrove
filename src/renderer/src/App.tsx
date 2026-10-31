import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { formatBytes, formatNumber } from '@shared/format'
import { pathCrumbs } from '@shared/paths'
import type { DeleteMode } from '@shared/types'
import { TitleBar } from '@/components/title-bar'
import { Ribbon, tabLabel } from '@/components/ribbon'
import { StartScreen } from '@/components/start-screen'
import { AndroidHome } from '@/components/android/android-home'
import { DirectoryTree } from '@/components/directory-tree'
import { DetailsTable } from '@/components/details-table'
import { StatusBar } from '@/components/status-bar'
import { Breadcrumbs } from '@/components/breadcrumbs'
import { TreemapView } from '@/components/charts/treemap'
import { PieView } from '@/components/charts/pie-view'
import { BarView } from '@/components/charts/bar-view'
import { ExtensionsView } from '@/components/views/extensions-view'
import { TopFilesView } from '@/components/views/top-files-view'
import { AgeView } from '@/components/views/age-view'
import { DuplicatesView } from '@/components/views/duplicates-view'
import { SearchView } from '@/components/views/search-view'
import { FileGlyph } from '@/components/file-icon'
import { PreviewPane } from '@/components/preview/preview-pane'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ScanProvider, useScan } from '@/scan-context'
import { cn } from '@/lib/utils'
import { isAndroid, trashName as trashNameFor } from '@/lib/platform'
import { useCompactLayout } from '@/hooks/use-compact'

function RightPane() {
  const { tab } = useScan()
  let pane: ReactNode
  switch (tab) {
    case 'treemap':
      pane = <TreemapView />
      break
    case 'pie':
      pane = <PieView />
      break
    case 'bar':
      pane = <BarView />
      break
    case 'extensions':
      pane = <ExtensionsView />
      break
    case 'topfiles':
      pane = <TopFilesView />
      break
    case 'age':
      pane = <AgeView />
      break
    case 'duplicates':
      pane = <DuplicatesView />
      break
    case 'search':
      pane = <SearchView />
      break
    default:
      pane = <DetailsTable />
  }
  return (
    <div key={tab} className="h-full min-h-0 min-w-0 overflow-hidden animate-pane">
      {pane}
    </div>
  )
}

const DIALOG_LIST_LIMIT = 8

function DeleteDialog() {
  const { meta, pendingDelete, setPendingDelete, confirmDelete } = useScan()
  const [busy, setBusy] = useState(false)
  // The dialog opens from a list, not a trigger button, so it hands focus back to that list itself.
  const returnFocus = useRef<HTMLElement | null>(null)
  const items = pendingDelete ?? []
  const count = items.length
  const trashName = trashNameFor(meta?.platform)
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0)
  const title =
    count > 1 ? `Delete ${formatNumber(count)} items?` : items[0]?.kind === 'dir' ? 'Delete folder?' : 'Delete file?'

  const run = async (mode: DeleteMode) => {
    setBusy(true)
    try {
      await confirmDelete(mode)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={count > 0} onOpenChange={(open) => !open && !busy && setPendingDelete(null)}>
      <DialogContent
        className="max-w-lg"
        onOpenAutoFocus={() => {
          returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocus.current
          returnFocus.current = null
          if (!target?.isConnected || target === document.body) return
          event.preventDefault()
          target.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {trashName
              ? `Move ${count > 1 ? 'them' : 'it'} to the ${trashName} to keep ${count > 1 ? 'them' : 'it'} recoverable, or delete permanently. Permanent deletion cannot be undone.`
              : 'This device has no Trash for these files, so deletion is permanent and cannot be undone.'}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/30 text-xs">
          <ScrollArea orientation="vertical" className="max-h-44">
            <ul className="space-y-1 p-2">
              {items.slice(0, DIALOG_LIST_LIMIT).map((item) => (
                <li key={item.path} className="flex min-w-0 items-center gap-2" title={item.path}>
                  <FileGlyph name={item.name} kind={item.kind} />
                  <span className="min-w-0 flex-1 truncate">{item.path}</span>
                  <span className="shrink-0 tabular text-muted-foreground">{formatBytes(item.size)}</span>
                </li>
              ))}
              {count > DIALOG_LIST_LIMIT ? (
                <li className="text-muted-foreground">…and {formatNumber(count - DIALOG_LIST_LIMIT)} more</li>
              ) : null}
            </ul>
          </ScrollArea>
          <div className="border-t px-2 py-1.5 text-muted-foreground">
            {formatNumber(count)} item{count === 1 ? '' : 's'} · {formatBytes(totalBytes)}
          </div>
        </div>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" disabled={busy} onClick={() => setPendingDelete(null)}>
            Cancel
          </Button>
          {trashName ? (
            <Button disabled={busy} onClick={() => void run('trash')}>
              {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Move to {trashName}
            </Button>
          ) : null}
          <Button variant="destructive" disabled={busy} onClick={() => void run('permanent')}>
            {busy && !trashName ? <Loader2 className="animate-spin" /> : null} Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ToastHost() {
  const { toast } = useScan()
  const [message, setMessage] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const shown = useRef<string | null>(null)

  useEffect(() => {
    if (toast) {
      shown.current = toast
      setMessage(toast)
      setLeaving(false)
      return
    }
    if (!shown.current) return
    setLeaving(true)
    const id = window.setTimeout(() => {
      shown.current = null
      setMessage(null)
      setLeaving(false)
    }, 180)
    return () => window.clearTimeout(id)
  }, [toast])

  if (!message) return null
  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-10 right-4 z-50 rounded-md border bg-card px-3 py-2 text-sm shadow-lg',
        leaving ? 'animate-toast-out' : 'animate-toast-in'
      )}
    >
      {message}
    </div>
  )
}

type Pane = 'tree' | 'main' | 'preview'

/** A phone shows one of the panes at a time, picked from a row of tabs. */
function CompactPanes({ pane, setPane }: { pane: Pane; setPane: (pane: Pane) => void }) {
  const { tab, selectedPath } = useScan()
  const panes: Array<{ id: Pane; label: string }> = [
    { id: 'tree', label: 'Folders' },
    { id: 'main', label: tabLabel(tab) },
    { id: 'preview', label: 'Preview' }
  ]

  // Picking a folder in the tree shows what is in it.
  const shownPath = useRef(selectedPath)
  useEffect(() => {
    if (selectedPath === shownPath.current) return
    shownPath.current = selectedPath
    if (pane === 'tree') setPane('main')
  }, [selectedPath, pane, setPane])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div role="tablist" aria-label="Panes" className="grid shrink-0 grid-cols-3 border-b bg-card/60 p-1 text-xs">
        {panes.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={pane === item.id}
            className={cn(
              'h-8 truncate rounded-md px-2 font-medium text-muted-foreground transition-colors duration-150',
              pane === item.id && 'bg-secondary text-foreground'
            )}
            onClick={() => setPane(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {/* The tree and the view stay mounted so switching keeps their scroll and selection. */}
      <div className={cn('min-h-0 flex-1', pane !== 'tree' && 'hidden')}>
        <DirectoryTree />
      </div>
      <div className={cn('min-h-0 flex-1 overflow-hidden', pane !== 'main' && 'hidden')}>
        <RightPane />
      </div>
      {pane === 'preview' ? (
        <div className="min-h-0 flex-1">
          <PreviewPane />
        </div>
      ) : null}
    </div>
  )
}

function Shell() {
  const {
    meta,
    view,
    scanning,
    cancelScan,
    rootPath,
    selectedPath,
    selectPath,
    startScan,
    goHome,
    settings,
    focusSearch
  } = useScan()
  const compact = useCompactLayout()
  const [pane, setPane] = useState<Pane>('main')

  useEffect(() => {
    if (view === 'start') setPane('main')
  }, [view])

  // Android's back button leaves the folders or preview pane, climbs to the scan root, then returns home.
  useEffect(
    () =>
      window.diskgrove.onBackButton?.(() => {
        if (compact && pane !== 'main') {
          setPane('main')
          return true
        }
        if (view !== 'scan') return false
        const crumbs = rootPath && selectedPath ? pathCrumbs(rootPath, selectedPath) : []
        if (crumbs.length >= 2) selectPath(crumbs[crumbs.length - 2].path)
        else goHome()
        return true
      }),
    [compact, pane, view, rootPath, selectedPath, selectPath, goHome]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const command = meta?.platform === 'darwin' ? e.metaKey : e.ctrlKey
      if (command && !e.altKey && e.key.toLowerCase() === 'f' && view === 'scan') {
        e.preventDefault()
        focusSearch()
        return
      }
      if (e.key === 'Escape' && scanning) void cancelScan()
      if (e.key === 'F5' && rootPath) {
        e.preventDefault()
        void startScan(rootPath)
      }
      if (e.key === 'F2') goHome()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [meta, view, scanning, cancelScan, rootPath, startScan, goHome, focusSearch])

  // Android's home has its own header and navigation in place of the title bar, ribbon and status bar.
  const androidHome = view === 'start' && isAndroid(meta?.platform)

  return (
    <div className="relative flex h-full min-h-0 w-full flex-1 flex-col">
      {androidHome ? null : <TitleBar />}
      {androidHome ? null : <Ribbon />}
      {androidHome ? (
        <AndroidHome />
      ) : view === 'start' ? (
        <StartScreen />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden animate-pane">
          <Breadcrumbs />
          {compact ? (
            <CompactPanes pane={pane} setPane={setPane} />
          ) : (
            <div className="min-h-0 min-w-0 flex-1">
              <ResizablePanelGroup direction="horizontal">
                <ResizablePanel
                  id="tree"
                  order={1}
                  defaultSize={settings.showPreview ? 22 : 30}
                  minSize={14}
                  maxSize={50}
                  className="min-h-0 min-w-0"
                >
                  <DirectoryTree />
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel
                  id="main"
                  order={2}
                  defaultSize={settings.showPreview ? 50 : 70}
                  minSize={30}
                  className="min-h-0 min-w-0"
                >
                  <div className="h-full min-h-0 min-w-0 overflow-hidden">
                    <RightPane />
                  </div>
                </ResizablePanel>
                {settings.showPreview ? (
                  <>
                    <ResizableHandle withHandle />
                    <ResizablePanel
                      id="preview"
                      order={3}
                      defaultSize={28}
                      minSize={18}
                      maxSize={50}
                      className="min-h-0 min-w-0"
                    >
                      <PreviewPane />
                    </ResizablePanel>
                  </>
                ) : null}
              </ResizablePanelGroup>
            </div>
          )}
        </div>
      )}
      {androidHome ? null : <StatusBar />}
      <DeleteDialog />
      <ToastHost />
    </div>
  )
}

export default function App() {
  return (
    <TooltipProvider delayDuration={250}>
      <ScanProvider>
        <Shell />
      </ScanProvider>
    </TooltipProvider>
  )
}

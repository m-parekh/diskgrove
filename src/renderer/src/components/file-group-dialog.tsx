import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ExternalLink, FolderOpen, LocateFixed } from 'lucide-react'
import { formatBytes, formatCount, formatDate, formatNumber } from '@shared/format'
import { baseName } from '@shared/paths'
import type { FileGroup, NodeSummary, SearchResult } from '@shared/types'
import { FileGlyph } from '@/components/file-icon'
import { SizeBar } from '@/components/size-bar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'
import { revealLabel as revealLabelFor } from '@/lib/platform'

// The largest ones are listed; the counts cover them all.
const LIST_LIMIT = 2000
// Two lines per row: the name, then the folder it is in.
const ROW_H = 40

/** A row of the File types or File age view whose files the dialog lists. */
export interface FileGroupTarget {
  group: FileGroup
  title: string
}

/** Lists the files behind a row of the File types or File age view, largest first. */
export function FileGroupDialog({ target, onClose }: { target: FileGroupTarget | null; onClose: () => void }) {
  // Kept while the dialog animates closed, so its contents do not vanish first.
  const [shown, setShown] = useState(target)
  if (target !== null && target !== shown) setShown(target)
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex h-[min(36rem,85vh)] max-w-3xl flex-col">
        {shown ? <FileGroupDetails key={JSON.stringify(shown.group)} target={shown} close={onClose} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function FileGroupDetails({ target, close }: { target: FileGroupTarget; close: () => void }) {
  const { meta, selectedPath, openItem, revealItem, locateItem } = useScan()
  const [result, setResult] = useState<SearchResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current = true
    window.diskgrove.getGroupFiles(target.group, selectedPath, LIST_LIMIT).then(
      (next) => {
        if (current) setResult(next)
      },
      (err) => {
        if (current) setFailure(err instanceof Error ? err.message : 'Could not load the files')
      }
    )
    return () => {
      current = false
    }
  }, [target.group, selectedPath])

  const hits = result?.hits ?? []
  const maxSize = hits[0]?.size || 1
  const totalSize = hits.reduce((sum, f) => sum + f.size, 0)

  const virtualizer = useVirtualizer({
    count: hits.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (index) => hits[index].path,
    overscan: 12
  })

  const revealLabel = revealLabelFor(meta?.platform)

  const open = useCallback((file: NodeSummary) => void openItem(file.path), [openItem])
  const reveal = useCallback((file: NodeSummary) => void revealItem(file.path), [revealItem])
  const showInTree = useCallback(
    (file: NodeSummary) => {
      locateItem(file)
      close()
    },
    [locateItem, close]
  )

  let body: ReactNode
  if (failure) body = <p className="p-3 text-destructive">{failure}</p>
  else if (!result) body = <p className="p-3 text-muted-foreground">Loading…</p>
  else if (hits.length === 0) body = <p className="p-3 text-muted-foreground">No files here anymore.</p>
  else
    body = (
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => (
          <div
            key={v.key}
            className="absolute inset-x-0 top-0 px-1"
            style={{ height: v.size, transform: `translateY(${v.start}px)` }}
          >
            <FileRow
              file={hits[v.index]}
              odd={v.index % 2 === 1}
              sizeRatio={hits[v.index].size / maxSize}
              revealLabel={revealLabel}
              onOpen={open}
              onReveal={reveal}
              onShowInTree={showInTree}
            />
          </div>
        ))}
      </div>
    )

  const total = result?.total ?? 0
  return (
    <>
      <DialogHeader className="pr-6">
        <DialogTitle>{target.title}</DialogTitle>
        <DialogDescription>
          {result ? (
            <>
              {formatCount(total, 'file')}
              {result.root ? <span title={result.root}> in {baseName(result.root)}</span> : null}
              {total > hits.length ? (
                <> · largest {formatNumber(hits.length)} shown</>
              ) : (
                <> · {formatBytes(totalSize)}</>
              )}
            </>
          ) : (
            'Finding files…'
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col rounded-md border bg-muted/30 text-[13px]">
        <div className="grid h-7 shrink-0 grid-cols-[minmax(0,1fr)_6.5rem_9.5rem_5.25rem] max-sm:grid-cols-[minmax(0,1fr)_5.5rem_auto] items-center border-b bg-muted px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span className="px-2">Name</span>
          <span className="px-2 text-right">Size</span>
          <span className="px-2 max-sm:hidden">Modified</span>
          <span />
        </div>
        <ScrollArea orientation="vertical" className="min-h-0 flex-1" viewportRef={viewportRef}>
          {body}
        </ScrollArea>
      </div>
    </>
  )
}

// Memoized so scrolling only renders the rows that come into view.
const FileRow = memo(function FileRow({
  file,
  odd,
  sizeRatio,
  revealLabel,
  onOpen,
  onReveal,
  onShowInTree
}: {
  file: NodeSummary
  odd: boolean
  sizeRatio: number
  revealLabel: string | null
  onOpen: (file: NodeSummary) => void
  onReveal: (file: NodeSummary) => void
  onShowInTree: (file: NodeSummary) => void
}) {
  const folder = file.parentPath ?? ''
  return (
    <div
      className={cn(
        'grid h-full grid-cols-[minmax(0,1fr)_6.5rem_9.5rem_5.25rem] max-sm:grid-cols-[minmax(0,1fr)_5.5rem_auto] items-center rounded transition-colors duration-150 hover:bg-accent/60',
        odd && 'bg-muted/30'
      )}
      title={file.path}
      onDoubleClick={() => onOpen(file)}
    >
      <span className="flex min-w-0 items-center gap-2 px-2">
        <FileGlyph name={file.name} kind={file.kind} />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate">{file.name}</span>
          {/* Cut from the start: the end of a path says where the file is. */}
          <span className="truncate-start mt-0.5 text-[11px] text-muted-foreground">
            <bdi>{folder}</bdi>
          </span>
        </span>
      </span>
      <span className="relative flex h-full items-center justify-end px-2 tabular">
        <SizeBar ratio={sizeRatio} className="inset-y-[9px]" />
        <span className="relative z-10">{formatBytes(file.size)}</span>
      </span>
      <span className="truncate px-2 text-muted-foreground max-sm:hidden">{formatDate(file.mtime)}</span>
      <span className="flex items-center justify-end pr-1">
        <RowAction label="Open" onClick={() => onOpen(file)}>
          <ExternalLink />
        </RowAction>
        {revealLabel ? (
          <RowAction label={revealLabel} onClick={() => onReveal(file)}>
            <FolderOpen />
          </RowAction>
        ) : null}
        <RowAction label="Show in tree" onClick={() => onShowInTree(file)}>
          <LocateFixed />
        </RowAction>
      </span>
    </div>
  )
})

function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
      title={label}
      aria-label={label}
      onClick={onClick}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {children}
    </Button>
  )
}

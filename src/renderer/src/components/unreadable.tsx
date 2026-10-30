import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, Copy, FolderOpen, LocateFixed, TriangleAlert } from 'lucide-react'
import { formatNumber } from '@shared/format'
import type { UnreadableItem, UnreadableList } from '@shared/types'
import { FileGlyph } from '@/components/file-icon'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'
import { revealLabel as revealLabelFor } from '@/lib/platform'

// The dialog lists the first ones found; the counts cover them all.
const LIST_LIMIT = 2000
const LIVE_REFRESH_MS = 2000
const ROW_H = 26
const LIST_PADDING = 8

const FOLDER_NOTE = "DiskGrove couldn't read this folder, so its size is incomplete"

/** Marks a folder the scan could not list, which would otherwise pass for an empty or small one. */
export function UnreadableMark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label={FOLDER_NOTE}
      title={FOLDER_NOTE}
      className={cn('flex shrink-0 text-amber-400', className)}
    >
      <TriangleAlert className="size-3.5" />
    </span>
  )
}

function reasonOf(code: string): string {
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Access denied'
    case 'EBUSY':
      return 'In use'
    case 'ELOOP':
      return 'Too many links'
    case 'ENAMETOOLONG':
      return 'Name too long'
    default:
      return code
  }
}

// Elevating the whole app is not suggested: SECURITY.md advises against it for routine scans.
function accessHint(platform: string | undefined): string {
  if (platform === 'android')
    return "Usually they are other apps' private folders, such as those in Android/data and Android/obb, which Android keeps from every other app."
  const usual = "Usually they are system files or other users' folders, which your account isn't allowed to read."
  if (platform !== 'darwin') return usual
  return `${usual} Folders protected by macOS privacy settings need Full Disk Access, under System Settings > Privacy & Security.`
}

/** The status bar count of what the scan could not read. It explains itself on hover and lists the items on click. */
export function UnreadableStatus({ count }: { count: number }) {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  // Closing the dialog hands focus back to the button, which would otherwise pop the tooltip up again.
  const focusReturning = useRef(false)
  const close = useCallback(() => setOpen(false), [])
  const them = count === 1 ? 'it' : 'them'
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip
        open={hint}
        onOpenChange={(next) => {
          if (next && focusReturning.current) next = false
          focusReturning.current = false
          setHint(next)
        }}
      >
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded-sm text-amber-400 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <TriangleAlert className="size-3" />
              {formatNumber(count)} unreadable
            </button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72">
          DiskGrove couldn't read {count === 1 ? 'this item' : 'these items'}, so the folders containing {them} show
          less than they use. Click to list {them}.
        </TooltipContent>
      </Tooltip>
      <DialogContent
        className="max-w-2xl"
        onCloseAutoFocus={() => {
          focusReturning.current = true
        }}
      >
        <UnreadableDetails count={count} close={close} />
      </DialogContent>
    </Dialog>
  )
}

type Line = { type: 'heading'; title: string; count: number } | { type: 'item'; item: UnreadableItem }

const byPath = new Intl.Collator().compare

function UnreadableDetails({ count, close }: { count: number; close: () => void }) {
  const { meta, scanning, locateItem, revealItem } = useScan()
  const [list, setList] = useState<UnreadableList | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  // Read by the refresh timer, so the count moving with every progress update does not restart it.
  const latestCount = useRef(count)
  latestCount.current = count

  useEffect(() => {
    let current = true
    let shown = -1
    const load = () =>
      window.diskgrove.getUnreadable(LIST_LIMIT).then(
        (next) => {
          if (!current) return
          shown = next.folders + next.files
          setList(next)
        },
        (err) => {
          if (current) setFailure(err instanceof Error ? err.message : 'Could not load the list')
        }
      )
    void load()
    // The list grows while a scan runs; it is fetched again once the count has moved.
    const id = scanning
      ? window.setInterval(() => {
          if (latestCount.current !== shown) void load()
        }, LIVE_REFRESH_MS)
      : undefined
    return () => {
      current = false
      window.clearInterval(id)
    }
  }, [scanning])

  const total = list ? list.folders + list.files : 0
  const listed = list?.items.length ?? 0
  const lines = useMemo<Line[]>(() => {
    if (!list) return []
    // While a scan adds items they stay in the order found, so rows do not move under the pointer.
    const items = scanning ? list.items : [...list.items].sort((a, b) => byPath(a.path, b.path))
    const sections = [
      ['Folders', 'dir', list.folders],
      ['Files', 'file', list.files]
    ] as const
    const out: Line[] = []
    for (const [title, kind, count] of sections) {
      if (count === 0) continue
      out.push({ type: 'heading', title, count })
      for (const item of items) if (item.kind === kind) out.push({ type: 'item', item })
    }
    return out
  }, [list, scanning])

  // Only the rows in view are rendered, so the list scrolls smoothly while a scan keeps the app busy.
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (index) => {
      const line = lines[index]
      return line.type === 'heading' ? `#${line.title}` : line.item.path
    },
    overscan: 12,
    paddingStart: LIST_PADDING,
    paddingEnd: LIST_PADDING
  })

  const revealLabel = revealLabelFor(meta?.platform)

  const showInTree = useCallback(
    (item: UnreadableItem) => {
      locateItem({ kind: 'dir', path: item.folder, parentPath: null })
      close()
    },
    [locateItem, close]
  )
  const reveal = useCallback((item: UnreadableItem) => void revealItem(item.path), [revealItem])

  const copyAll = () => {
    const paths = lines.flatMap((line) => (line.type === 'item' ? [line.item.path] : []))
    void navigator.clipboard.writeText(paths.join('\n')).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  let body: ReactNode
  if (failure) body = <p className="p-3 text-destructive">{failure}</p>
  else if (!list) body = <p className="p-3 text-muted-foreground">Loading…</p>
  else if (total === 0) body = <p className="p-3 text-muted-foreground">Everything has been read so far.</p>
  else
    body = (
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const line = lines[v.index]
          return (
            <div
              key={v.key}
              className="absolute inset-x-0 top-0 px-2"
              style={{ height: v.size, transform: `translateY(${v.start}px)` }}
            >
              {line.type === 'heading' ? (
                <h3 className="flex h-full items-end px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {line.title} · {formatNumber(line.count)}
                </h3>
              ) : (
                <UnreadableRow item={line.item} revealLabel={revealLabel} onShowInTree={showInTree} onReveal={reveal} />
              )}
            </div>
          )
        })}
      </div>
    )

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {list
            ? `DiskGrove couldn't read ${formatNumber(total)} ${total === 1 ? 'item' : 'items'}`
            : 'Unreadable items'}
        </DialogTitle>
        <DialogDescription>
          Their sizes aren't counted, so the folders that contain them show less than they use.{' '}
          {accessHint(meta?.platform)}
        </DialogDescription>
      </DialogHeader>
      <div className="rounded-md border bg-muted/30 text-xs">
        <ScrollArea orientation="vertical" className="max-h-80" viewportRef={viewportRef}>
          {body}
        </ScrollArea>
        {listed < total ? (
          <div className="border-t px-2 py-1.5 text-muted-foreground">
            Showing the first {formatNumber(listed)} found.
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={listed === 0} onClick={copyAll}>
          {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy paths'}
        </Button>
        <Button onClick={close}>Close</Button>
      </DialogFooter>
    </>
  )
}

// Memoized so the dialog re-rendering with scan progress leaves the rows alone.
const UnreadableRow = memo(function UnreadableRow({
  item,
  revealLabel,
  onShowInTree,
  onReveal
}: {
  item: UnreadableItem
  revealLabel: string | null
  onShowInTree: (item: UnreadableItem) => void
  onReveal: (item: UnreadableItem) => void
}) {
  return (
    <div className="flex h-full min-w-0 items-center gap-2 rounded px-1 hover:bg-accent/60">
      <FileGlyph name={item.path} kind={item.kind} />
      {/* Cut from the start: the end of a path says what the item is. */}
      <span className="truncate-start min-w-0 flex-1" title={item.path}>
        <bdi>{item.path}</bdi>
      </span>
      <span className="shrink-0 text-muted-foreground">{reasonOf(item.code)}</span>
      <span className="flex shrink-0 items-center">
        <RowAction
          label={item.folder === item.path ? 'Show in tree' : 'Show its folder in tree'}
          onClick={() => onShowInTree(item)}
        >
          <LocateFixed />
        </RowAction>
        {revealLabel ? (
          <RowAction label={revealLabel} onClick={() => onReveal(item)}>
            <FolderOpen />
          </RowAction>
        ) : null}
        <RowAction label="Copy path" onClick={() => void navigator.clipboard.writeText(item.path)}>
          <Copy />
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
    >
      {children}
    </Button>
  )
}

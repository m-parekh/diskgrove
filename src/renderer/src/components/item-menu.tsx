import { useRef, type ReactNode } from 'react'
import { Copy, ExternalLink, FolderOpen, FolderSearch, LocateFixed, Trash2 } from 'lucide-react'
import { formatNumber } from '@shared/format'
import type { NodeSummary } from '@shared/types'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useScan } from '@/scan-context'
import { canOpenFolders, revealLabel as revealLabelFor } from '@/lib/platform'

export function ItemMenu({
  item,
  selection,
  locate,
  children
}: {
  item: NodeSummary
  selection?: NodeSummary[]
  /** Offer "Show in tree", for lists that are not already the folder's contents. */
  locate?: boolean
  children: ReactNode
}) {
  const {
    meta,
    openItem,
    revealItem,
    setPendingDelete,
    startScan,
    selectPath,
    locateItem,
    searchInFolder,
    focusSearch
  } = useScan()
  const focusSearchOnClose = useRef(false)
  const revealLabel = revealLabelFor(meta?.platform)
  const openInApp = item.kind === 'dir' && !canOpenFolders(meta?.platform)
  const targets = selection && selection.length > 1 && selection.some((s) => s.path === item.path) ? selection : [item]
  const many = targets.length > 1

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          // The menu hands focus back to the row as it closes; the search box needs it instead.
          if (!focusSearchOnClose.current) return
          focusSearchOnClose.current = false
          event.preventDefault()
          focusSearch()
        }}
      >
        <ContextMenuItem onClick={() => (openInApp ? selectPath(item.path) : void openItem(item.path))}>
          <ExternalLink className="size-4" /> Open
        </ContextMenuItem>
        {revealLabel ? (
          <ContextMenuItem onClick={() => void revealItem(item.path)}>
            <FolderOpen className="size-4" /> {revealLabel}
          </ContextMenuItem>
        ) : null}
        {locate ? (
          <ContextMenuItem onClick={() => locateItem(item)}>
            <LocateFixed className="size-4" /> Show in tree
          </ContextMenuItem>
        ) : null}
        {item.kind === 'dir' ? (
          <>
            <ContextMenuItem
              onClick={() => {
                focusSearchOnClose.current = true
                searchInFolder(item.path)
              }}
            >
              <FolderSearch className="size-4" /> Search in this folder
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                selectPath(item.path)
                void startScan(item.path)
              }}
            >
              Scan this folder
            </ContextMenuItem>
          </>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => {
            void navigator.clipboard.writeText(targets.map((t) => t.path).join('\n'))
          }}
        >
          <Copy className="size-4" /> {many ? `Copy ${formatNumber(targets.length)} paths` : 'Copy path'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive" onClick={() => setPendingDelete(targets)}>
          <Trash2 className="size-4" /> {many ? `Delete ${formatNumber(targets.length)} items…` : 'Delete…'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

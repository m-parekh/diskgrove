import { useEffect, useState } from 'react'
import { Copy, ExternalLink, FolderOpen, PanelRight } from 'lucide-react'
import { extensionOf, formatBytes, formatDateLong, formatNumber } from '@shared/format'
import { previewKindOf } from '@shared/preview'
import type { ItemTimes, NodeSummary } from '@shared/types'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useScan } from '@/scan-context'
import { OfficeViewer } from './office-viewer'
import { PdfViewer } from './pdf-viewer'
import {
  AudioViewer,
  CsvViewer,
  IconPreview,
  ImageViewer,
  TextViewer,
  VideoViewer,
  ZipViewer,
  type InfoRow,
  type ViewerProps
} from './viewers'
import { canOpenFolders, revealLabel as revealLabelFor } from '@/lib/platform'

const COLLAPSED_ROWS = 4

const KIND_LABELS: Record<string, string> = {
  '.pdf': 'PDF document',
  '.docx': 'Microsoft Word document',
  '.docm': 'Microsoft Word document',
  '.doc': 'Microsoft Word 97–2003 document',
  '.xlsx': 'Microsoft Excel workbook',
  '.xlsm': 'Microsoft Excel workbook',
  '.xls': 'Microsoft Excel 97–2003 workbook',
  '.pptx': 'Microsoft PowerPoint presentation',
  '.pptm': 'Microsoft PowerPoint presentation',
  '.ppt': 'Microsoft PowerPoint 97–2003 presentation',
  '.csv': 'Comma-separated values',
  '.tsv': 'Tab-separated values',
  '.txt': 'Plain text document',
  '.log': 'Log file',
  '.md': 'Markdown document',
  '.json': 'JSON document',
  '.xml': 'XML document',
  '.html': 'HTML document',
  '.htm': 'HTML document',
  '.jpg': 'JPEG image',
  '.jpeg': 'JPEG image',
  '.png': 'PNG image',
  '.gif': 'GIF image',
  '.webp': 'WebP image',
  '.avif': 'AVIF image',
  '.svg': 'SVG image',
  '.bmp': 'Bitmap image',
  '.heic': 'HEIC image',
  '.mp4': 'MPEG-4 movie',
  '.m4v': 'MPEG-4 movie',
  '.mov': 'QuickTime movie',
  '.mkv': 'Matroska video',
  '.webm': 'WebM video',
  '.avi': 'AVI video',
  '.mp3': 'MP3 audio',
  '.m4a': 'MPEG-4 audio',
  '.wav': 'WAVE audio',
  '.flac': 'FLAC audio',
  '.ogg': 'Ogg audio',
  '.zip': 'ZIP archive',
  '.7z': '7-Zip archive',
  '.rar': 'RAR archive',
  '.iso': 'Disk image',
  '.dmg': 'Disk image',
  '.exe': 'Application',
  '.msi': 'Windows installer',
  '.app': 'Application'
}

function kindLabel(item: NodeSummary): string {
  if (item.kind === 'dir') return 'Folder'
  const ext = extensionOf(item.name)
  return KIND_LABELS[ext] ?? (ext === '(none)' ? 'Document' : `${ext.slice(1).toUpperCase()} file`)
}

function Viewer(props: ViewerProps) {
  const { item } = props
  if (item.kind === 'dir') return <IconPreview item={item} />
  if (item.size === 0) return <IconPreview item={item} message="This file is empty." />
  const kind = previewKindOf(item.name)
  switch (kind) {
    case 'image':
      return <ImageViewer {...props} />
    case 'video':
      return <VideoViewer {...props} />
    case 'audio':
      return <AudioViewer {...props} />
    case 'pdf':
      return <PdfViewer {...props} />
    case 'csv':
      return <CsvViewer {...props} />
    case 'docx':
    case 'xlsx':
    case 'pptx':
      return <OfficeViewer {...props} kind={kind} />
    case 'zip':
      return <ZipViewer {...props} />
    default:
      return <TextViewer {...props} />
  }
}

function InfoTable({ rows }: { rows: InfoRow[] }) {
  return (
    <dl className="divide-y divide-border/60 text-[12.5px]">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-4 py-1.5">
          <dt className="shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 flex-1 select-text break-words text-right font-medium" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function PreviewBody({ item }: { item: NodeSummary }) {
  const { meta, openItem, revealItem } = useScan()
  const [times, setTimes] = useState<ItemTimes | null>(null)
  const [details, setDetails] = useState<InfoRow[]>([])
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    let live = true
    window.diskgrove.getItemTimes(item.path).then(
      (t) => live && setTimes(t),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [item.path, item.mtime])

  const isDir = item.kind === 'dir'
  const rows: InfoRow[] = [
    ['Created', formatDateLong(times?.created ?? 0)],
    ['Modified', formatDateLong(times?.modified ?? item.mtime)],
    ['Last opened', formatDateLong(times?.accessed ?? item.atime)],
    ...(isDir
      ? ([
          ['Files', formatNumber(item.fileCount)],
          ['Folders', formatNumber(item.folderCount)]
        ] satisfies InfoRow[])
      : []),
    ['Size on disk', formatBytes(item.allocated)],
    ...details,
    ['Where', item.parentPath ?? item.path]
  ]
  const shown = expanded ? rows : rows.slice(0, COLLAPSED_ROWS)
  const revealLabel = revealLabelFor(meta?.platform)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea orientation="vertical" className="min-h-0 flex-1">
        <div className="h-[clamp(14rem,52vh,40rem)] border-b bg-muted/20 p-3">
          <Viewer item={item} onDetails={setDetails} />
        </div>
        <div className="space-y-4 p-4">
          <div className="space-y-0.5">
            <h2 className="select-text break-words text-[15px] font-semibold leading-snug">{item.name}</h2>
            <p className="text-[13px] text-muted-foreground">
              {kindLabel(item)} – {formatBytes(item.size)}
            </p>
          </div>
          <section>
            <div className="mb-1 flex items-baseline justify-between">
              <h3 className="text-[13px] font-semibold">Information</h3>
              {rows.length > COLLAPSED_ROWS ? (
                <button
                  type="button"
                  className="text-[12px] text-primary hover:underline"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              ) : null}
            </div>
            <InfoTable rows={shown} />
          </section>
        </div>
      </ScrollArea>
      <div className="flex shrink-0 items-center justify-center gap-1 border-t bg-card/60 px-2 py-1.5">
        {item.kind !== 'dir' || canOpenFolders(meta?.platform) ? (
          <Button variant="ghost" size="sm" onClick={() => void openItem(item.path)}>
            <ExternalLink /> Open
          </Button>
        ) : null}
        {revealLabel ? (
          <Button variant="ghost" size="sm" onClick={() => void revealItem(item.path)}>
            <FolderOpen /> {revealLabel}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          aria-label="Copy path"
          title="Copy path"
          onClick={() => void navigator.clipboard.writeText(item.path)}
        >
          <Copy />
        </Button>
      </div>
    </div>
  )
}

export function PreviewPane() {
  const { previewItem, selectedNode } = useScan()
  const item = previewItem ?? selectedNode
  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <PanelRight className="size-8" />
        Select a file to preview it.
      </div>
    )
  }
  return (
    <div className="h-full min-h-0 min-w-0 overflow-hidden bg-card/30">
      <PreviewBody key={item.path} item={item} />
    </div>
  )
}

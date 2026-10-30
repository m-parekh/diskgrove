import { useEffect, useState, type ReactNode } from 'react'
import { Loader2, Music } from 'lucide-react'
import { formatBytes, formatNumber } from '@shared/format'
import { mediaUrl } from '@shared/preview'
import type { NodeSummary } from '@shared/types'
import { FileGlyph } from '@/components/file-icon'
import { ScrollArea } from '@/components/ui/scroll-area'
import { parseDelimited, sniffDelimiter } from '@shared/csv'
import { fileReader } from '@/lib/file-reader'
import { ZipArchive } from '@shared/zip'
import { cn } from '@/lib/utils'
import { MediaPlayer } from './media-player'

export type InfoRow = [label: string, value: string]

export interface ViewerProps {
  item: NodeSummary
  onDetails: (rows: InfoRow[]) => void
}

const TEXT_LIMIT = 256 * 1024
const CSV_LIMIT = 1024 * 1024
const CSV_ROWS = 300
const ZIP_ENTRIES = 500

type AsyncState<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T }

export function errorMessage(err: unknown, fallback = 'Preview failed'): string {
  return err instanceof Error && err.message ? err.message : fallback
}

// Runs `load` when `key` changes and ignores results that arrive after a newer request.
export function useAsyncValue<T>(load: () => Promise<T>, key: string): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    load().then(
      (value) => live && setState({ status: 'ready', value }),
      (err) => live && setState({ status: 'error', message: errorMessage(err) })
    )
    return () => {
      live = false
    }
  }, [key])
  return state
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function Loading() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
    </div>
  )
}

export function IconPreview({ item, message }: { item: NodeSummary; message?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <FileGlyph name={item.name} kind={item.kind} className="size-24 stroke-[1.1]" />
      {message ? <p className="max-w-64 text-xs text-muted-foreground">{message}</p> : null}
    </div>
  )
}

function Frame({ children, footer, className }: { children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border bg-background">
      <ScrollArea className={cn('min-h-0 flex-1', className)}>{children}</ScrollArea>
      {footer}
    </div>
  )
}

export function TableView({ rows, header = true }: { rows: string[][]; header?: boolean }) {
  const [head, ...body] = header ? rows : [[], ...rows]
  return (
    <table className="w-max min-w-full border-collapse text-[11px] tabular">
      {header && head ? (
        <thead className="sticky top-0 bg-muted">
          <tr>
            {head.map((cell, i) => (
              <th
                key={i}
                className="max-w-56 truncate border-b border-r px-2 py-1 text-left font-semibold"
                title={cell}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
      ) : null}
      <tbody>
        {body.map((row, r) => (
          <tr key={r} className={cn(r % 2 === 1 && 'bg-muted/30')}>
            {row.map((cell, c) => (
              <td key={c} className="max-w-56 truncate border-b border-r border-border/60 px-2 py-0.5" title={cell}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// Android streams media through its WebView instead of the desktop media protocol.
function mediaSrc(item: NodeSummary): string {
  return window.diskgrove.mediaUrl?.(item.path, item.mtime) ?? mediaUrl(item.path, item.mtime)
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="border-t bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">{children}</p>
}

export function ImageViewer({ item, onDetails }: ViewerProps) {
  const [failed, setFailed] = useState(false)
  if (failed) return <IconPreview item={item} message="This image can't be displayed." />
  return (
    <div className="flex h-full items-center justify-center">
      <img
        src={mediaSrc(item)}
        alt=""
        draggable={false}
        className="max-h-full max-w-full rounded-sm object-contain shadow-md animate-fade"
        style={{
          backgroundImage: 'repeating-conic-gradient(#8882 0% 25%, transparent 0% 50%)',
          backgroundSize: '16px 16px'
        }}
        onLoad={(e) => {
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget
          if (w && h) onDetails([['Dimensions', `${formatNumber(w)} × ${formatNumber(h)}`]])
        }}
        onError={() => setFailed(true)}
      />
    </div>
  )
}

export function VideoViewer({ item, onDetails }: ViewerProps) {
  const [failed, setFailed] = useState(false)
  if (failed) return <IconPreview item={item} message="This video format can't be played here." />
  return (
    <MediaPlayer
      kind="video"
      title={item.name}
      src={mediaSrc(item)}
      onLoadedMetadata={(media) => {
        const v = media as HTMLVideoElement
        const rows: InfoRow[] = []
        if (v.videoWidth && v.videoHeight) {
          rows.push(['Dimensions', `${formatNumber(v.videoWidth)} × ${formatNumber(v.videoHeight)}`])
        }
        rows.push(['Duration', formatClock(v.duration)])
        onDetails(rows)
      }}
      onError={() => setFailed(true)}
    />
  )
}

export function AudioViewer({ item, onDetails }: ViewerProps) {
  const [failed, setFailed] = useState(false)
  const artwork = (
    <div className="flex size-32 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/30 to-sky-500/20">
      <Music className="size-14 text-violet-300" />
    </div>
  )
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-4">
      {failed ? (
        <>
          {artwork}
          <p className="text-xs text-muted-foreground">This audio format can't be played here.</p>
        </>
      ) : (
        <MediaPlayer
          kind="audio"
          src={mediaSrc(item)}
          artwork={artwork}
          onLoadedMetadata={(media) => onDetails([['Duration', formatClock(media.duration)]])}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  )
}

interface DecodedText {
  text: string
  encoding: string
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192)
  let control = 0
  for (const b of sample) {
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) control++
  }
  return sample.length > 0 && control / sample.length > 0.1
}

function decodeText(bytes: Uint8Array, truncated: boolean): DecodedText | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16 LE' }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16 BE' }
  }
  if (looksBinary(bytes)) return null
  try {
    // stream: true tolerates a multi-byte character cut off by the read limit.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes, { stream: truncated })
    return { text, encoding: 'UTF-8' }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Western (Windows 1252)' }
  }
}

async function readText(item: NodeSummary, limit: number) {
  const chunk = await window.diskgrove.readFile(item.path, 0, limit)
  const truncated = chunk.size > chunk.bytes.length
  const decoded = decodeText(chunk.bytes, truncated)
  if (!decoded) return null
  let text = decoded.text
  if (truncated) {
    const cut = text.lastIndexOf('\n')
    if (cut > 0) text = text.slice(0, cut)
  }
  return { ...decoded, text, truncated }
}

export function TextViewer({ item, onDetails }: ViewerProps) {
  const state = useAsyncValue(() => readText(item, TEXT_LIMIT), `${item.path}:${item.mtime}`)
  useEffect(() => {
    if (state.status !== 'ready' || !state.value) return
    const { text, encoding, truncated } = state.value
    const lines = text === '' ? 0 : text.split('\n').length
    onDetails([
      ['Encoding', encoding],
      ['Lines', truncated ? `${formatNumber(lines)}+` : formatNumber(lines)]
    ])
  }, [state, onDetails])

  if (state.status === 'loading') return <Loading />
  if (state.status === 'error') return <IconPreview item={item} message={state.message} />
  if (!state.value) return <IconPreview item={item} message="No preview available for this file." />
  return (
    <Frame footer={state.value.truncated ? <Note>Showing the first {formatBytes(TEXT_LIMIT)}</Note> : null}>
      <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11.5px] leading-snug select-text">
        {state.value.text}
      </pre>
    </Frame>
  )
}

export function CsvViewer({ item, onDetails }: ViewerProps) {
  const state = useAsyncValue(async () => {
    const text = await readText(item, CSV_LIMIT)
    if (!text) return null
    const delimiter = item.name.toLowerCase().endsWith('.tsv') ? '\t' : sniffDelimiter(text.text)
    return parseDelimited(text.text, delimiter, CSV_ROWS, !text.truncated)
  }, `${item.path}:${item.mtime}`)
  useEffect(() => {
    if (state.status !== 'ready' || !state.value) return
    const { rows, complete } = state.value
    const columns = rows.reduce((n, r) => Math.max(n, r.length), 0)
    onDetails([
      ['Columns', formatNumber(columns)],
      ['Rows', complete ? formatNumber(rows.length) : `First ${formatNumber(rows.length)} shown`]
    ])
  }, [state, onDetails])

  if (state.status === 'loading') return <Loading />
  if (state.status === 'error') return <IconPreview item={item} message={state.message} />
  if (!state.value || state.value.rows.length === 0) return <IconPreview item={item} message="This file is empty." />
  return (
    <Frame className="select-text">
      <TableView rows={state.value.rows} />
    </Frame>
  )
}

export function ZipViewer({ item, onDetails }: ViewerProps) {
  const state = useAsyncValue(async () => {
    const zip = await ZipArchive.open(fileReader(item.path), item.size)
    return zip.list().filter((e) => !e.name.endsWith('/'))
  }, `${item.path}:${item.mtime}`)
  useEffect(() => {
    if (state.status !== 'ready') return
    const total = state.value.reduce((n, e) => n + e.size, 0)
    onDetails([
      ['Items', formatNumber(state.value.length)],
      ['Uncompressed size', formatBytes(total)]
    ])
  }, [state, onDetails])

  if (state.status === 'loading') return <Loading />
  if (state.status === 'error') return <IconPreview item={item} message={state.message} />
  const entries = state.value
  return (
    <Frame
      footer={
        entries.length > ZIP_ENTRIES ? (
          <Note>
            Showing {formatNumber(ZIP_ENTRIES)} of {formatNumber(entries.length)} items
          </Note>
        ) : null
      }
    >
      <ul className="divide-y divide-border/50 text-[12px]">
        {entries.slice(0, ZIP_ENTRIES).map((entry) => (
          <li key={entry.name} className="flex items-center gap-2 py-1 pl-2 pr-3" title={entry.name}>
            <FileGlyph name={entry.name} kind="file" className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className="shrink-0 tabular text-muted-foreground">{formatBytes(entry.size)}</span>
          </li>
        ))}
      </ul>
    </Frame>
  )
}

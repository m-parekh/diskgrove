import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from 'react'
import { ArrowLeft, Loader2, Share2, Trash2 } from 'lucide-react'
import { formatBytes, formatCount, formatDate } from '@shared/format'
import type { MediaFile, MediaFileList, MediaKind } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'
import { androidFeatures, displayName, errorText, KIND_INFO } from './android-data'

/** How many of the largest files a list shows. */
const LIST_LIMIT = 500

function Thumb({ file }: { file: MediaFile }) {
  const [failed, setFailed] = useState(false)
  const url = androidFeatures()?.thumbnailUrl(file) ?? null
  const Icon = KIND_INFO[file.type].icon
  if (!url || failed) {
    return (
      <span
        className="flex size-11 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5"
        style={{
          background: `color-mix(in srgb, ${KIND_INFO[file.type].color} 18%, transparent)`,
          color: KIND_INFO[file.type].color
        }}
      >
        <Icon />
      </span>
    )
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      className="size-11 shrink-0 rounded-lg bg-secondary object-cover"
      onError={() => setFailed(true)}
    />
  )
}

/** The largest files of one kind, to open, share or delete. */
export function FilesPage({
  kind,
  onBack,
  onChanged,
  backRef
}: {
  kind: MediaKind
  onBack: () => void
  /** Files were deleted, so totals elsewhere are out of date. */
  onChanged: () => void
  /** Set to a handler that clears the selection on Android's back button, returning false if none. */
  backRef?: MutableRefObject<(() => boolean) | null>
}) {
  const { showToast } = useScan()
  const [list, setList] = useState<MediaFileList | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const info = KIND_INFO[kind]

  const load = useCallback(async () => {
    const android = androidFeatures()
    if (!android) return
    setLoading(true)
    try {
      const next = await android.mediaFiles(kind, LIST_LIMIT)
      const listed = new Set(next.files.map((f) => f.path))
      setList(next)
      setSelected((prev) => (prev.size === 0 ? prev : new Set([...prev].filter((p) => listed.has(p)))))
    } catch (err) {
      showToast(errorText(err, 'Could not list files'))
    } finally {
      setLoading(false)
    }
  }, [kind, showToast])

  // Files may have been added or removed by other apps while DiskGrove was in the background.
  useEffect(() => {
    void load()
    return androidFeatures()?.onResume(() => void load())
  }, [load])

  useEffect(() => {
    if (!backRef) return
    backRef.current = () => {
      if (selected.size === 0) return false
      setSelected(new Set())
      return true
    }
    return () => {
      backRef.current = null
    }
  }, [backRef, selected])

  const files = useMemo(() => list?.files ?? [], [list])
  const chosen = files.filter((f) => selected.has(f.path))
  const chosenBytes = chosen.reduce((n, f) => n + f.size, 0)
  const all = files.length > 0 && chosen.length === files.length

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  async function share() {
    try {
      await androidFeatures()?.shareMediaFiles(chosen.slice(0, 100).map((f) => f.path))
      if (chosen.length > 100) showToast('Android shares up to 100 files at a time; sent the first 100')
    } catch (err) {
      showToast(errorText(err, 'Could not share'))
    }
  }

  async function remove() {
    const android = androidFeatures()
    if (!android) return
    setBusy(true)
    try {
      const result = await android.deleteMediaFiles(chosen.map((f) => f.path))
      if (result.deleted.length === 0 && result.failed.length === 0) return
      const gone = new Set(result.deleted)
      setSelected((prev) => new Set([...prev].filter((p) => !gone.has(p))))
      setList((prev) =>
        prev
          ? {
              ...prev,
              count: prev.count - gone.size,
              bytes: prev.bytes - prev.files.filter((f) => gone.has(f.path)).reduce((n, f) => n + f.size, 0),
              files: prev.files.filter((f) => !gone.has(f.path))
            }
          : prev
      )
      const freed = files.filter((f) => gone.has(f.path)).reduce((n, f) => n + f.size, 0)
      showToast(
        result.failed.length > 0
          ? `Deleted ${formatCount(gone.size, 'file')}; ${formatCount(result.failed.length, 'file')} failed: ${result.failed[0].error}`
          : `Deleted ${formatCount(gone.size, 'file')} · freed ${formatBytes(freed)}`
      )
      if (gone.size > 0) onChanged()
    } catch (err) {
      showToast(errorText(err, 'Delete failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b bg-card/60 px-2 py-1.5">
        <Button variant="ghost" size="icon" aria-label="Back" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{info.label}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {list ? `${formatCount(list.count, 'file')} · ${formatBytes(list.bytes)}` : 'Listing files…'}
            {list && list.count > files.length ? ` · largest ${formatCount(files.length, 'file')} shown` : ''}
          </p>
        </div>
        {files.length > 0 ? (
          <label className="flex shrink-0 items-center gap-2 px-2 text-sm">
            <Checkbox
              checked={all ? true : chosen.length > 0 ? 'indeterminate' : false}
              onCheckedChange={() => setSelected(all ? new Set() : new Set(files.map((f) => f.path)))}
              aria-label="Select all"
            />
            All
          </label>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !list ? (
          <div className="flex justify-center p-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : files.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">Nothing here.</p>
        ) : (
          <ul className="divide-y">
            {files.map((file) => {
              const on = selected.has(file.path)
              return (
                <li key={file.path} className={cn('flex items-center gap-3 px-3 py-2', on && 'bg-primary/10')}>
                  <Checkbox
                    checked={on}
                    onCheckedChange={() => toggle(file.path)}
                    aria-label={`Select ${displayName(file.name)}`}
                  />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    onClick={() =>
                      selected.size > 0
                        ? toggle(file.path)
                        : void androidFeatures()
                            ?.openMediaFile(file.path)
                            .catch((err) => showToast(errorText(err, 'Could not open')))
                    }
                  >
                    <Thumb file={file} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{displayName(file.name)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {formatDate(file.modified)} · {file.path.slice(0, file.path.length - file.name.length - 1)}
                      </span>
                    </span>
                    <span className="shrink-0 tabular text-sm">{formatBytes(file.size)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {chosen.length > 0 ? (
        <div className="flex shrink-0 items-center gap-2 border-t bg-card px-3 py-2 animate-rise">
          <span className="min-w-0 flex-1 truncate text-sm">
            {formatCount(chosen.length, 'file')} · {formatBytes(chosenBytes)}
          </span>
          <Button variant="outline" disabled={busy} onClick={() => void share()}>
            <Share2 /> Share
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete
          </Button>
        </div>
      ) : null}
    </div>
  )
}

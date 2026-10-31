import { useState, type ReactNode } from 'react'
import { ChevronRight, FolderOpen, LayoutGrid, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { formatBytes, formatCount, formatPercent } from '@shared/format'
import type { AndroidAccess, MediaKind, MediaType } from '@shared/types'
import { DriveCard, RecentScans } from '@/components/start-screen'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'
import { appTotal, KIND_INFO, type HomeDataState } from './android-data'

const TYPE_ROWS: MediaType[] = ['images', 'videos', 'audio', 'documents', 'archives', 'apks', 'other']

interface Segment {
  label: string
  bytes: number
  color: string
}

export function AccessBanner({ access, onReview }: { access: AndroidAccess; onReview: () => void }) {
  const missing = [!access.files && 'files', access.appSizes && !access.usage && 'app sizes'].filter(Boolean)
  if (missing.length === 0) return null
  return (
    <Card className="flex items-start gap-3 border-primary/40 p-4">
      <ShieldAlert className="mt-0.5 size-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Some of your storage is hidden</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {!access.files
            ? 'Allow all files access to sort your files by type and analyze folders.'
            : 'Allow usage access to see how much space each app’s data and cache take.'}
        </p>
        <Button size="sm" className="mt-3" onClick={onReview}>
          Review access
        </Button>
      </div>
    </Card>
  )
}

function StorageBar({ segments, used, total }: { segments: Segment[]; used: number; total: number }) {
  const scale = Math.max(total, segments.reduce((n, s) => n + s.bytes, 0), 1)
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-secondary" role="img" aria-label="Storage by kind">
      {segments.map((s) =>
        s.bytes > 0 ? (
          <div
            key={s.label}
            className="h-full transition-[width] duration-500"
            style={{ width: `${(s.bytes / scale) * 100}%`, background: s.color }}
          />
        ) : null
      )}
      <span className="sr-only">
        {formatBytes(used)} of {formatBytes(total)} used
      </span>
    </div>
  )
}

export function StorageTab({
  access,
  data,
  onReviewAccess,
  onOpenKind,
  onOpenApps
}: {
  access: AndroidAccess
  data: HomeDataState
  onReviewAccess: () => void
  onOpenKind: (kind: MediaKind) => void
  onOpenApps: () => void
}) {
  const { drives, startScan, refreshDrives } = useScan()
  const [refreshing, setRefreshing] = useState(false)
  const { storage, summary, apps } = data
  const used = storage ? Math.max(0, storage.total - storage.free) : 0
  const appsBytes = apps ? apps.apps.reduce((n, a) => n + appTotal(a), 0) : 0
  const files = (kind: MediaKind) => summary?.[kind]?.bytes ?? 0
  const otherFiles = files('archives') + files('apks') + files('other')
  const known = appsBytes + files('images') + files('videos') + files('audio') + files('documents') + otherFiles
  const segments: Segment[] = [
    { label: 'Apps', bytes: appsBytes, color: 'var(--chart-8)' },
    { label: 'Images', bytes: files('images'), color: KIND_INFO.images.color },
    { label: 'Videos', bytes: files('videos'), color: KIND_INFO.videos.color },
    { label: 'Audio', bytes: files('audio'), color: KIND_INFO.audio.color },
    { label: 'Documents', bytes: files('documents'), color: KIND_INFO.documents.color },
    { label: 'Other files', bytes: otherFiles, color: KIND_INFO.other.color },
    // Android itself, app-private files DiskGrove cannot size, and anything else.
    { label: 'System & other', bytes: Math.max(0, used - known), color: 'var(--muted-foreground)' }
  ]

  return (
    <div className="stagger-children flex flex-col gap-5">
      <AccessBanner access={access} onReview={onReviewAccess} />

      <Card className="p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Device storage</h2>
          {data.loadingFiles ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
        </div>
        {storage ? (
          <>
            <p className="mt-2 text-2xl font-semibold tabular">
              {formatBytes(used)} <span className="text-base font-normal text-muted-foreground">used</span>
            </p>
            <p className="mb-3 text-sm text-muted-foreground">
              {formatBytes(storage.free)} free of {formatBytes(storage.total)} (
              {formatPercent((storage.free / Math.max(1, storage.total)) * 100)})
            </p>
            <StorageBar segments={segments} used={used} total={storage.total} />
            <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              {segments.map((s) => (
                <li key={s.label} className="flex min-w-0 items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="truncate">{s.label}</span>
                  <span className="ml-auto shrink-0 tabular text-muted-foreground">{formatBytes(s.bytes, 1)}</span>
                </li>
              ))}
            </ul>
            {apps && !apps.usageAccess ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Apps counts installed app files only; usage access adds their data and cache.
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Reading storage…</p>
        )}
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">By kind</h2>
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          <CategoryRow
            icon={<LayoutGrid />}
            color="var(--chart-8)"
            label="Apps"
            detail={apps ? formatCount(apps.apps.length, 'app') : 'Listing apps…'}
            bytes={apps ? appsBytes : null}
            onClick={onOpenApps}
          />
          {TYPE_ROWS.map((kind) => {
            const Icon = KIND_INFO[kind].icon
            const total = summary?.[kind]
            return (
              <CategoryRow
                key={kind}
                icon={<Icon />}
                color={KIND_INFO[kind].color}
                label={KIND_INFO[kind].label}
                detail={total ? formatCount(total.count, 'file') : access.files ? 'Counting…' : 'Needs all files access'}
                bytes={total ? total.bytes : null}
                disabled={!total || total.count === 0}
                onClick={() => onOpenKind(kind)}
              />
            )
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Analyze folders</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh storage"
            onClick={async () => {
              setRefreshing(true)
              try {
                await Promise.all([refreshDrives(), data.refreshFiles(), data.refreshApps()])
              } finally {
                setRefreshing(false)
              }
            }}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
          </Button>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          Scan a volume or folder for a folder tree, treemap, largest files and duplicates.
        </p>
        <div className="flex flex-col gap-3">
          {drives.map((drive, i) => (
            <DriveCard
              key={drive.path}
              drive={drive}
              delay={Math.min(i * 70, 350)}
              disabled={!access.files}
              onScan={() => void startScan(drive.path)}
            />
          ))}
          <Button
            variant="outline"
            disabled={!access.files}
            onClick={async () => {
              const folder = await window.diskgrove.pickFolder()
              if (folder) await startScan(folder)
            }}
          >
            <FolderOpen /> Select folder
          </Button>
        </div>
      </div>

      <RecentScans />
    </div>
  )
}

function CategoryRow({
  icon,
  color,
  label,
  detail,
  bytes,
  disabled,
  onClick
}: {
  icon: ReactNode
  color: string
  label: string
  detail: string
  bytes: number | null
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-accent/60 disabled:opacity-60"
      onClick={onClick}
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-full [&_svg]:size-4"
        style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      {bytes !== null ? <span className="shrink-0 tabular text-sm">{formatBytes(bytes)}</span> : null}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

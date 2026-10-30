import { useState } from 'react'
import { FolderOpen, HardDrive, Network, RefreshCw, Usb } from 'lucide-react'
import { formatBytes, formatDate, formatNumber, formatPercent } from '@shared/format'
import type { DriveInfo, DriveKind } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { isAndroid } from '@/lib/platform'
import { useScan } from '@/scan-context'

function kindIcon(kind: DriveKind) {
  if (kind === 'network') return Network
  if (kind === 'removable') return Usb
  return HardDrive
}

function DriveRing({ used, total }: { used: number; total: number }) {
  const r = 22
  const c = 2 * Math.PI * r
  const ratio = total > 0 ? Math.min(1, used / total) : 0
  const color = ratio > 0.9 ? 'var(--destructive)' : ratio > 0.75 ? 'var(--chart-3)' : 'var(--primary)'
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" className="shrink-0 max-sm:hidden">
      <circle cx="28" cy="28" r={r} fill="none" stroke="currentColor" className="text-border" strokeWidth="6" />
      <circle
        cx="28"
        cy="28"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="6"
        strokeLinecap="round"
        className="drive-ring"
        style={{ strokeDasharray: c, strokeDashoffset: c * (1 - ratio), ['--ring-circ' as string]: c }}
        transform="rotate(-90 28 28)"
      />
    </svg>
  )
}

export function StartScreen() {
  const { meta, drives, settings, startScan, refreshDrives } = useScan()
  const android = isAndroid(meta?.platform)
  const [refreshing, setRefreshing] = useState(false)

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="stagger-children mx-auto flex max-w-5xl flex-col gap-8 px-8 py-10 max-sm:gap-6 max-sm:px-4 max-sm:py-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Where did my disk space go?</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Scan a drive or folder to see {android ? 'a folder tree' : 'an Explorer-style tree'}, size bars, treemap,
            file types, and the largest files — all locally on your {android ? 'device' : 'machine'}.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={async () => {
              const folder = await window.diskgrove.pickFolder()
              if (folder) await startScan(folder)
            }}
          >
            <FolderOpen /> Select folder
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              setRefreshing(true)
              try {
                await refreshDrives()
              } finally {
                setRefreshing(false)
              }
            }}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} /> Refresh drives
          </Button>
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Drives</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {drives.map((drive, i) => (
              <DriveCard
                key={drive.path}
                drive={drive}
                delay={Math.min(i * 70, 350)}
                onScan={() => void startScan(drive.path)}
              />
            ))}
            {drives.length === 0 ? (
              <p className="text-sm text-muted-foreground">No drives detected. Try selecting a folder instead.</p>
            ) : null}
          </div>
        </div>

        {settings.recents.length > 0 ? (
          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Recent scans</h2>
            <div className="divide-y overflow-hidden rounded-xl border bg-card">
              {settings.recents.map((r, i) => (
                <button
                  key={r.path}
                  className="flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-accent/60 max-sm:flex-col max-sm:items-start max-sm:gap-0.5"
                  style={{ animationDelay: `${180 + i * 50}ms` }}
                  onClick={() => void startScan(r.path)}
                >
                  <span className="truncate font-medium max-sm:max-w-full">{r.path}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatBytes(r.size)} · {formatNumber(r.files)} files · {formatDate(r.scannedAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">DiskGrove {__APP_VERSION__}</p>
      </div>
    </ScrollArea>
  )
}

function DriveCard({ drive, delay, onScan }: { drive: DriveInfo; delay: number; onScan: () => void }) {
  const Icon = kindIcon(drive.kind)
  const ratio = drive.total ? drive.used / drive.total : 0
  return (
    <Card className="hover-lift animate-rise flex items-center gap-4 p-4" style={{ animationDelay: `${delay}ms` }}>
      <DriveRing used={drive.used} total={drive.total} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 max-sm:flex-wrap">
          <Icon className="size-4 text-sky-400" />
          <span className="font-semibold">{drive.label}</span>
          {drive.name ? <span className="truncate text-sm text-muted-foreground">{drive.name}</span> : null}
          {drive.fsType ? (
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
              {drive.fsType}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatBytes(drive.used)} used of {formatBytes(drive.total)} · {formatBytes(drive.free)} free (
          {formatPercent((1 - ratio) * 100)})
        </p>
        <Progress value={ratio * 100} className="mt-2" />
      </div>
      <Button onClick={onScan}>Scan</Button>
    </Card>
  )
}

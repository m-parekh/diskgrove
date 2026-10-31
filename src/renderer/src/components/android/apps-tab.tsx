import { useMemo, useState } from 'react'
import { BarChart3, ExternalLink, LayoutGrid, Loader2, Search, Settings2, Trash2 } from 'lucide-react'
import { formatBytes, formatCount, formatDate } from '@shared/format'
import type { AndroidAccess, InstalledApp } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'
import {
  androidFeatures,
  appTotal,
  errorText,
  lastActive,
  lastUsedText,
  unusedFor,
  type HomeDataState
} from './android-data'

export type AppSort = 'size' | 'cache' | 'data' | 'name' | 'lastUsed'
export type AppFilter = 'user' | 'system' | 'all' | 'unused'
export interface AppsView {
  sort: AppSort
  filter: AppFilter
}

/** Apps not opened for this many days count as unused. */
export const UNUSED_DAYS = 30

const SORTS: Array<{ id: AppSort; label: string; usage: boolean }> = [
  { id: 'size', label: 'Total size', usage: false },
  { id: 'cache', label: 'Cache size', usage: true },
  { id: 'data', label: 'Data size', usage: true },
  { id: 'lastUsed', label: 'Least recently used', usage: true },
  { id: 'name', label: 'Name', usage: false }
]

const FILTERS: Array<{ id: AppFilter; label: string; usage: boolean }> = [
  { id: 'user', label: 'Installed', usage: false },
  { id: 'unused', label: 'Unused', usage: true },
  { id: 'system', label: 'System', usage: false },
  { id: 'all', label: 'All', usage: false }
]

function sortValue(app: InstalledApp, sort: AppSort): number {
  if (sort === 'cache') return app.cacheBytes ?? 0
  if (sort === 'data') return app.dataBytes ?? 0
  return appTotal(app)
}

export function filterApps(apps: InstalledApp[], view: AppsView, query: string, now = Date.now()): InstalledApp[] {
  const q = query.trim().toLowerCase()
  const shown = apps.filter((app) => {
    if (view.filter === 'user' && app.system) return false
    if (view.filter === 'system' && !app.system) return false
    if (view.filter === 'unused' && (app.system || app.self || !unusedFor(app, UNUSED_DAYS, now))) return false
    return !q || app.label.toLowerCase().includes(q) || app.package.toLowerCase().includes(q)
  })
  const byName = (a: InstalledApp, b: InstalledApp) => a.label.localeCompare(b.label)
  if (view.sort === 'name') return shown.sort(byName)
  if (view.sort === 'lastUsed')
    return shown.sort((a, b) => (lastActive(a) ?? Infinity) - (lastActive(b) ?? Infinity) || byName(a, b))
  return shown.sort((a, b) => sortValue(b, view.sort) - sortValue(a, view.sort) || byName(a, b))
}

export function AppIcon({ pkg, className }: { pkg: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  const android = androidFeatures()
  if (failed || !android) {
    return (
      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary', className)}>
        <LayoutGrid className="size-5 text-muted-foreground" />
      </span>
    )
  }
  return (
    <img
      src={android.iconUrl(pkg)}
      alt=""
      loading="lazy"
      decoding="async"
      className={cn('size-10 shrink-0 rounded-xl object-contain', className)}
      onError={() => setFailed(true)}
    />
  )
}

export function AppsTab({
  access,
  data,
  view,
  onViewChange,
  onAccessChange
}: {
  access: AndroidAccess
  data: HomeDataState
  view: AppsView
  onViewChange: (view: AppsView) => void
  onAccessChange: (access: AndroidAccess) => void
}) {
  const { showToast } = useScan()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<InstalledApp | null>(null)
  const usage = data.apps?.usageAccess ?? access.usage
  const list = useMemo(
    () => (data.apps ? filterApps(data.apps.apps, view, query) : []),
    [data.apps, view, query]
  )
  const largest = list.reduce((n, a) => Math.max(n, sortValue(a, view.sort)), 1)
  const total = list.reduce((n, a) => n + appTotal(a), 0)
  const sortLabel = SORTS.find((s) => s.id === view.sort)?.label ?? ''

  return (
    <div className="flex flex-col gap-3">
      {!usage && access.appSizes ? (
        <Card className="flex items-start gap-3 border-primary/40 p-4">
          <BarChart3 className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">See data and cache sizes</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Without usage access Android only reports the size of each app&apos;s installed files.
            </p>
            <Button
              size="sm"
              className="mt-3"
              onClick={async () => {
                try {
                  onAccessChange(await androidFeatures()!.requestUsageAccess())
                } catch (err) {
                  showToast(errorText(err, 'Could not open the setting'))
                }
              }}
            >
              Allow usage access
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps"
            aria-label="Search apps"
            className="pl-8"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="shrink-0" aria-label={`Sort by ${sortLabel}`}>
              {sortLabel}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={view.sort}
              onValueChange={(sort) => onViewChange({ ...view, sort: sort as AppSort })}
            >
              {SORTS.map((s) => (
                <DropdownMenuRadioItem key={s.id} value={s.id} disabled={s.usage && !usage}>
                  {s.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div role="tablist" aria-label="Which apps" className="flex gap-1.5 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={view.filter === f.id}
            disabled={f.usage && !usage}
            className={cn(
              'h-8 shrink-0 rounded-full border px-3 text-sm transition-colors duration-150 disabled:opacity-50',
              view.filter === f.id ? 'border-primary bg-primary/15 text-foreground' : 'text-muted-foreground'
            )}
            onClick={() => onViewChange({ ...view, filter: f.id })}
          >
            {f.label}
          </button>
        ))}
      </div>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {data.apps ? `${formatCount(list.length, 'app')} · ${formatBytes(total)}` : 'Listing apps…'}
        {view.filter === 'unused' ? ` · not opened in ${UNUSED_DAYS} days` : ''}
        {data.loadingApps ? <Loader2 className="size-3.5 animate-spin" /> : null}
      </p>

      <div className="divide-y overflow-hidden rounded-xl border bg-card">
        {list.map((app) => (
          <button
            key={app.package}
            type="button"
            className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-accent/60"
            onClick={() => setOpen(app)}
          >
            <AppIcon pkg={app.package} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium">{app.label}</span>
                <span className="shrink-0 tabular text-sm">{formatBytes(sortValue(app, view.sort))}</span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {view.sort === 'lastUsed' || view.filter === 'unused'
                  ? `Last used: ${lastUsedText(app)}`
                  : app.appBytes !== undefined
                    ? `App ${formatBytes(app.appBytes, 1)} · Data ${formatBytes(app.dataBytes ?? 0, 1)} · Cache ${formatBytes(app.cacheBytes ?? 0, 1)}`
                    : app.package}
              </span>
              <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-secondary">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${(sortValue(app, view.sort) / largest) * 100}%` }}
                />
              </span>
            </span>
          </button>
        ))}
        {data.apps && list.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No apps to show.</p>
        ) : null}
      </div>

      <AppSheet app={open} onClose={() => setOpen(null)} onChanged={data.updateApp} />
    </div>
  )
}

function SizeCell({ label, bytes }: { label: string; bytes: number | undefined }) {
  return (
    <div className="rounded-lg bg-secondary/60 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular font-medium">{bytes === undefined ? '—' : formatBytes(bytes)}</div>
    </div>
  )
}

/** One app's figures, with Android's own screens for doing something about them. */
function AppSheet({
  app,
  onClose,
  onChanged
}: {
  app: InstalledApp | null
  onClose: () => void
  onChanged: (pkg: string, app: InstalledApp | null) => void
}) {
  const { showToast } = useScan()
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<InstalledApp | null>(app)
  // Show the latest figures for the app that was opened, without an effect.
  const current = shown && app && shown.package === app.package ? shown : app
  if (current !== shown) setShown(current)

  async function act(action: 'details' | 'uninstall' | 'open') {
    const android = androidFeatures()
    if (!android || !current) return
    setBusy(true)
    try {
      if (action === 'open') {
        await android.openApp(current.package)
        return
      }
      const before = appTotal(current)
      const next =
        action === 'details' ? await android.appDetails(current.package) : await android.uninstallApp(current.package)
      onChanged(current.package, next)
      if (!next) {
        showToast(`Uninstalled ${current.label}`)
        onClose()
        return
      }
      setShown(next)
      const freed = before - appTotal(next)
      if (freed > 0) showToast(`Freed ${formatBytes(freed)}`)
    } catch (err) {
      showToast(errorText(err, 'Android could not do that'))
    } finally {
      setBusy(false)
    }
  }

  const canUninstall = current && !current.self && (!current.system || current.updatedSystem)
  return (
    <Dialog open={app !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {current ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3 pr-6">
                <AppIcon pkg={current.package} className="size-12" />
                <div className="min-w-0">
                  <DialogTitle className="truncate">{current.label}</DialogTitle>
                  <DialogDescription className="truncate">
                    {current.package}
                    {current.version ? ` · ${current.version}` : ''}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <SizeCell label="Total" bytes={appTotal(current)} />
              <SizeCell label="App" bytes={current.appBytes ?? current.apkBytes} />
              <SizeCell label="Data" bytes={current.dataBytes} />
              <SizeCell label="Cache" bytes={current.cacheBytes} />
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Last used</dt>
              <dd>{lastUsedText(current)}</dd>
              <dt className="text-muted-foreground">Installed</dt>
              <dd>{formatDate(current.installed)}</dd>
              <dt className="text-muted-foreground">Updated</dt>
              <dd>{formatDate(current.updated)}</dd>
              {current.system ? (
                <>
                  <dt className="text-muted-foreground">Kind</dt>
                  <dd>{current.updatedSystem ? 'Preinstalled, updated' : 'Preinstalled'}</dd>
                </>
              ) : null}
              {current.externalCacheBytes ? (
                <>
                  <dt className="text-muted-foreground">Shared cache</dt>
                  <dd>{formatBytes(current.externalCacheBytes)}</dd>
                </>
              ) : null}
            </dl>
            <p className="text-xs text-muted-foreground">
              Android lets only its own App info screen clear an app&apos;s cache or storage.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void act('details')}>
                {busy ? <Loader2 className="animate-spin" /> : <Settings2 />} App info
              </Button>
              {current.launchable && !current.self ? (
                <Button variant="outline" disabled={busy} onClick={() => void act('open')}>
                  <ExternalLink /> Open
                </Button>
              ) : null}
              {canUninstall ? (
                <Button variant="destructive" disabled={busy} onClick={() => void act('uninstall')}>
                  <Trash2 /> {current.updatedSystem ? 'Uninstall updates' : 'Uninstall'}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

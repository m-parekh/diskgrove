import { useState, type ReactNode } from 'react'
import { BrushCleaning, Copy, Database, Hourglass, Loader2, Smartphone } from 'lucide-react'
import { formatBytes, formatCount } from '@shared/format'
import type { AndroidAccess, MediaKind } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useScan } from '@/scan-context'
import { androidFeatures, appTotal, errorText, KIND_INFO, unusedFor, type HomeDataState } from './android-data'
import { UNUSED_DAYS, type AppsView } from './apps-tab'
import { AccessBanner } from './storage-tab'

function Suggestion({
  icon,
  title,
  size,
  children,
  actions
}: {
  icon: ReactNode
  title: string
  size?: string
  children: ReactNode
  actions: ReactNode
}) {
  return (
    <Card className="flex gap-3 p-4">
      <div className="mt-0.5 shrink-0 text-primary [&_svg]:size-5">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">{title}</span>
          {size ? <span className="shrink-0 tabular text-sm font-medium">{size}</span> : null}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{children}</p>
        <div className="mt-3 flex flex-wrap gap-2">{actions}</div>
      </div>
    </Card>
  )
}

const FILE_SUGGESTIONS: Array<{ kind: MediaKind; text: string }> = [
  { kind: 'large', text: 'Files of 50 MB or more, such as videos, backups and disk images.' },
  { kind: 'oldScreenshots', text: 'Screenshots older than 30 days. Most were only needed for a moment.' },
  { kind: 'downloads', text: 'Everything in your Download folders.' },
  { kind: 'apks', text: 'Installer files. Apps keep working after their installer is deleted.' },
  {
    kind: 'trash',
    text: 'Files apps moved to the trash. Android deletes them for good 30 days after; you can do it now.'
  }
]

export function CleanTab({
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
  onOpenApps: (view: AppsView) => void
}) {
  const { meta, startScan, setTab, showToast } = useScan()
  const [clearing, setClearing] = useState(false)
  const apps = data.apps?.apps ?? []
  const usage = data.apps?.usageAccess ?? false
  const cache = apps.reduce((n, a) => n + (a.cacheBytes ?? 0), 0)
  const sharedCache = apps.reduce((n, a) => n + (a.externalCacheBytes ?? 0), 0)
  const unused = apps.filter((a) => !a.system && !a.self && unusedFor(a, UNUSED_DAYS))
  const files = FILE_SUGGESTIONS.filter(({ kind }) => (data.summary?.[kind]?.count ?? 0) > 0)

  async function clearCaches() {
    const android = androidFeatures()
    if (!android) return
    setClearing(true)
    try {
      const cleared = await android.clearAppCaches()
      showToast(cleared ? 'Android cleared app caches in shared storage' : 'Nothing was cleared')
      if (cleared) await Promise.all([data.refreshApps(), data.refreshFiles()])
    } catch (err) {
      showToast(errorText(err, 'Android could not clear app caches'))
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="stagger-children flex flex-col gap-3">
      <AccessBanner access={access} onReview={onReviewAccess} />

      {usage ? (
        <Suggestion
          icon={<Database />}
          title="App caches"
          size={formatBytes(cache)}
          actions={
            <>
              <Button size="sm" onClick={() => onOpenApps({ sort: 'cache', filter: 'all' })}>
                Review apps
              </Button>
              {access.clearCache && access.files ? (
                <Button size="sm" variant="outline" disabled={clearing} onClick={() => void clearCaches()}>
                  {clearing ? <Loader2 className="animate-spin" /> : null}
                  Clear shared caches
                </Button>
              ) : null}
            </>
          }
        >
          Data apps keep to load faster and can fetch again. Clear an app&apos;s cache from its App info screen
          {access.clearCache ? ', or let Android clear what every app caches in shared storage' : ''}
          {sharedCache > 0 ? ` (${formatBytes(sharedCache)})` : ''}.
        </Suggestion>
      ) : null}

      {usage && unused.length > 0 ? (
        <Suggestion
          icon={<Hourglass />}
          title="Unused apps"
          size={formatBytes(unused.reduce((n, a) => n + appTotal(a), 0))}
          actions={
            <Button size="sm" onClick={() => onOpenApps({ sort: 'size', filter: 'unused' })}>
              Review {formatCount(unused.length, 'app')}
            </Button>
          }
        >
          Apps you have not opened in {UNUSED_DAYS} days. Uninstalling one frees its app, data and cache.
        </Suggestion>
      ) : null}

      {files.map(({ kind, text }) => {
        const Icon = KIND_INFO[kind].icon
        const total = data.summary![kind]
        return (
          <Suggestion
            key={kind}
            icon={<Icon />}
            title={KIND_INFO[kind].label}
            size={formatBytes(total.bytes)}
            actions={
              <Button size="sm" onClick={() => onOpenKind(kind)}>
                Review {formatCount(total.count, 'file')}
              </Button>
            }
          >
            {text}
          </Suggestion>
        )
      })}

      <Suggestion
        icon={<Copy />}
        title="Duplicate files"
        actions={
          <Button
            size="sm"
            disabled={!access.files || !meta?.home}
            onClick={async () => {
              if (!meta?.home) return
              setTab('duplicates')
              await startScan(meta.home)
            }}
          >
            Scan for duplicates
          </Button>
        }
      >
        Scan your storage for files with the same content, and keep one copy of each.
      </Suggestion>

      <Suggestion
        icon={<Smartphone />}
        title="Android's storage tools"
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void androidFeatures()
                ?.manageStorage()
                .catch((err) => showToast(errorText(err, 'This device has no storage manager')))
            }
          >
            <BrushCleaning /> Free up space
          </Button>
        }
      >
        Android&apos;s own screen for freeing space, which can also remove backed-up photos and offload apps.
      </Suggestion>
    </div>
  )
}

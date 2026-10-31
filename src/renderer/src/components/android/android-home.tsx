import { useCallback, useEffect, useRef, useState } from 'react'
import { BrushCleaning, HardDrive, LayoutGrid, ShieldCheck, type LucideIcon } from 'lucide-react'
import type { MediaKind } from '@shared/types'
import { AppLogo } from '@/components/app-logo'
import { SettingsMenu, ThemeMenu } from '@/components/ribbon'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'
import { AccessList } from './access-panel'
import { useAndroidAccess, useHomeData } from './android-data'
import { AppsTab, type AppsView } from './apps-tab'
import { CleanTab } from './clean-tab'
import { FilesPage } from './files-page'
import { StorageTab } from './storage-tab'

type HomeTab = 'storage' | 'apps' | 'clean'
type Page = { kind: MediaKind } | 'access' | null

const TABS: Array<{ id: HomeTab; label: string; icon: LucideIcon }> = [
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'apps', label: 'Apps', icon: LayoutGrid },
  { id: 'clean', label: 'Clean', icon: BrushCleaning }
]

// Where the user was, so coming back from a folder scan returns them there.
let lastTab: HomeTab = 'storage'

/** The Android app's home: storage by kind, installed apps, and suggestions for freeing space. */
export function AndroidHome() {
  const { showToast } = useScan()
  const { access, setAccess } = useAndroidAccess()
  const data = useHomeData(access, showToast)
  const [tab, setTabState] = useState<HomeTab>(lastTab)
  const [page, setPage] = useState<Page>(null)
  const [appsView, setAppsView] = useState<AppsView>({ sort: 'size', filter: 'user' })
  const scroller = useRef<HTMLDivElement>(null)
  const pageBack = useRef<(() => boolean) | null>(null)

  const setTab = useCallback((next: HomeTab) => {
    lastTab = next
    setTabState(next)
    scroller.current?.scrollTo({ top: 0 })
  }, [])

  // Back clears a selection, then leaves a list or the access page, then returns to the Storage tab.
  useEffect(
    () =>
      window.diskgrove.onBackButton?.(() => {
        if (pageBack.current?.()) return true
        if (page) {
          setPage(null)
          return true
        }
        if (tab !== 'storage') {
          setTab('storage')
          return true
        }
        return false
      }),
    [page, tab, setTab]
  )

  if (!access) return <div className="flex-1" />

  if (page && page !== 'access') {
    return (
      <FilesPage
        kind={page.kind}
        onBack={() => setPage(null)}
        onChanged={() => void data.refreshFiles()}
        backRef={pageBack}
      />
    )
  }

  const openKind = (kind: MediaKind) => setPage({ kind })
  const reviewAccess = () => setPage('access')
  const openApps = (view?: AppsView) => {
    if (view) setAppsView(view)
    setTab('apps')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b bg-card px-3 py-1.5">
        <AppLogo className="mr-1.5 size-6 shrink-0" />
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
          {page === 'access' ? 'Access' : TABS.find((t) => t.id === tab)?.label}
        </h1>
        <Button
          variant={page === 'access' ? 'secondary' : 'ghost'}
          size="icon"
          aria-label="Access"
          onClick={() => setPage(page === 'access' ? null : 'access')}
        >
          <ShieldCheck />
        </Button>
        <ThemeMenu />
        <SettingsMenu />
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div key={page ?? tab} className="mx-auto max-w-2xl px-3 py-4 animate-pane">
          {page === 'access' ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                What DiskGrove may read and do. Changes take effect when you come back from Android&apos;s settings.
              </p>
              <AccessList access={access} onChange={setAccess} onError={showToast} />
            </div>
          ) : tab === 'storage' ? (
            <StorageTab
              access={access}
              data={data}
              onReviewAccess={reviewAccess}
              onOpenKind={openKind}
              onOpenApps={() => openApps()}
            />
          ) : tab === 'apps' ? (
            <AppsTab access={access} data={data} view={appsView} onViewChange={setAppsView} onAccessChange={setAccess} />
          ) : (
            <CleanTab
              access={access}
              data={data}
              onReviewAccess={reviewAccess}
              onOpenKind={openKind}
              onOpenApps={openApps}
            />
          )}
        </div>
      </div>

      <nav aria-label="Home" className="grid shrink-0 grid-cols-3 border-t bg-card">
        {TABS.map((item) => {
          const Icon = item.icon
          const active = page === null && tab === item.id
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              className="flex flex-col items-center gap-0.5 py-2 text-xs font-medium"
              onClick={() => {
                setPage(null)
                setTab(item.id)
              }}
            >
              <span
                className={cn(
                  'flex h-7 w-14 items-center justify-center rounded-full transition-colors duration-150 [&_svg]:size-5',
                  active ? 'bg-primary/20 text-primary' : 'text-muted-foreground'
                )}
              >
                <Icon />
              </span>
              <span className={active ? 'text-foreground' : 'text-muted-foreground'}>{item.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}

import { useState, type ReactNode } from 'react'
import { BarChart3, Check, FolderLock, LayoutGrid, Loader2, ShieldCheck, Trash2 } from 'lucide-react'
import type { AndroidAccess } from '@shared/types'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { androidFeatures } from './android-data'

function AccessRow({
  icon,
  title,
  children,
  granted,
  where,
  action
}: {
  icon: ReactNode
  title: string
  children: ReactNode
  granted: boolean
  /** Where Android keeps the switch, for users who want to change it later. */
  where?: string
  action?: ReactNode
}) {
  return (
    <li className="flex gap-3 rounded-xl border bg-card p-4">
      <div className="mt-0.5 shrink-0 text-primary [&_svg]:size-5">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{title}</span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium',
              granted ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
            )}
          >
            {granted ? 'Allowed' : 'Not allowed'}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{children}</p>
        {where ? <p className="mt-1 text-xs text-muted-foreground/80">{where}</p> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </li>
  )
}

/**
 * Everything DiskGrove can be allowed to reach on Android. Android 11 and later keep the strongest of
 * these, all files access and usage access, behind switches in the system settings, so each comes with
 * a button that opens the right one.
 */
export function AccessList({
  access,
  onChange,
  onError
}: {
  access: AndroidAccess
  onChange: (access: AndroidAccess) => void
  onError: (message: string) => void
}) {
  const [asking, setAsking] = useState<'files' | 'usage' | null>(null)

  async function ask(which: 'files' | 'usage') {
    const android = androidFeatures()
    if (!android) return
    setAsking(which)
    try {
      onChange(which === 'files' ? await android.requestFilesAccess() : await android.requestUsageAccess())
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not open the setting')
      try {
        onChange(await android.access())
      } catch {
        // The last answer stands.
      }
    } finally {
      setAsking(null)
    }
  }

  function allow(which: 'files' | 'usage', granted: boolean, label: string) {
    if (granted) return null
    return (
      <Button size="sm" disabled={asking !== null} onClick={() => void ask(which)}>
        {asking === which ? <Loader2 className="animate-spin" /> : null}
        {label}
      </Button>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      <AccessRow
        icon={<FolderLock />}
        title="All files access"
        granted={access.files}
        where={
          access.allFilesSetting
            ? 'Settings › Apps › Special app access › All files access'
            : 'Settings › Apps › DiskGrove › Permissions › Files and media'
        }
        action={allow('files', access.files, access.allFilesSetting ? 'Open setting' : 'Allow')}
      >
        Measure every folder, sort files into photos, videos, documents and more, find large and duplicate files,
        and delete the ones you pick. Android still keeps each app&apos;s private folders (Android/data and
        Android/obb) closed to other apps; their size shows up under Apps instead.
      </AccessRow>
      <AccessRow
        icon={<BarChart3 />}
        title="Usage access"
        granted={access.usage}
        where={access.appSizes ? 'Settings › Apps › Special app access › Usage access' : undefined}
        action={access.appSizes ? allow('usage', access.usage, 'Open setting') : null}
      >
        {access.appSizes
          ? "See how much space each app's code, data and cache take, and which apps you have not opened in a while."
          : 'App sizes need Android 8.0 or later.'}
      </AccessRow>
      <AccessRow icon={<LayoutGrid />} title="See installed apps" granted={access.packages}>
        List every app on this device, not only those Android shows to all apps. Granted when DiskGrove was
        installed.
      </AccessRow>
      <AccessRow icon={<Trash2 />} title="Request uninstalls" granted={access.uninstall}>
        Open Android&apos;s uninstall dialog for an app you pick. Nothing is removed unless you confirm there.
        Granted when DiskGrove was installed.
      </AccessRow>
    </ul>
  )
}

/** The first screen: what DiskGrove asks for and why, before it shows anything else. */
export function AccessOnboarding({
  access,
  onChange,
  onContinue
}: {
  access: AndroidAccess
  onChange: (access: AndroidAccess) => void
  onContinue: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const everything = access.files && (access.usage || !access.appSizes)
  return (
    <main className="h-full overflow-auto bg-background">
      <div className="mx-auto flex max-w-xl flex-col gap-5 px-4 py-8">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <AppLogo className="size-5 text-muted-foreground" /> DiskGrove
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Let DiskGrove see your storage</h1>
          <p className="text-sm text-muted-foreground">
            The more DiskGrove may read, the more space it can find. Each switch below opens the matching Android
            setting; turn it on there, then come back.
          </p>
        </div>
        <AccessList access={access} onChange={onChange} onError={setError} />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          DiskGrove has no internet permission. Everything it reads stays on this device, and it only deletes what
          you confirm.
        </p>
        <Button size="lg" variant={everything ? 'default' : 'outline'} onClick={onContinue}>
          {everything ? <Check /> : null}
          {everything ? 'Continue' : 'Continue with limited access'}
        </Button>
      </div>
    </main>
  )
}

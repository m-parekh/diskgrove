import { useEffect, useState, type ReactNode } from 'react'
import { Loader2, Minus, Square, X } from 'lucide-react'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TRAFFIC_LIGHT_INSET } from '@shared/title-bar'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'
import { isAndroid } from '@/lib/platform'

function CaptionButton({
  label,
  onClick,
  destructive,
  children
}: {
  label: string
  onClick: () => void
  destructive?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          onClick={onClick}
          onDoubleClick={(event) => event.stopPropagation()}
          className={cn(
            'app-no-drag h-10 w-11 rounded-none text-muted-foreground active:scale-100',
            destructive
              ? 'hover:bg-destructive hover:text-destructive-foreground'
              : 'hover:bg-accent hover:text-foreground'
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

export function TitleBar() {
  const { view, rootPath, scanning, complete, meta, settings } = useScan()
  const [maximized, setMaximized] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  const isMac = meta?.platform === 'darwin'
  // Android apps have no window to move, resize or close.
  const windowed = !isAndroid(meta?.platform)

  useEffect(() => {
    const api = window.diskgrove
    if (!api?.isMaximized) return
    void api.isMaximized().then(setMaximized)
    return api.onMaximized(setMaximized)
  }, [])

  useEffect(() => {
    const api = window.diskgrove
    if (!isMac || !api?.isFullScreen) return
    void api.isFullScreen().then(setFullScreen)
    return api.onFullScreen(setFullScreen)
  }, [isMac])

  // The native traffic lights are not zoomed with the page, so their inset is converted to CSS pixels.
  // macOS hides them in full screen.
  const trafficLightInset = isMac && !fullScreen ? TRAFFIC_LIGHT_INSET / (settings.fontScale / 100) : undefined

  return (
    <header
      className="app-drag flex h-10 shrink-0 select-none items-center border-b bg-card text-sm"
      onDoubleClick={isMac || !windowed ? undefined : () => void window.diskgrove?.toggleMaximize()}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3" style={{ paddingLeft: trafficLightInset }}>
        <AppLogo className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-semibold">DiskGrove</span>
        <span className="hidden shrink-0 whitespace-nowrap text-muted-foreground lg:inline">Disk Space Analyzer</span>
        {view === 'scan' && rootPath ? (
          <>
            <Separator orientation="vertical" className="mx-1 h-4" />
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {scanning ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin text-primary" />
                  Scanning · {rootPath}
                </span>
              ) : (
                <>
                  {complete?.cancelled ? 'Partial scan' : 'Scanned'} · {rootPath}
                </>
              )}
            </span>
          </>
        ) : null}
      </div>
      {isMac || !windowed ? null : (
        <div className="app-no-drag ml-auto flex h-full items-stretch">
          <CaptionButton label="Minimize" onClick={() => void window.diskgrove.minimize()}>
            <Minus className="size-3.5" />
          </CaptionButton>
          <CaptionButton
            label={maximized ? 'Restore' : 'Maximize'}
            onClick={() => void window.diskgrove.toggleMaximize()}
          >
            {maximized ? (
              <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
                <rect x="3.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <rect x="1.5" y="3.5" width="7" height="7" fill="var(--card)" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            ) : (
              <Square className="size-3" />
            )}
          </CaptionButton>
          <CaptionButton label="Close" destructive onClick={() => void window.diskgrove.closeWindow()}>
            <X className="size-3.5" />
          </CaptionButton>
        </div>
      )}
    </header>
  )
}

import type { ReactElement, ReactNode } from 'react'
import {
  AArrowDown,
  AArrowUp,
  BarChart3,
  ChevronDown,
  Copy,
  Download,
  FolderOpen,
  Home,
  LayoutGrid,
  Palette,
  PanelRight,
  PieChart,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Square,
  Table2,
  Clock,
  FileType2,
  Files
} from 'lucide-react'
import type { RightTab, ThemeMode } from '@shared/types'
import { THEME_OPTIONS } from '@shared/themes'
import { DEFAULT_FONT_SCALE, FONT_SCALES, stepFontScale } from '@shared/font-scale'
import { SearchBox } from '@/components/search-box'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useCompactLayout } from '@/hooks/use-compact'
import { useScan } from '@/scan-context'

const TABS: Array<{ id: RightTab; label: string; icon: typeof Table2 }> = [
  { id: 'details', label: 'Details', icon: Table2 },
  { id: 'treemap', label: 'Treemap', icon: LayoutGrid },
  { id: 'pie', label: 'Pie chart', icon: PieChart },
  { id: 'bar', label: 'Bar chart', icon: BarChart3 },
  { id: 'extensions', label: 'Extensions', icon: FileType2 },
  { id: 'topfiles', label: 'Top files', icon: Files },
  { id: 'age', label: 'File age', icon: Clock },
  { id: 'duplicates', label: 'Duplicates', icon: Copy }
]

/** The name of a view tab, as the ribbon labels it. */
export function tabLabel(tab: RightTab): string {
  return (TABS.find((item) => item.id === tab) ?? SEARCH_TAB).label
}

function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function Ribbon() {
  return useCompactLayout() ? <CompactRibbon /> : <WideRibbon />
}

function WideRibbon() {
  const { view, tab, setTab, scanning, rootPath, startScan, cancelScan, goHome, settings, applySettings } = useScan()

  // The ribbon never wraps. As the window narrows (or the zoom grows), labels
  // collapse to icons in tiers and the search box absorbs what's left:
  //   >= 2xl  everything labelled
  //   >= xl   view tabs icon-only
  //   >= lg   preview icon-only too
  //   <  lg   all icons; search shrinks to its minimum
  return (
    <div className="app-no-drag relative flex shrink-0 flex-nowrap items-center gap-0.5 border-b bg-card/60 px-2 py-1.5 lg:gap-1">
      <Tip label="Home">
        <Button variant="ghost" size="sm" className="shrink-0" aria-label="Home" onClick={goHome}>
          <Home />
          <span className="hidden lg:inline">Home</span>
        </Button>
      </Tip>
      <Tip label="Select folder">
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          aria-label="Select folder"
          onClick={async () => {
            const folder = await window.diskgrove.pickFolder()
            if (folder) await startScan(folder)
          }}
        >
          <FolderOpen />
          <span className="hidden lg:inline">Select</span>
        </Button>
      </Tip>
      <Tip label="Rescan">
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          aria-label="Rescan"
          disabled={!rootPath || scanning}
          onClick={() => rootPath && void startScan(rootPath)}
        >
          <RefreshCw className={cn(scanning && 'animate-spin')} />
          <span className="hidden lg:inline">Refresh</span>
        </Button>
      </Tip>
      <Tip label="Stop scan">
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          aria-label="Stop scan"
          disabled={!scanning}
          onClick={() => void cancelScan()}
        >
          <Square />
          <span className="hidden lg:inline">Stop</span>
        </Button>
      </Tip>

      <Separator orientation="vertical" className="mx-1 h-6 shrink-0" />

      {TABS.map((item) => {
        const Icon = item.icon
        return (
          <Tip key={item.id} label={item.label}>
            <Button
              variant={tab === item.id ? 'secondary' : 'ghost'}
              size="sm"
              disabled={view !== 'scan'}
              aria-label={item.label}
              className={cn(
                'shrink-0 transition-[background-color,color,box-shadow] duration-150',
                tab === item.id && 'text-foreground'
              )}
              onClick={() => setTab(item.id)}
            >
              <Icon />
              <span className="hidden 2xl:inline">{item.label}</span>
            </Button>
          </Tip>
        )
      })}

      <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-0.5 lg:gap-1">
        <SearchBox />
        <Tip label={settings.showPreview ? 'Hide preview' : 'Show preview'}>
          <Button
            variant={settings.showPreview && view === 'scan' ? 'secondary' : 'ghost'}
            size="sm"
            className="shrink-0"
            disabled={view !== 'scan'}
            aria-label={settings.showPreview ? 'Hide preview' : 'Show preview'}
            aria-pressed={settings.showPreview}
            onClick={() => void applySettings({ showPreview: !settings.showPreview })}
          >
            <PanelRight />
            <span className="hidden xl:inline">Preview</span>
          </Button>
        </Tip>
        <ExportMenu />
        <ThemeMenu />
        <SettingsMenu />
      </div>
      {scanning ? <ScanLine /> : null}
    </div>
  )
}

function ScanLine() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-primary/15">
      <div className="animate-scan-line h-full w-1/3 rounded-full bg-primary" />
    </div>
  )
}

const SEARCH_TAB = { id: 'search' as const, label: 'Search results', icon: Search }

/** Two rows for a phone: the actions and a view picker, then the search box at full width. */
function CompactRibbon() {
  const { view, tab, setTab, scanning, rootPath, startScan, cancelScan, goHome } = useScan()
  const current = TABS.find((item) => item.id === tab) ?? SEARCH_TAB
  const CurrentIcon = current.icon
  return (
    <div className="relative flex shrink-0 flex-col gap-1.5 border-b bg-card/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-0.5">
        <Button variant="ghost" size="icon" className="shrink-0" aria-label="Home" onClick={goHome}>
          <Home />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label="Select folder"
          onClick={async () => {
            const folder = await window.diskgrove.pickFolder()
            if (folder) await startScan(folder)
          }}
        >
          <FolderOpen />
        </Button>
        {scanning ? (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label="Stop scan"
            onClick={() => void cancelScan()}
          >
            <Square />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label="Rescan"
            disabled={!rootPath}
            onClick={() => rootPath && void startScan(rootPath)}
          >
            <RefreshCw />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              className="ml-1 min-w-0 shrink"
              disabled={view !== 'scan'}
              aria-label={`View: ${current.label}`}
            >
              <CurrentIcon />
              <span className="truncate">{current.label}</span>
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuRadioGroup value={tab} onValueChange={(value) => setTab(value as RightTab)}>
              {TABS.map((item) => {
                const Icon = item.icon
                return (
                  <DropdownMenuRadioItem key={item.id} value={item.id}>
                    <Icon className="size-4" />
                    {item.label}
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <ExportMenu />
          <ThemeMenu />
          <SettingsMenu />
        </div>
      </div>
      <SearchBox className="w-full xl:w-full 2xl:w-full" />
      {scanning ? <ScanLine /> : null}
    </div>
  )
}

function ExportMenu() {
  const { view, exportReport } = useScan()
  return (
    <DropdownMenu>
      <Tip label="Export report">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="shrink-0" aria-label="Export report" disabled={view !== 'scan'}>
            <Download />
            <span className="hidden lg:inline">Export</span>
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void exportReport('csv')}>CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void exportReport('json')}>JSON</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void exportReport('html')}>HTML report</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ThemeMenu() {
  const { settings, applySettings } = useScan()
  return (
    <DropdownMenu>
      <Tip label="Theme">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="shrink-0" aria-label="Theme">
            <Palette className="animate-icon-pop" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-56 p-0">
        <ScrollArea orientation="vertical" className="max-h-[min(32rem,calc(100vh-6rem))]">
          <div className="p-1">
            <DropdownMenuRadioGroup
              value={settings.theme}
              onValueChange={(value) => void applySettings({ theme: value as ThemeMode })}
            >
              {THEME_OPTIONS.flatMap((option, index) => {
                const prev = THEME_OPTIONS[index - 1]
                const items: ReactElement[] = []
                if (index === 0 || prev?.group !== option.group) {
                  if (index > 0) {
                    items.push(<DropdownMenuSeparator key={`sep-${option.group}`} />)
                  }
                  items.push(
                    <DropdownMenuLabel key={`label-${option.group}`}>
                      {option.group === 'Default' ? 'Appearance' : `${option.group} themes`}
                    </DropdownMenuLabel>
                  )
                }
                items.push(
                  <DropdownMenuRadioItem key={option.id} value={option.id} onSelect={(event) => event.preventDefault()}>
                    <span
                      className="size-3 shrink-0 rounded-full border border-border"
                      style={{ background: option.swatch }}
                      aria-hidden
                    />
                    {option.label}
                  </DropdownMenuRadioItem>
                )
                return items
              })}
            </DropdownMenuRadioGroup>
          </div>
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function SettingsMenu() {
  const { settings, applySettings } = useScan()
  return (
    <DropdownMenu>
      <Tip label="Settings">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="shrink-0" aria-label="Settings">
            <SlidersHorizontal />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Font size</DropdownMenuLabel>
        <div className="flex items-center gap-1">
          <DropdownMenuItem
            className="justify-center"
            aria-label="Decrease font size"
            disabled={settings.fontScale <= FONT_SCALES[0]}
            onSelect={(event) => {
              event.preventDefault()
              void applySettings({ fontScale: stepFontScale(settings.fontScale, -1) })
            }}
          >
            <AArrowDown className="size-4" />
          </DropdownMenuItem>
          <DropdownMenuItem
            className="tabular flex-1 justify-center"
            aria-label="Reset font size"
            disabled={settings.fontScale === DEFAULT_FONT_SCALE}
            onSelect={(event) => {
              event.preventDefault()
              void applySettings({ fontScale: DEFAULT_FONT_SCALE })
            }}
          >
            {settings.fontScale}%
          </DropdownMenuItem>
          <DropdownMenuItem
            className="justify-center"
            aria-label="Increase font size"
            disabled={settings.fontScale >= FONT_SCALES[FONT_SCALES.length - 1]}
            onSelect={(event) => {
              event.preventDefault()
              void applySettings({ fontScale: stepFontScale(settings.fontScale, 1) })
            }}
          >
            <AArrowUp className="size-4" />
          </DropdownMenuItem>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Scan options</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={settings.followLinks}
          onCheckedChange={(v) => void applySettings({ followLinks: Boolean(v) })}
        >
          Follow symbolic links
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={settings.skipHidden}
          onCheckedChange={(v) => void applySettings({ skipHidden: Boolean(v) })}
        >
          Skip hidden (dot) files
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={settings.showFreeSpace}
          onCheckedChange={(v) => void applySettings({ showFreeSpace: Boolean(v) })}
        >
          Show free space in charts
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

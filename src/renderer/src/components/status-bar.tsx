import { formatBytes, formatDuration, formatNumber } from '@shared/format'
import { UnreadableStatus } from '@/components/unreadable'
import { useCompactLayout } from '@/hooks/use-compact'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

export function StatusBar() {
  const { scanning, progress, complete, selectedNode, selectedPath } = useScan()
  const compact = useCompactLayout()
  const stats = complete && !scanning ? complete : progress
  return (
    <footer
      className={cn(
        'relative flex h-7 shrink-0 items-center gap-4 border-t bg-card/80 px-3 text-[11px] text-muted-foreground',
        compact && 'gap-3 overflow-hidden whitespace-nowrap'
      )}
    >
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        {scanning ? <span className="animate-pulse-dot size-1.5 rounded-full bg-primary" /> : null}
        {scanning ? 'Scanning…' : complete?.cancelled ? 'Stopped · partial results' : stats ? 'Ready' : 'Idle'}
      </span>
      {stats ? (
        <>
          <span>{formatNumber(stats.files)} files</span>
          {compact ? null : <span>{formatNumber(stats.folders)} folders</span>}
          <span>{formatBytes(stats.bytes)}</span>
          {stats.unreadable > 0 ? <UnreadableStatus count={stats.unreadable} /> : null}
          {compact ? null : <span>{formatDuration(stats.elapsedMs)}</span>}
        </>
      ) : null}
      {compact ? null : scanning && progress?.currentPath ? (
        <span className="min-w-0 flex-1 truncate">Current: {progress.currentPath}</span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{selectedNode?.name ?? selectedPath ?? ''}</span>
      )}
    </footer>
  )
}

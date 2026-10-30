import { useCallback, useSyncExternalStore } from 'react'
import { isAndroid } from '@/lib/platform'
import { useScan } from '@/scan-context'

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query]
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)
}

/**
 * Whether to show one pane at a time with touch-sized controls: Android below the md breakpoint.
 * Desktop always keeps its full layout, whatever the window size and zoom.
 */
export function useCompactLayout(): boolean {
  const { meta } = useScan()
  const narrow = useMediaQuery('(max-width: 767.98px)')
  return isAndroid(meta?.platform) && narrow
}

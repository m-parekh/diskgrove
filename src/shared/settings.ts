import type { AppSettings, RecentScan, SearchScope } from './types'
import { isThemeMode } from './themes'
import { DEFAULT_FONT_SCALE, isFontScale } from './font-scale'

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  followLinks: false,
  skipHidden: false,
  showFreeSpace: true,
  showPreview: true,
  fontScale: DEFAULT_FONT_SCALE,
  searchScope: 'folder',
  recents: []
}

export const MAX_RECENTS = 12
const MAX_PATH_LENGTH = 32767

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSearchScope(value: unknown): value is SearchScope {
  return value === 'folder' || value === 'all'
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function sanitizeRecents(value: unknown): RecentScan[] {
  if (!Array.isArray(value)) return []
  const out: RecentScan[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) continue
    const p = item.path
    if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LENGTH || p.includes('\0')) continue
    const key = p
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      path: p,
      scannedAt: nonNegative(item.scannedAt),
      size: nonNegative(item.size),
      files: nonNegative(item.files)
    })
    if (out.length >= MAX_RECENTS) break
  }
  return out
}

export function sanitizeSettings(input: unknown, base: AppSettings): AppSettings {
  const src = isRecord(input) ? input : {}
  return {
    theme: isThemeMode(src.theme) ? src.theme : base.theme,
    followLinks: typeof src.followLinks === 'boolean' ? src.followLinks : base.followLinks,
    skipHidden: typeof src.skipHidden === 'boolean' ? src.skipHidden : base.skipHidden,
    showFreeSpace: typeof src.showFreeSpace === 'boolean' ? src.showFreeSpace : base.showFreeSpace,
    showPreview: typeof src.showPreview === 'boolean' ? src.showPreview : base.showPreview,
    fontScale: isFontScale(src.fontScale) ? src.fontScale : base.fontScale,
    searchScope: isSearchScope(src.searchScope) ? src.searchScope : base.searchScope,
    recents: src.recents === undefined ? base.recents : sanitizeRecents(src.recents)
  }
}

/** `recents` with `scan` first, replacing any earlier entry for the same folder. */
export function withRecent(recents: RecentScan[], scan: RecentScan): RecentScan[] {
  return [scan, ...recents.filter((r) => r.path !== scan.path)].slice(0, MAX_RECENTS)
}

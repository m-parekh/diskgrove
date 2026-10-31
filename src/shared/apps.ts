import type { InstalledApp } from './types'

const DAY = 24 * 60 * 60 * 1000
/** How far back Android's usage history is read for `lastUsed`. */
const USAGE_YEARS = 2

/** Everything Android counts against an app: its code, its data and its cache. */
export function appTotal(app: InstalledApp): number {
  if (app.appBytes === undefined) return app.apkBytes
  return app.appBytes + (app.dataBytes ?? 0) + (app.cacheBytes ?? 0)
}

/** When the app was last opened, or installed if it has not been opened since; unknown without usage access. */
export function lastActive(app: InstalledApp): number | undefined {
  return app.lastUsed === undefined ? undefined : Math.max(app.lastUsed, app.installed)
}

/** Whether the app went unopened for `days`, counting from its install; false (unknown) without usage access. */
export function unusedFor(app: InstalledApp, days: number, now = Date.now()): boolean {
  const active = lastActive(app)
  return active !== undefined && now - active >= days * DAY
}

/** When the app was last opened, in words. */
export function lastUsedText(app: InstalledApp, now = Date.now()): string {
  const ts = app.lastUsed
  if (ts === undefined) return 'Unknown'
  if (ts === 0) {
    return now - app.installed < USAGE_YEARS * 365 * DAY
      ? 'Not since it was installed'
      : `Not in the last ${USAGE_YEARS} years`
  }
  const days = Math.floor((now - ts) / DAY)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  if (months < 12) return months === 1 ? 'A month ago' : `${months} months ago`
  const years = Math.floor(days / 365)
  return years <= 1 ? 'A year ago' : `${years} years ago`
}

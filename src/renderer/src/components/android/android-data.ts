import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  Camera,
  Download,
  File,
  FileText,
  Film,
  HardDriveDownload,
  Image,
  Music,
  Package,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import type {
  AndroidAccess,
  AndroidFeatures,
  AppList,
  DeviceStorage,
  InstalledApp,
  MediaKind,
  MediaSummary
} from '@shared/types'

export function androidFeatures(): AndroidFeatures | null {
  return window.diskgrove?.android ?? null
}

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export const KIND_INFO: Record<MediaKind, { label: string; icon: LucideIcon; color: string }> = {
  images: { label: 'Images', icon: Image, color: 'var(--chart-1)' },
  videos: { label: 'Videos', icon: Film, color: 'var(--chart-2)' },
  audio: { label: 'Audio', icon: Music, color: 'var(--chart-3)' },
  documents: { label: 'Documents', icon: FileText, color: 'var(--chart-4)' },
  archives: { label: 'Archives', icon: Archive, color: 'var(--chart-5)' },
  apks: { label: 'APK installers', icon: Package, color: 'var(--chart-6)' },
  other: { label: 'Other files', icon: File, color: 'var(--chart-7)' },
  downloads: { label: 'Downloads', icon: Download, color: 'var(--chart-8)' },
  screenshots: { label: 'Screenshots', icon: Camera, color: 'var(--chart-1)' },
  oldScreenshots: { label: 'Old screenshots', icon: Camera, color: 'var(--chart-1)' },
  large: { label: 'Large files', icon: HardDriveDownload, color: 'var(--chart-4)' },
  trash: { label: 'Trash', icon: Trash2, color: 'var(--destructive)' }
}

export { appTotal, lastActive, lastUsedText, unusedFor } from '@shared/apps'

/** What a file in Android's trash was called before it went there. */
export function displayName(name: string): string {
  return name.replace(/^\.trashed-\d+-/, '')
}

/** What the user granted, read again whenever they come back to the app. */
export function useAndroidAccess(): {
  access: AndroidAccess | null
  setAccess: (access: AndroidAccess) => void
  refresh: () => Promise<void>
} {
  const [access, setAccess] = useState<AndroidAccess | null>(null)
  const refresh = useCallback(async () => {
    const android = androidFeatures()
    if (!android) return
    try {
      setAccess(await android.access())
    } catch {
      // The last answer stands.
    }
  }, [])
  useEffect(() => {
    void refresh()
    return androidFeatures()?.onResume(() => void refresh())
  }, [refresh])
  return { access, setAccess, refresh }
}

interface HomeData {
  storage: DeviceStorage | null
  summary: MediaSummary | null
  apps: AppList | null
}

// Kept between visits to the home screen, so it shows the last figures at once while it refreshes.
const cache: HomeData = { storage: null, summary: null, apps: null }

export interface HomeDataState extends HomeData {
  loadingFiles: boolean
  loadingApps: boolean
  refreshFiles: () => Promise<void>
  refreshApps: () => Promise<void>
  /** Replaces an app's figures, or drops it when it is gone. */
  updateApp: (pkg: string, app: InstalledApp | null) => void
}

export function useHomeData(access: AndroidAccess | null, onError: (message: string) => void): HomeDataState {
  const [storage, setStorage] = useState(cache.storage)
  const [summary, setSummary] = useState(cache.summary)
  const [apps, setApps] = useState(cache.apps)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [loadingApps, setLoadingApps] = useState(false)
  const filesRun = useRef(0)
  const appsRun = useRef(0)
  const reportError = useRef(onError)
  useEffect(() => {
    reportError.current = onError
  }, [onError])

  const refreshFiles = useCallback(async () => {
    const android = androidFeatures()
    if (!android) return
    const run = ++filesRun.current
    setLoadingFiles(true)
    try {
      const [nextStorage, nextSummary] = await Promise.all([android.deviceStorage(), android.mediaSummary()])
      if (run !== filesRun.current) return
      cache.storage = nextStorage
      cache.summary = nextSummary
      setStorage(nextStorage)
      setSummary(nextSummary)
    } catch (err) {
      if (run === filesRun.current) reportError.current(errorText(err, 'Could not read storage'))
    } finally {
      if (run === filesRun.current) setLoadingFiles(false)
    }
  }, [])

  const refreshApps = useCallback(async () => {
    const android = androidFeatures()
    if (!android) return
    const run = ++appsRun.current
    setLoadingApps(true)
    try {
      const next = await android.listApps()
      if (run !== appsRun.current) return
      cache.apps = next
      setApps(next)
    } catch (err) {
      if (run === appsRun.current) reportError.current(errorText(err, 'Could not list apps'))
    } finally {
      if (run === appsRun.current) setLoadingApps(false)
    }
  }, [])

  const updateApp = useCallback((pkg: string, app: InstalledApp | null) => {
    setApps((prev) => {
      if (!prev) return prev
      const list = app ? prev.apps.map((a) => (a.package === pkg ? app : a)) : prev.apps.filter((a) => a.package !== pkg)
      const next = { ...prev, apps: list }
      cache.apps = next
      return next
    })
  }, [])

  // What can be read changes with access, so reload when it does.
  const files = access?.files
  const usage = access?.usage
  useEffect(() => {
    if (files !== undefined) void refreshFiles()
  }, [files, refreshFiles])
  useEffect(() => {
    if (usage !== undefined) void refreshApps()
  }, [usage, refreshApps])
  // Apps, photos and caches change while DiskGrove is in the background.
  const known = files !== undefined
  useEffect(() => {
    if (!known) return
    return androidFeatures()?.onResume(() => {
      void refreshFiles()
      void refreshApps()
    })
  }, [known, refreshFiles, refreshApps])

  return { storage, summary, apps, loadingFiles, loadingApps, refreshFiles, refreshApps, updateApp }
}

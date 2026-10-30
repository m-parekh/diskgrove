import { StrictMode, useCallback, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App as CapacitorApp } from '@capacitor/app'
import { FolderLock } from 'lucide-react'
import App from '@/App'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { ErrorBoundary } from '@/error-boundary'
import { createAndroidApi } from './api'
import { DiskGroveNative } from './native'
import './android.css'

const VIEWPORT = 'width=device-width, initial-scale=1, user-scalable=no'
let fontScale = 1

// Like the desktop app's page zoom, a larger scale lays the page out narrower and magnifies it to fill
// the screen. The width is given outright: WebView lays out 980px wide when a scaled viewport has none.
function updateViewport(): void {
  let content = VIEWPORT
  if (fontScale !== 1) {
    const view = window.visualViewport
    const screenWidth = view ? view.width * view.scale : window.innerWidth
    const s = fontScale
    content = `width=${Math.round(screenWidth / s)}, initial-scale=${s}, minimum-scale=${s}, maximum-scale=${s}, user-scalable=no`
  }
  const meta = document.querySelector('meta[name="viewport"]')
  if (meta && meta.getAttribute('content') !== content) meta.setAttribute('content', content)
}

function applyFontScale(scale: number): void {
  fontScale = scale / 100
  updateViewport()
}

window.addEventListener('resize', updateViewport)

/** Any CSS colour as #rrggbb, or null when the WebView cannot parse it. */
function hexColor(color: string): string | null {
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!context || !color) return null
  context.fillStyle = '#010203'
  context.fillStyle = color
  if (context.fillStyle === '#010203') return null
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

// The status and navigation bars sit over the window background, so it follows the theme.
function syncWindowColors(): void {
  const root = document.documentElement
  const background = hexColor(getComputedStyle(root).getPropertyValue('--card').trim())
  if (!background) return
  DiskGroveNative.setWindowColors({ background, dark: root.classList.contains('dark') }).catch(() => undefined)
}

const api = createAndroidApi({
  native: DiskGroveNative,
  storage: window.localStorage,
  origin: window.location.origin,
  applyFontScale,
  minimize: () => void CapacitorApp.minimizeApp()
})
window.diskgrove = api
void api.getSettings().then((settings) => applyFontScale(settings.fontScale))

new MutationObserver(syncWindowColors).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['class', 'data-theme']
})
syncWindowColors()

// Back closes an open dialog or menu first, as Escape does on desktop.
void CapacitorApp.addListener('backButton', () => {
  const layer = document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]'
  )
  if (layer) {
    layer.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
    )
    return
  }
  api.handleBack()
})

/** Shows the app once it may read shared storage; until then, explains why it needs to. */
function StorageGate({ children }: { children: ReactNode }) {
  const [granted, setGranted] = useState<boolean | null>(null)
  const [asking, setAsking] = useState(false)

  const check = useCallback(async () => {
    try {
      setGranted((await DiskGroveNative.storageAccess()).granted)
    } catch {
      setGranted(false)
    }
  }, [])

  useEffect(() => {
    void check()
    // Access is granted in the system settings, so look again whenever the app comes back.
    const listener = CapacitorApp.addListener('resume', () => void check())
    return () => void listener.then((l) => l.remove())
  }, [check])

  if (granted === null) return null
  if (granted) return children

  return (
    <main className="flex h-full flex-col items-center justify-center gap-5 overflow-auto bg-background p-6 text-center">
      <div className="flex items-center gap-2 text-lg font-semibold">
        <AppLogo className="size-5 text-muted-foreground" /> DiskGrove
      </div>
      <FolderLock className="size-12 text-primary" />
      <div className="max-w-sm space-y-2">
        <h1 className="text-xl font-semibold">Allow access to your files</h1>
        <p className="text-sm text-muted-foreground">
          To measure what takes up space, DiskGrove reads every folder in your device&apos;s shared storage. Android
          lists this as &ldquo;All files access&rdquo;. Your files are only read on this device and never leave it.
        </p>
      </div>
      <Button
        size="lg"
        disabled={asking}
        onClick={async () => {
          setAsking(true)
          try {
            setGranted((await DiskGroveNative.requestStorageAccess()).granted)
          } catch {
            await check()
          } finally {
            setAsking(false)
          }
        }}
      >
        Allow access
      </Button>
    </main>
  )
}

const root = document.getElementById('root')
if (!root) {
  document.body.textContent = 'DiskGrove could not find the root element.'
} else {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <StorageGate>
          <App />
        </StorageGate>
      </ErrorBoundary>
    </StrictMode>
  )
}

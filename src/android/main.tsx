import { StrictMode, useCallback, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App as CapacitorApp } from '@capacitor/app'
import type { AndroidAccess } from '@shared/types'
import App from '@/App'
import { AccessOnboarding } from '@/components/android/access-panel'
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

// Access is granted in the system settings, so screens look again whenever the user comes back.
void CapacitorApp.addListener('resume', () => api.handleResume())

const ONBOARDED_KEY = 'diskgrove:access-onboarded'

/**
 * Asks for access before the app first shows, and again on launch while all files access is off. The
 * user may go on with less: each part of the app says what it is missing.
 */
function AccessGate({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<AndroidAccess | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [onboarded] = useState(() => window.localStorage.getItem(ONBOARDED_KEY) === '1')

  const check = useCallback(async () => {
    try {
      setAccess(await api.android.access())
    } catch {
      setAccess(null)
      setDismissed(true)
    }
  }, [])

  useEffect(() => {
    void check()
    return api.android.onResume(() => void check())
  }, [check])

  // Decided once, at launch: granting access on the screen should not hide it before the user continues.
  const [needed, setNeeded] = useState<boolean | null>(null)
  if (needed === null && (access || dismissed)) setNeeded(!onboarded || !access?.files)

  if (needed === null) return null
  if (!needed || dismissed || !access) return children
  return (
    <AccessOnboarding
      access={access}
      onChange={setAccess}
      onContinue={() => {
        window.localStorage.setItem(ONBOARDED_KEY, '1')
        setDismissed(true)
      }}
    />
  )
}

const root = document.getElementById('root')
if (!root) {
  document.body.textContent = 'DiskGrove could not find the root element.'
} else {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <AccessGate>
          <App />
        </AccessGate>
      </ErrorBoundary>
    </StrictMode>
  )
}

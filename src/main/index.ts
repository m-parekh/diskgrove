import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MAX_PREVIEW_READ, MEDIA_SCHEME } from '@shared/preview'
import { stepFontScale } from '@shared/font-scale'
import { withRecent } from '@shared/settings'
import { trafficLightPosition } from '@shared/title-bar'
import type { NodeSummary } from '@shared/types'
import { listDrives, spaceAt } from './drives'
import { exportReport } from './export'
import { resolveScanRoot, Scanner } from './scanner'
import { confirmFileAction } from './confirm'
import { OperationGate } from './operations'
import { itemTimes, mediaResponse, readChunk } from './preview'
import { loadSettings, saveSettings } from './settings'
import {
  asDeleteMode,
  asFileGroup,
  asFormat,
  asInt,
  asNumber,
  asOptionalPath,
  asPath,
  asPathList,
  asQuery,
  asScanOptions,
  asSort
} from './validate'

const scanner = new Scanner()
const operations = new OperationGate()
let mainWindow: BrowserWindow | null = null
let lastComplete: Awaited<ReturnType<Scanner['finish']>> | null = null

const isDev = !app.isPackaged

// Streams scanned media files to <img>, <video> and <audio> without exposing file:// paths.
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } }
])

const devServerOrigin = ((): string | null => {
  const url = isDev ? process.env.ELECTRON_RENDERER_URL : undefined
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
})()
const rendererIndexPath = join(__dirname, '../renderer/index.html')
const rendererIndexUrl = new URL(pathToFileURL(rendererIndexPath).href)
// Windows and macOS take the window icon from the packaged app; Linux needs it set.
const linuxWindowIcon = isDev
  ? join(__dirname, '../../resources/icons/256x256.png')
  : join(process.resourcesPath, 'icon.png')

function fileUrlKey(url: URL): string {
  let p = url.pathname
  try {
    p = decodeURIComponent(p)
  } catch {
    /* keep the raw path */
  }
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function isAppUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (devServerOrigin) return url.origin === devServerOrigin
  return (
    url.protocol === 'file:' && url.host === rendererIndexUrl.host && fileUrlKey(url) === fileUrlKey(rendererIndexUrl)
  )
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function preloadPath(): string {
  return join(__dirname, '../preload/index.cjs')
}

function fromEvent(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) return false
  if (!mainWindow || event.sender !== mainWindow.webContents) return false
  try {
    return isAppUrl(frame.url)
  } catch {
    return false
  }
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(event)) throw new Error(`Rejected IPC call on ${channel} from an untrusted sender`)
    return fn(event, ...args)
  })
}

function scannedNode(target: unknown): NodeSummary {
  const node = scanner.getNode(asPath(target))
  if (!node) throw new Error('That item is not part of the current scan')
  return node
}

function scannedFile(target: unknown): NodeSummary {
  const node = scannedNode(target)
  if (node.kind !== 'file') throw new Error('Only files can be previewed')
  return node
}

async function serveMedia(request: Request): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405 })
  try {
    const node = scannedFile(new URL(request.url).searchParams.get('path'))
    await scanner.assertCurrent(node.path, 'read')
    return await mediaResponse(node.path, node.name, request.headers.get('Range'))
  } catch {
    return new Response(null, { status: 404 })
  }
}

function applyFontScale(contents: Electron.WebContents, scale: number): void {
  contents.setZoomFactor(scale / 100)
  if (process.platform === 'darwin') {
    BrowserWindow.fromWebContents(contents)?.setWindowButtonPosition(trafficLightPosition(scale))
  }
}

// Ctrl/Cmd with Plus, Minus or 0 steps the saved font size; the default menu's zoom would not be persisted.
function fontScaleKey(input: Electron.Input): -1 | 0 | 1 | null {
  const modifier = process.platform === 'darwin' ? input.meta : input.control
  if (input.type !== 'keyDown' || !modifier || input.alt) return null
  if (input.key === '=' || input.key === '+') return 1
  if (input.key === '-' || input.key === '_') return -1
  if (input.key === '0') return 0
  return null
}

async function stepFontSize(direction: -1 | 0 | 1): Promise<void> {
  const current = await loadSettings()
  const fontScale = stepFontScale(current.fontScale, direction)
  if (fontScale === current.fontScale) return
  const next = await saveSettings({ fontScale })
  if (mainWindow && !mainWindow.isDestroyed()) applyFontScale(mainWindow.webContents, next.fontScale)
  send('settings:changed', next)
}

async function createWindow(): Promise<void> {
  const { fontScale } = await loadSettings()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: true,
    // macOS keeps its native traffic lights, drawn over the renderer's title bar.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: trafficLightPosition(fontScale) }
      : { frame: false }),
    autoHideMenuBar: true,
    backgroundColor: '#0c1017',
    title: 'DiskGrove',
    ...(process.platform === 'linux' ? { icon: linuxWindowIcon } : {}),
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      zoomFactor: fontScale / 100,
      devTools: isDev
    }
  })

  const emitMaximized = () => send('window:maximized', mainWindow?.isMaximized() ?? false)
  mainWindow.on('maximize', emitMaximized)
  mainWindow.on('unmaximize', emitMaximized)
  mainWindow.on('enter-full-screen', () => send('window:fullscreen', true))
  mainWindow.on('leave-full-screen', () => send('window:fullscreen', false))
  mainWindow.on('closed', () => {
    mainWindow = null
    scanner.cancel()
  })

  mainWindow.webContents.on('preload-error', (_event, preload, error) => {
    console.error('Preload failed:', preload, error)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    void loadSettings().then((settings) => {
      if (mainWindow && !mainWindow.isDestroyed()) applyFontScale(mainWindow.webContents, settings.fontScale)
    })
  })
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const direction = fontScaleKey(input)
    if (direction === null) return
    event.preventDefault()
    stepFontSize(direction).catch((err) => console.error('Could not change the font size:', err))
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error('Renderer failed to load:', code, desc, url)
  })

  if (devServerOrigin && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(rendererIndexPath)
  }
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

function hardenSession(ses: Electron.Session): void {
  // "Copy path" needs clipboard writes.
  const allowedPermissions = new Set<string>(['clipboard-sanitized-write'])
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowedPermissions.has(permission))
  })
  ses.setPermissionCheckHandler((_contents, permission) => allowedPermissions.has(permission))

  if (!devServerOrigin) {
    ses.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, callback) => callback({ cancel: true })
    )
  }
}

scanner.onProgress = (p) => send('scan:progress', p)
scanner.onComplete = (r) => send('scan:complete', r)
scanner.onDupProgress = (p) => send('dup:progress', p)

function registerIpc(): void {
  handle('app:meta', () => ({ platform: process.platform, home: app.getPath('home') }))
  handle('drives:list', () => listDrives())
  handle('settings:get', () => loadSettings())
  handle('settings:set', async (event, partial) => {
    const next = await saveSettings(partial)
    applyFontScale(event.sender, next.fontScale)
    return next
  })

  handle('folder:pick', async (event) => {
    const owner = fromEvent(event)
    if (!owner) return null
    const result = await dialog.showOpenDialog(owner, {
      title: 'Select a folder to scan',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  handle('scan:resolve', (_e, target) => resolveScanRoot(asPath(target)))
  handle('scan:start', (_e, target, options) =>
    operations.run('the scan', async () => {
      const root = asPath(target)
      const opts = asScanOptions(options)
      lastComplete = null
      await scanner.start(root, opts)
      const space = await spaceAt(root)
      lastComplete = scanner.finish(space)
      // A stopped scan's totals are partial; keep them out of the recent list.
      if (lastComplete.cancelled) return
      const settings = await loadSettings()
      const recents = withRecent(settings.recents, {
        path: lastComplete.rootPath,
        scannedAt: Date.now(),
        size: lastComplete.bytes,
        files: lastComplete.files
      })
      await saveSettings({ recents })
    })
  )

  handle('scan:cancel', () => {
    scanner.cancel()
  })

  handle('scan:children', (_e, target, sort) => scanner.getChildren(asPath(target), asSort(sort)))
  handle('scan:node', (_e, target) => scanner.getNode(asPath(target)))
  handle('scan:topfiles', (_e, target, limit) =>
    scanner.getTopFiles(asOptionalPath(target), asInt(limit, 1, 5000, 200))
  )
  handle('scan:extensions', (_e, target) => scanner.getExtensions(asOptionalPath(target)))
  handle('scan:age', (_e, target) => scanner.getAgeStats(asOptionalPath(target)))
  handle('scan:group-files', (_e, group, target, limit) =>
    scanner.getGroupFiles(asFileGroup(group), asOptionalPath(target), asInt(limit, 1, 5000, 2000))
  )
  handle('scan:treemap', (_e, target, maxDepth, minPercent) =>
    scanner.getTreemap(asPath(target), asInt(maxDepth, 1, 12, 3), asNumber(minPercent, 0, 100, 0))
  )
  handle('scan:search', (_e, query, target, limit) =>
    scanner.search(asQuery(query), asOptionalPath(target), asInt(limit, 1, 2000, 400))
  )
  handle('scan:unreadable', (_e, limit) => scanner.getUnreadable(asInt(limit, 1, 5000, 1000)))
  handle('scan:duplicates', (_e, target) =>
    operations.run('duplicate detection', () => scanner.findDuplicates(asOptionalPath(target)))
  )
  handle('dup:cancel', () => {
    scanner.cancelDuplicates()
  })

  handle('item:open', (event, target) =>
    operations.run('opening the item', async () => {
      const node = scannedNode(target)
      const owner = fromEvent(event)
      if (!owner || !(await confirmFileAction(owner, [node.path], 'open'))) return
      await scanner.assertCurrent(node.path, 'act')
      const err = await shell.openPath(node.path)
      if (err) throw new Error(err)
    })
  )
  handle('item:reveal', (_e, target) =>
    operations.run('revealing the item', async () => {
      const itemPath = asPath(target)
      const folder = scanner.getNode(itemPath) ? null : scanner.unreadableParent(itemPath)
      // An entry the scan could not read is checked through the folder that lists it.
      await scanner.assertCurrent(folder ?? scannedNode(itemPath).path, 'read')
      shell.showItemInFolder(itemPath)
    })
  )
  handle('item:read', async (_e, target, offset, length) => {
    const node = scannedFile(target)
    await scanner.assertCurrent(node.path, 'read')
    return readChunk(node.path, asInt(offset, 0, Number.MAX_SAFE_INTEGER, 0), asInt(length, 0, MAX_PREVIEW_READ, 0))
  })
  handle('item:times', async (_e, target) => {
    const node = scannedNode(target)
    await scanner.assertCurrent(node.path, 'read')
    return itemTimes(node.path)
  })
  handle('items:delete', (event, targets, mode) =>
    operations.run('deletion', async () => {
      const paths = [...new Set(asPathList(targets))].map((p) => scannedNode(p).path)
      const deleteMode = asDeleteMode(mode)
      if (paths.includes(scanner.getRootPath())) throw new Error('Cannot delete the scan root')
      const owner = fromEvent(event)
      if (!owner || !(await confirmFileAction(owner, paths, deleteMode))) {
        return { mode: deleteMode, deleted: [], failed: [] }
      }
      const result = await scanner.deleteMany(paths, deleteMode)
      if (lastComplete)
        lastComplete = scanner.finish({
          total: lastComplete.totalSpace,
          free: lastComplete.freeSpace,
          volumeRoot: lastComplete.isVolumeRoot
        })
      return result
    })
  )

  handle('export:report', (event, format) =>
    operations.run('the export', async () => {
      const fmt = asFormat(format)
      const root = scanner.getRootPath()
      if (!root) return null
      const [extensions, topFiles, age] = await Promise.all([
        scanner.getExtensions(root),
        scanner.getTopFiles(root, 50),
        scanner.getAgeStats(root)
      ])
      return exportReport(fromEvent(event), scanner, lastComplete, extensions, topFiles, age, fmt)
    })
  )

  handle('window:minimize', (event) => {
    fromEvent(event)?.minimize()
  })
  handle('window:toggleMaximize', (event) => {
    const w = fromEvent(event)
    if (!w) return false
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
    return w.isMaximized()
  })
  handle('window:close', (event) => {
    fromEvent(event)?.close()
  })
  handle('window:isMaximized', (event) => fromEvent(event)?.isMaximized() ?? false)
  handle('window:isFullScreen', (event) => fromEvent(event)?.isFullScreen() ?? false)
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('io.github.tanmay-73.diskgrove')
  }
  hardenSession(session.defaultSession)
  protocol.handle(MEDIA_SCHEME, serveMedia)
  registerIpc()
  void createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

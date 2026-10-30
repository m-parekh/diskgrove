import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppSettings } from '@shared/types'
import { DEFAULT_SETTINGS, sanitizeSettings } from '@shared/settings'

export { sanitizeSettings }

function filePath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

let cache: AppSettings | null = null

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache
  let next: AppSettings
  try {
    const raw = await fs.readFile(filePath(), 'utf8')
    next = sanitizeSettings(JSON.parse(raw), DEFAULT_SETTINGS)
  } catch {
    next = { ...DEFAULT_SETTINGS }
  }
  cache = next
  return next
}

let pendingSave: Promise<unknown> = Promise.resolve()

export function saveSettings(partial: unknown): Promise<AppSettings> {
  const save = pendingSave.then(() => writeSettings(partial))
  pendingSave = save.catch(() => undefined)
  return save
}

async function writeSettings(partial: unknown): Promise<AppSettings> {
  const current = await loadSettings()
  const next = sanitizeSettings(partial, current)

  // Rename only after the complete settings file has been written.
  const target = filePath()
  const tmp = `${target}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(tmp, target)
    cache = next
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
  return next
}

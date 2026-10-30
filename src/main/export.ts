import { dialog, type BrowserWindow } from 'electron'
import { createWriteStream, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AgeBucket, ExtensionStat, NodeSummary, ScanComplete } from '@shared/types'
import { reportParts } from './report'
import type { Scanner } from './scanner'
import type { ReportFormat } from './validate'

export { csvCell, escapeHtml } from './report'

export async function exportReport(
  parent: BrowserWindow | null,
  scanner: Scanner,
  complete: ScanComplete | null,
  extensions: ExtensionStat[],
  topFiles: NodeSummary[],
  age: AgeBucket[],
  format: ReportFormat
): Promise<string | null> {
  const options: Electron.SaveDialogOptions = {
    title: 'Export scan report',
    defaultPath: `diskgrove-report.${format}`,
    filters:
      format === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : format === 'json'
          ? [{ name: 'JSON', extensions: ['json'] }]
          : [{ name: 'HTML', extensions: ['html'] }]
  }
  const { filePath, canceled } = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  if (canceled || !filePath) return null

  await writeReport(filePath, reportParts(scanner, complete, extensions, topFiles, age, format))
  return filePath
}

async function writeReport(target: string, parts: Iterable<string>): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  function* chunks() {
    let buffer = ''
    for (const part of parts) {
      buffer += part
      if (buffer.length >= 64 * 1024) {
        yield buffer
        buffer = ''
      }
    }
    if (buffer) yield buffer
  }
  try {
    await pipeline(
      Readable.from(chunks(), { objectMode: false }),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
    )
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

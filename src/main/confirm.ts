import { dialog, type BrowserWindow } from 'electron'
import { describeFileAction, type FileAction } from './confirm-text'

export async function confirmFileAction(owner: BrowserWindow, paths: string[], action: FileAction): Promise<boolean> {
  const { label, message, detail } = describeFileAction(paths, action)
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    title: label,
    message,
    detail,
    buttons: ['Cancel', label],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return result.response === 1
}

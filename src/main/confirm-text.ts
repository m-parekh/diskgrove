import type { DeleteMode } from '@shared/types'

export type FileAction = DeleteMode | 'open'

/** The wording of the system dialog that confirms `action` on `paths`. */
export function describeFileAction(
  paths: string[],
  action: FileAction
): { label: string; message: string; detail: string } {
  const label = action === 'open' ? 'Open' : action === 'trash' ? 'Move to Trash / Recycle Bin' : 'Delete permanently'
  const listed =
    paths
      .slice(0, 8)
      .map((p) => JSON.stringify(p))
      .join('\n') + (paths.length > 8 ? `\n…and ${paths.length - 8} more items` : '')
  const warning =
    action === 'open'
      ? 'The system will open this item with its default handler. Executable files can run programs.'
      : action === 'permanent'
        ? 'This cannot be undone. Selected folders include all their current contents.'
        : 'Selected folders include all their current contents.'
  return {
    label,
    message: `${label}: ${paths.length} item${paths.length === 1 ? '' : 's'}?`,
    detail: `${warning}\n\n${listed}`
  }
}

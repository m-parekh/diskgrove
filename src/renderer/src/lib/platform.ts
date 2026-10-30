/** Platform wording and capabilities, from the platform the app reports in its meta. */

export function isAndroid(platform: string | undefined): boolean {
  return platform === 'android'
}

/** The label for showing an item in the system file manager, or null where the app cannot do that. */
export function revealLabel(platform: string | undefined): string | null {
  if (platform === 'darwin') return 'Reveal in Finder'
  if (platform === 'win32') return 'Show in Explorer'
  if (isAndroid(platform)) return null
  return 'Show in folder'
}

/** Whether folders can be handed to the system to open; Android apps can only open files in other apps. */
export function canOpenFolders(platform: string | undefined): boolean {
  return !isAndroid(platform)
}

/** What the system calls its bin for deleted files, or null where deletions are permanent. */
export function trashName(platform: string | undefined): string | null {
  if (platform === 'win32') return 'Recycle Bin'
  if (isAndroid(platform)) return null
  return 'Trash'
}

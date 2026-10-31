const android = window.diskgrove.android
const { root, pkg, photoBytes } = fixture
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const rejects = async (action, message) => {
  try {
    await action()
  } catch (error) {
    assert(String(error).includes(message), `Expected ${message}, received ${error}`)
    return
  }
  throw new Error(`Expected rejection: ${message}`)
}
const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Image failed to load: ${src}`))
    image.src = src
  })
const waitUntil = async (check, message) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(message)
}

const access = await android.access()
assert(
  access.files && access.usage && access.packages && access.uninstall && access.appSizes && access.allFilesSetting,
  `Missing access: ${JSON.stringify(access)}`
)

const storage = await android.deviceStorage()
assert(storage.total > 0 && storage.free > 0 && storage.free <= storage.total, `Bad storage: ${JSON.stringify(storage)}`)

const { apps, usageAccess } = await android.listApps()
assert(usageAccess, 'Usage access was not used to list apps')
const self = apps.find((app) => app.package === pkg)
assert(
  self && self.self && self.label === 'DiskGrove' && self.apkBytes > 0 && self.appBytes > 0 && self.dataBytes > 0,
  `DiskGrove's own entry is wrong: ${JSON.stringify(self)}`
)
assert(apps.some((app) => app.system) && apps.some((app) => !app.system), 'Apps should include system and user apps')
const sized = apps.filter((app) => app.appBytes > 0 && !app.self)
assert(sized.length > 5, 'Usage access did not reveal other apps’ sizes')
assert(
  apps.some((app) => typeof app.lastUsed === 'number' && app.lastUsed > 0),
  'Usage access did not report when apps were last used'
)
const info = await android.appInfo(pkg)
assert(info?.package === pkg && info.apkBytes === self.apkBytes, 'appInfo disagrees with listApps')
await rejects(() => android.appInfo('not a package'), 'package name')
await rejects(() => android.appInfo('com.example.never.listed'), 'app list')

const icon = await loadImage(android.iconUrl(pkg))
assert(icon.naturalWidth > 0 && icon.naturalHeight > 0, 'App icon did not decode')

// Android indexes files written to shared storage in the background.
const photo = await waitUntil(async () => {
  const list = await android.mediaFiles('images', 2000)
  return list.files.find((file) => file.path === root + '/photo.png')
}, 'MediaStore did not index the fixture photo')
assert(
  photo.type === 'images' && photo.mime === 'image/png' && photo.size === photoBytes && photo.modified > 0,
  `Wrong photo entry: ${JSON.stringify(photo)}`
)
const downloads = await waitUntil(async () => {
  const list = await android.mediaFiles('downloads', 2000)
  return list.files.some((file) => file.path === root + '/notes.txt') ? list : null
}, 'MediaStore did not index the fixture notes')
const notes = downloads.files.find((file) => file.path === root + '/notes.txt')
assert(notes.type === 'documents' && notes.size === 11, `Wrong notes entry: ${JSON.stringify(notes)}`)
assert(
  !downloads.files.some((file) => file.path === root || file.path === root + '/nested'),
  'Folders must not be listed as files'
)
assert(downloads.count >= downloads.files.length && downloads.bytes > 0, 'Download totals are wrong')

const summary = await android.mediaSummary()
for (const [kind, total] of Object.entries(summary)) {
  assert(total.count >= 0 && total.bytes >= 0, `Bad ${kind} total`)
}
assert(summary.images.count >= 1 && summary.documents.count >= 1 && summary.downloads.count >= 2, 'Summary is empty')

const thumbnail = await loadImage(android.thumbnailUrl(photo))
// A downsampled preview, smaller than the 640 × 480 photo.
assert(
  thumbnail.naturalWidth > 0 && thumbnail.naturalWidth < 640 && thumbnail.naturalHeight < 480,
  `Photo thumbnail is ${thumbnail.naturalWidth} × ${thumbnail.naturalHeight}`
)
assert(android.thumbnailUrl(notes) === null, 'Documents have no thumbnail')
await rejects(() => android.openMediaFile(root + '/missing.txt'), 'file list')

return { apps: apps.length, sized: sized.length, images: summary.images.count, downloads: downloads.count }

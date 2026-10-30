const api = window.diskgrove
const native = window.Capacitor.Plugins.DiskGroveNative
const { root, files, bytes } = fixture
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

assert((await api.getMeta()).platform === 'android', 'Android API was not installed')
assert((await native.storageAccess()).granted, 'Storage access is missing')
const drives = await api.listDrives()
assert(
  drives.some((d) => root.startsWith(d.path + '/') && d.total > 0 && d.free > 0),
  'Shared storage volume is missing'
)
const listing = await native.listDir({ path: root, followLinks: false })
assert(listing.entries.length === 9, 'Native directory listing is incomplete')
const missing = await native.statMany({ paths: [root + '/missing'], follow: false })
assert(missing.results[0].error === 'ENOENT', 'Missing paths must report ENOENT')
await rejects(() => native.listDir({ path: 'relative', followLinks: false }), 'absolute')

let completed
const unsubscribe = api.onComplete((result) => {
  completed = result
})
await api.startScan(root, { followLinks: false, skipHidden: false })
unsubscribe()
assert(
  completed.files === files && completed.bytes === bytes && completed.unreadable === 0,
  `Wrong scan totals: ${JSON.stringify(completed)}`
)
const children = await api.getChildren(root, { key: 'name', dir: 'asc' })
assert(children.dirs.length === 2 && children.files.length === 7, 'Wrong child nodes')
assert((await api.search('copy', root, 100)).total === 2, 'Search did not traverse nested files')
assert((await api.getExtensions(root)).reduce((sum, ext) => sum + ext.size, 0) === bytes, 'Wrong extension totals')
assert((await api.getTreemap(root, 3, 0)).value === bytes, 'Wrong treemap total')
const groups = await api.findDuplicates(root)
assert(groups.length === 2 && groups.every((group) => group.count === 2), 'Duplicate groups are incorrect')
const sampleOptions = { size: 4 * 1024 * 1024, mode: 'sample', head: 1024 * 1024, tail: 64 * 1024 }
const originalSample = await native.hashFile({ ...sampleOptions, path: root + '/large.bin' })
const collisionSample = await native.hashFile({ ...sampleOptions, path: root + '/sample-collision.bin' })
assert(originalSample.hash === collisionSample.hash, 'Fixture must collide at the sampling stage')
assert(
  !groups.some((group) => group.files.some((file) => file.name === 'sample-collision.bin')),
  'Full native hash did not exclude the file with matching head and tail'
)
const textGroup = groups.find((group) => group.files.some((file) => file.name === 'notes.txt'))
// Both scanners append the decimal file size before finalizing SHA-256.
assert(
  textGroup?.hash === '8f16ca3820ad6f3d5e5ba44bcf5f794b2283f98761213ef675d443320ecb72f7',
  'Native SHA-256 differs from the known digest of hello world11'
)
const chunk = await api.readFile(root + '/notes.txt', 6, 100)
assert(
  new TextDecoder().decode(chunk.bytes) === 'world' && chunk.offset === 6 && chunk.size === 11,
  'Native byte-range preview returned the wrong content'
)
const eof = await api.readFile(root + '/notes.txt', 100, 8)
assert(eof.bytes.length === 0 && eof.offset === 11, 'Read past EOF is incorrect')
await rejects(() => api.readFile(root + '/missing', 0, 10), 'not part of the current scan')
await rejects(() => api.deleteItems([root], 'permanent'), 'scan root')
await rejects(() => api.deleteItems([root + '/notes.txt'], 'trash'), 'no Trash')

// The app forbids fetch with connect-src 'none'; use the same image path as the preview pane.
const image = new Image()
await new Promise((resolve, reject) => {
  image.onload = resolve
  image.onerror = () => reject(new Error('Native media preview failed to load'))
  image.src = api.mediaUrl(root + '/pixel.png', 1)
})
assert(image.naturalWidth === 1 && image.naturalHeight === 1, 'Image preview decoded the wrong dimensions')

await api.startScan(root, { followLinks: false, skipHidden: true })
assert((await api.getNode(root + '/.hidden')) === null, 'Hidden files were not excluded')
assert((await api.getNode(root)).fileCount === files - 1, 'Hidden-file scan totals are incorrect')
await api.startScan(root + '/nested', { followLinks: false, skipHidden: false })
assert((await api.getNode(root + '/notes.txt')) === null, 'Rescan retained stale nodes')
assert((await api.getNode(root + '/nested')).fileCount === 2, 'Rescan did not replace the scan root')
return { files: completed.files, bytes: completed.bytes, duplicateGroups: groups.length }

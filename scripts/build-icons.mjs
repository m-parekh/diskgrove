// Rasterizes the artwork in resources/ into the icons electron-builder packages, and the
// Android app's launcher icons. Runs inside Electron to borrow its SVG renderer: `npm run icons`.
import { app, BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const resources = join(import.meta.dirname, '../resources')
const androidRes = join(import.meta.dirname, '../android/app/src/main/res')

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
// At or below this size the simplified artwork is used.
const SMALL_MAX = 48

// macOS draws no mask of its own: the tile sits on Apple's 824px grid inside a
// 1024px canvas and carries its own shadow.
const MAC_SIZE = 1024
const MAC_INSET = 100
// Windows and Linux icons fill the canvas, short of touching its edges.
const TILE_INSET = 20

// Android launcher icons are 48dp, and adaptive icon layers 108dp, at each screen density.
const ANDROID_DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
// Pre-Android 8 launchers show the icon as is, so it keeps a little margin.
const LEGACY_INSET = 40
// Adaptive icons are masked by the launcher; the grove fits inside the 66dp circle every mask keeps.
const ADAPTIVE_INSET = 147

function rootAttributes(svg, attributes) {
  return svg.replace('<svg ', `<svg ${attributes} `)
}

function inset(svg, margin, wrap = (tile) => tile) {
  const side = 1024 - margin * 2
  const tile = rootAttributes(svg, `x="${margin}" y="${margin}" width="${side}" height="${side}"`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${wrap(tile)}</svg>`
}

const SHADOW =
  '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">' +
  '<feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity="0.3"/></filter>'

function withShadow(svg) {
  return inset(svg, MAC_INSET, (tile) => `<defs>${SHADOW}</defs><g filter="url(#shadow)">${tile}</g>`)
}

// The grove alone: Android draws the tile itself, from the adaptive icon's background layer.
function withoutTile(svg) {
  return svg.replace(/\s*<rect width="1024"[^>]*\/>/, '').replace(/\s*<rect x="9" y="9"[^>]*\/>/, '')
}

function round(svg) {
  const tile = rootAttributes(svg, 'width="1024" height="1024"')
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">' +
    '<defs><clipPath id="round"><circle cx="512" cy="512" r="512"/></clipPath></defs>' +
    `<g clip-path="url(#round)">${tile}</g></svg>`
  )
}

async function rasterize(window, svg, size) {
  const source = rootAttributes(svg, `width="${size}" height="${size}"`)
  const result = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image()
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(source)})
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = ${size}
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0, ${size}, ${size})
    return {
      png: canvas.toDataURL('image/png').split(',')[1],
      rgba: Array.from(context.getImageData(0, 0, ${size}, ${size}).data)
    }
  })()`)
  return { size, png: Buffer.from(result.png, 'base64'), rgba: Uint8Array.from(result.rgba) }
}

// 32-bit BMP entry: bottom-up BGRA rows followed by a 1-bit transparency mask.
function icoBitmap({ size, rgba }) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(size * size * 4, 20)

  const pixels = Buffer.alloc(size * size * 4)
  const maskStride = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskStride * size)
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = (row * size + x) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
      if (rgba[from + 3] === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return Buffer.concat([header, pixels, mask])
}

// Windows only reads PNG entries reliably at 256px, so smaller ones are bitmaps.
function ico(images) {
  const entries = images.map((image) => (image.size >= 256 ? image.png : icoBitmap(image)))
  const directory = Buffer.alloc(6 + 16 * images.length)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(images.length, 4)
  let offset = directory.length
  images.forEach(({ size }, index) => {
    const at = 6 + 16 * index
    directory.writeUInt8(size >= 256 ? 0 : size, at)
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1)
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(entries[index].length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entries[index].length
  })
  return Buffer.concat([directory, ...entries])
}

async function build() {
  const full = await readFile(join(resources, 'icon.svg'), 'utf8')
  const small = await readFile(join(resources, 'icon-small.svg'), 'utf8')
  const tile = inset(full, TILE_INSET)
  const artwork = (size) => (size <= SMALL_MAX ? small : tile)

  const window = new BrowserWindow({ show: false })
  await window.loadURL('about:blank')

  const mac = await rasterize(window, withShadow(full), MAC_SIZE)
  await writeFile(join(resources, 'icon.png'), mac.png)

  const windows = []
  for (const size of ICO_SIZES) windows.push(await rasterize(window, artwork(size), size))
  await writeFile(join(resources, 'icon.ico'), ico(windows))

  await mkdir(join(resources, 'icons'), { recursive: true })
  for (const size of LINUX_SIZES) {
    const { png } = await rasterize(window, artwork(size), size)
    await writeFile(join(resources, 'icons', `${size}x${size}.png`), png)
  }

  const legacy = inset(full, LEGACY_INSET)
  const foreground = inset(withoutTile(full), ADAPTIVE_INSET)
  if (!foreground.includes('url(#blue)') || foreground.includes('url(#tile)')) throw new Error('icon.svg changed shape')
  for (const [density, scale] of Object.entries(ANDROID_DENSITIES)) {
    const folder = join(androidRes, `mipmap-${density}`)
    await mkdir(folder, { recursive: true })
    const icons = {
      'ic_launcher.png': [legacy, 48],
      'ic_launcher_round.png': [round(full), 48],
      'ic_launcher_foreground.png': [foreground, 108]
    }
    for (const [name, [svg, dp]] of Object.entries(icons)) {
      const { png } = await rasterize(window, svg, Math.round(dp * scale))
      await writeFile(join(folder, name), png)
    }
  }
}

app
  .whenReady()
  .then(build)
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error)
      app.exit(1)
    }
  )

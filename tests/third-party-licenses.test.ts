import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { packageRoot, renderJavaLibraries, renderLicenses, type JavaLibrary } from '../scripts/third-party-licenses'

let fixture: string
beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-licenses-test-'))
})
afterEach(async () => {
  if (
    path.dirname(fixture) !== (await fs.realpath(os.tmpdir())) ||
    !path.basename(fixture).startsWith('diskgrove-licenses-test-')
  ) {
    throw new Error('Unexpected fixture path')
  }
  await fs.rm(fixture, { recursive: true, force: true })
})

async function addPackage(name: string, pkg: object, files: Record<string, string> = {}): Promise<string> {
  const root = path.join(fixture, 'node_modules', name)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }))
  for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(root, file), text)
  return root
}

it('maps bundled module ids to their package directory', () => {
  expect(packageRoot('/app/node_modules/react/cjs/react.production.js')).toBe('/app/node_modules/react')
  expect(packageRoot('/app/node_modules/@radix-ui/react-slot/dist/index.mjs')).toBe(
    '/app/node_modules/@radix-ui/react-slot'
  )
  expect(packageRoot('/app/node_modules/a/node_modules/b/index.js')).toBe('/app/node_modules/a/node_modules/b')
  expect(packageRoot('C:\\app\\node_modules\\pdfjs-dist\\build\\pdf.worker.min.mjs?url')).toBe(
    'C:/app/node_modules/pdfjs-dist'
  )
  expect(packageRoot('/app/src/renderer/src/App.tsx')).toBeNull()
  expect(packageRoot('\0vite/preload-helper.js')).toBeNull()
})

it('reproduces license and notice files, sorted by package name', async () => {
  const zeta = await addPackage(
    'zeta',
    { license: 'Apache-2.0', repository: { url: 'git+https://example.com/zeta.git' } },
    { LICENSE: 'Apache text', NOTICE: 'Zeta notice', 'README.md': 'not a license' }
  )
  const alpha = await addPackage('@scope/alpha', { license: 'ISC' }, { 'LICENSE.md': 'ISC text' })
  const text = renderLicenses([zeta, alpha, zeta])
  expect(text.indexOf('@scope/alpha 1.0.0')).toBeLessThan(text.indexOf('zeta 1.0.0'))
  expect(text.match(/zeta 1\.0\.0/g)).toHaveLength(1)
  expect(text).toContain('Source: https://example.com/zeta\n')
  expect(text).toContain('Apache text\n\nZeta notice')
  expect(text).toContain('ISC text')
  expect(text).not.toContain('not a license')
})

it('writes MIT text from package.json when a package ships no license file', async () => {
  const root = await addPackage('panels', { license: 'MIT', author: 'Jane Doe <jane@example.com>' })
  expect(renderLicenses([root])).toContain('MIT License\n\nCopyright (c) Jane Doe\n\nPermission is hereby granted')
})

it('fails when a non-MIT package ships no license file', async () => {
  const root = await addPackage('bare', { license: 'BSD-3-Clause', author: 'Someone' })
  expect(() => renderLicenses([root])).toThrow('bare@1.0.0 has no license file')
})

it('keeps the desktop intro by default and puts other sections after the npm packages', async () => {
  const root = await addPackage('react', { license: 'MIT' }, { LICENSE: 'React text' })
  expect(renderLicenses([root])).toMatch(
    /^DiskGrove includes .*\n.*LICENSES\.chromium\.html in the application folder\.\n\n=/
  )
  const text = renderLicenses([root], { intro: 'Android intro.', appendix: 'Java section\n' })
  expect(text.startsWith('Android intro.\n\n=')).toBe(true)
  expect(text).not.toContain('Chromium')
  expect(text.indexOf('React text')).toBeLessThan(text.indexOf('Java section'))
})

it('lists Java libraries once per license, with that license text', async () => {
  await fs.writeFile(path.join(fixture, 'Apache-2.0.txt'), 'Apache text\n')
  await fs.writeFile(path.join(fixture, 'MIT.txt'), 'MIT text\n')
  const text = renderJavaLibraries(
    [
      { name: 'Kotlin', groups: ['org.jetbrains.kotlin'], license: 'Apache-2.0', source: 'https://kotlin.example' },
      { name: 'Mini', groups: ['org.mini'], license: 'MIT', source: 'https://mini.example' },
      { name: 'AndroidX', groups: ['androidx.*'], license: 'Apache-2.0', source: 'https://androidx.example' }
    ],
    fixture
  )
  expect(text.match(/Apache text/g)).toHaveLength(1)
  expect(text).toContain('AndroidX\nLicense: Apache-2.0\nSource: https://androidx.example\n\nKotlin\n')
  expect(text.indexOf('Apache text')).toBeLessThan(text.indexOf('Mini\nLicense: MIT'))
  expect(text).toContain('MIT text')
})

it('fails when a Java library license has no text', () => {
  const libraries = [{ name: 'Odd', groups: ['org.odd'], license: 'EPL-2.0', source: 'https://odd.example' }]
  expect(() => renderJavaLibraries(libraries, fixture)).toThrow('Odd use EPL-2.0; add its text as')
})

it('has the text of every license that the Android app libraries use', async () => {
  const libraries = JSON.parse(await fs.readFile('android/third-party-libraries.json', 'utf8')) as JavaLibrary[]
  expect(libraries.length).toBeGreaterThan(0)
  expect(renderJavaLibraries(libraries, 'scripts/licenses')).toContain('Apache License\n')
})

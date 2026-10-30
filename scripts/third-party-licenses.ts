// Builds THIRD_PARTY_LICENSES.txt from the npm packages that end up in the renderer bundle,
// so packaged builds carry the license and notice text that those packages require. The
// Android build adds the Java libraries that Gradle compiles into the app.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

export const LICENSES_FILE = 'THIRD_PARTY_LICENSES.txt'

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i
const RULE = '='.repeat(80)

// Some packages publish no license file. MIT is reproduced from package.json; anything
// else fails the build so that someone looks for the text instead of shipping without it.
const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

interface PackageJson {
  name: string
  version: string
  license?: string
  author?: string | { name?: string }
  repository?: string | { url?: string }
}

// The package directory that a bundled module id belongs to, or null for first-party
// and virtual modules. Nested node_modules resolve to the innermost package.
export function packageRoot(id: string): string | null {
  if (id.startsWith('\0')) return null
  const file = id.replace(/[?#].*$/, '').replaceAll('\\', '/')
  const marker = file.lastIndexOf('/node_modules/')
  if (marker < 0) return null
  const start = marker + '/node_modules/'.length
  const parts = file.slice(start).split('/')
  const depth = parts[0].startsWith('@') ? 2 : 1
  if (parts.length <= depth) return null
  return file.slice(0, start) + parts.slice(0, depth).join('/')
}

function authorName(author: PackageJson['author']): string | undefined {
  const name = typeof author === 'string' ? author : author?.name
  return name?.replace(/\s*[<(].*$/, '').trim() || undefined
}

function repositoryUrl(repository: PackageJson['repository']): string | undefined {
  const url = typeof repository === 'string' ? repository : repository?.url
  return url?.replace(/^git\+/, '').replace(/\.git$/, '')
}

function licenseText(root: string, pkg: PackageJson): string {
  const files = readdirSync(root)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
  if (files.length > 0) {
    return files.map((name) => readFileSync(join(root, name), 'utf8').trim()).join('\n\n')
  }
  const author = authorName(pkg.author)
  if (pkg.license === 'MIT' && author) {
    return `MIT License\n\nCopyright (c) ${author}\n\n${MIT_TEXT}`
  }
  throw new Error(`${pkg.name}@${pkg.version} has no license file; add its ${pkg.license ?? 'license'} text by hand`)
}

const DESKTOP_INTRO =
  'DiskGrove includes the following third-party software. Electron and Chromium are\n' +
  'covered by LICENSE.electron.txt and LICENSES.chromium.html in the application folder.'

export interface LicenseFileOptions {
  /** The opening paragraph; the default names the desktop app's Electron and Chromium license files. */
  intro?: string
  /** Sections for software that does not come from npm, placed after the npm packages. */
  appendix?: string
}

export function renderLicenses(roots: Iterable<string>, options: LicenseFileOptions = {}): string {
  const sections = [...new Set(roots)].map((root) => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson
    const source = repositoryUrl(pkg.repository)
    const header = [`${pkg.name} ${pkg.version}`, `License: ${pkg.license ?? 'see below'}`]
    if (source) header.push(`Source: ${source}`)
    return { name: pkg.name, text: `${RULE}\n${header.join('\n')}\n${RULE}\n\n${licenseText(root, pkg)}\n` }
  })
  sections.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const texts = sections.map((section) => section.text)
  if (options.appendix) texts.push(options.appendix)
  return (options.intro ?? DESKTOP_INTRO) + '\n\n' + texts.join('\n')
}

/** A Java library that Gradle builds into the Android app; listed in android/third-party-libraries.json. */
export interface JavaLibrary {
  name: string
  /** Maven groups, where a trailing `.*` also matches subgroups. The Gradle build checks the APK against them. */
  groups: string[]
  /** An SPDX identifier, with its text in `licenseDir`. */
  license: string
  source: string
}

// Gradle libraries are not in node_modules, so their license texts are kept in the repository,
// and the libraries that share a license share one copy of it.
export function renderJavaLibraries(libraries: JavaLibrary[], licenseDir: string): string {
  const byLicense = new Map<string, JavaLibrary[]>()
  for (const library of libraries) {
    byLicense.set(library.license, [...(byLicense.get(library.license) ?? []), library])
  }
  return [...byLicense.keys()]
    .sort()
    .map((license) => {
      const users = byLicense.get(license)!.sort((a, b) => a.name.localeCompare(b.name, 'en'))
      const file = join(licenseDir, `${license}.txt`)
      if (!existsSync(file)) {
        throw new Error(`${users.map((l) => l.name).join(', ')} use ${license}; add its text as ${file}`)
      }
      const header = users.map((l) => `${l.name}\nLicense: ${l.license}\nSource: ${l.source}`).join('\n\n')
      return `${RULE}\n${header}\n${RULE}\n\n${readFileSync(file, 'utf8').trim()}\n`
    })
    .join('\n')
}

// `extra` names packages whose output reaches the bundle without a JavaScript module,
// such as Tailwind's generated CSS.
export function thirdPartyLicensesPlugin(extra: string[] = [], options: LicenseFileOptions = {}): Plugin {
  return {
    name: 'diskgrove-third-party-licenses',
    apply: 'build',
    generateBundle(_, bundle) {
      const roots = new Set(extra.map((name) => join(process.cwd(), 'node_modules', name).replaceAll('\\', '/')))
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const [id, info] of Object.entries(output.modules)) {
          const root = info.renderedLength > 0 ? packageRoot(id) : null
          if (root) roots.add(root)
        }
      }
      this.emitFile({ type: 'asset', fileName: LICENSES_FILE, source: renderLicenses(roots, options) })
    }
  }
}

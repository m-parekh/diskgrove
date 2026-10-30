// The parts of Node's POSIX path module the shared scanner code uses, for the Android WebView.

export const sep = '/'
export const delimiter = ':'

function normalizeParts(parts: string[], absolute: boolean): string[] {
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
    } else {
      out.push(part)
    }
  }
  return out
}

export function isAbsolute(p: string): boolean {
  return p.startsWith('/')
}

export function normalize(p: string): string {
  if (!p) return '.'
  const absolute = isAbsolute(p)
  let joined = normalizeParts(p.split('/'), absolute).join('/')
  if (!joined && !absolute) joined = '.'
  if (joined && p.endsWith('/')) joined += '/'
  return absolute ? `/${joined}` : joined
}

export function join(...parts: string[]): string {
  const joined = parts.filter(Boolean).join('/')
  return joined ? normalize(joined) : '.'
}

/** Like Node's, but with no working directory: relative paths resolve against the filesystem root. */
export function resolve(...parts: string[]): string {
  let resolved = ''
  for (let i = parts.length - 1; i >= 0 && !isAbsolute(resolved); i--) {
    if (parts[i]) resolved = resolved ? `${parts[i]}/${resolved}` : parts[i]
  }
  return `/${normalizeParts(resolved.split('/'), true).join('/')}`
}

function trimTrailing(p: string): string {
  let end = p.length
  while (end > 1 && p[end - 1] === '/') end--
  return p.slice(0, end)
}

export function dirname(p: string): string {
  if (!p) return '.'
  const trimmed = trimTrailing(p)
  const cut = trimmed.lastIndexOf('/')
  if (cut === -1) return '.'
  if (cut === 0) return '/'
  return trimTrailing(trimmed.slice(0, cut))
}

export function basename(p: string, ext?: string): string {
  const trimmed = trimTrailing(p)
  if (trimmed === '/') return ''
  let base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  if (ext && base !== ext && base.endsWith(ext)) base = base.slice(0, -ext.length)
  return base
}

export function extname(p: string): string {
  const base = basename(p)
  const dot = base.lastIndexOf('.')
  return dot <= 0 || base === '..' ? '' : base.slice(dot)
}

export function parse(p: string): { root: string; dir: string; base: string; ext: string; name: string } {
  const root = isAbsolute(p) ? '/' : ''
  const base = basename(p)
  const ext = extname(base)
  const dir = base ? dirname(p) : root
  return {
    root,
    dir: dir === '.' && !p.includes('/') ? '' : dir,
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base
  }
}

const path = { sep, delimiter, isAbsolute, normalize, join, resolve, dirname, basename, extname, parse }
export const posix = path
export default path

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import {
  renderJavaLibraries,
  thirdPartyLicensesPlugin,
  type JavaLibrary,
  type LicenseFileOptions
} from './scripts/third-party-licenses'

// The Android app's WebView page. Scanned media streams from the app's own origin (see MainActivity),
// so 'self' takes the place of the desktop app's diskgrove-media: scheme.
const ANDROID_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'self'"
].join('; ')

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

const javaLibraries = JSON.parse(readFileSync('android/third-party-libraries.json', 'utf8')) as JavaLibrary[]

const LICENSES: LicenseFileOptions = {
  intro:
    'DiskGrove for Android includes the following third-party software: the npm packages\n' +
    'in the app and its Capacitor runtime, then the Java libraries that Android builds in.',
  appendix: renderJavaLibraries(javaLibraries, resolve('scripts/licenses'))
}

// Capacitor's runtime and plugins compile Java into the app whether or not their JavaScript is
// bundled. Tailwind reaches the bundle only as generated CSS.
const LICENSED_PACKAGES = ['tailwindcss', '@capacitor/android', '@capacitor/app']

function cspPlugin(): Plugin {
  return {
    name: 'diskgrove-android-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: ANDROID_CSP },
        injectTo: 'head-prepend'
      }
    ]
  }
}

// Desktop builds ship THIRD_PARTY_NOTICES.md beside the license list (see electron-builder.yml).
function noticesPlugin(): Plugin {
  return {
    name: 'diskgrove-android-notices',
    apply: 'build',
    generateBundle() {
      const source = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8')
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.md', source })
    }
  }
}

export default defineConfig({
  root: resolve('src/android'),
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(version)
  },
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
      // The scanner shared with desktop imports these; the WebView gets small stand-ins.
      'node:path': resolve('src/android/shims/path.ts'),
      'node:timers/promises': resolve('src/android/shims/timers.ts')
    }
  },
  plugins: [
    react(),
    tailwindcss(),
    cspPlugin(),
    thirdPartyLicensesPlugin(LICENSED_PACKAGES, LICENSES),
    noticesPlugin()
  ],
  build: {
    outDir: resolve('out/android'),
    emptyOutDir: true,
    target: 'chrome100'
  }
})

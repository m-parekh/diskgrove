# Contributing to DiskGrove

Bug reports should include the OS, DiskGrove version, reproduction steps and expected
behavior. Remove private paths from logs and screenshots. Report vulnerabilities in
[SECURITY.md](SECURITY.md).

Discuss larger features in an issue before starting a PR.

## Source layout

| Location            | Responsibility                                                                    |
| ------------------- | --------------------------------------------------------------------------------- |
| `src/main/`         | Filesystem scanning, file actions, IPC validation, previews, settings and reports |
| `src/preload/`      | Typed API exposed to the sandboxed renderer                                       |
| `src/shared/`       | Data types, formatting, themes, treemap layout, CSV and ZIP readers               |
| `src/renderer/src/` | React views, scan state and the PDF, Office and media previews                    |
| `src/android/`      | The Android app's API, scanner and entry page, over the native plugin             |
| `android/`          | Capacitor's Android project and the Java plugin for files, volumes and dialogs    |
| `resources/`        | App icon, Windows uninstall hooks and the macOS/Linux uninstall script            |
| `scripts/`          | Icon generation and the bundled third-party license list                          |
| `tests/`            | Filesystem fixtures, boundary regression and uninstall script tests               |
| `benchmarks/`       | Scanner and disk benchmarks, run with `npm run benchmark`                         |

Filesystem access belongs in the main process. Validate renderer arguments there
and keep file-action confirmation and identity checks at that boundary. On
Android, `src/android/api.ts` is that boundary: it applies the same validators
before calling the Java plugin.

Vite owns build output. Do not emit JavaScript into `src/`, where it can shadow
TypeScript sources.

## App icon

The artwork is `resources/icon.svg`, with `resources/icon-small.svg` as the
simplified drawing used at 48px and below. `npm run icons` rasterizes both into
`icon.ico` (Windows), `icon.png` (macOS, on Apple's padded grid) and `icons/`
(Linux). Commit the generated files with the SVG change. The title bar mark in
`src/renderer/src/components/app-logo.tsx` is drawn separately.

Keep the artwork original: no third-party glyphs, fonts or clip art.

## Third-party licenses

`npm run build` writes `out/renderer/THIRD_PARTY_LICENSES.txt` from the npm
packages that reach the renderer bundle, and electron-builder ships it in the
app's `resources` folder. A package without a license file fails the build unless
it is MIT, whose text is reproduced from its `package.json`; add the missing text
to `THIRD_PARTY_NOTICES.md` by hand. Code copied into the repository, such as the
shadcn/ui components, needs its notice in `THIRD_PARTY_NOTICES.md`.

Vite bundles every npm package the app uses, so they all belong in
`devDependencies`: electron-builder copies `dependencies` into the ASAR whole.
Use `dependencies` only for a package the main process must load from
`node_modules` at runtime, such as a native module; it then ships with its own
license files. The main and preload builds currently import no npm packages. If
one of them starts bundling one, add `thirdPartyLicensesPlugin` to that build too.

The Android build writes the same file into the APK, with `THIRD_PARTY_NOTICES.md`,
adding the Capacitor packages listed in `vite.android.config.ts` and the Java
libraries in `android/third-party-libraries.json`, whose license texts are in
`scripts/licenses/`. Gradle fails the build when the app contains a Maven library
that the JSON file does not cover. Add a new Capacitor plugin to the list in
`vite.android.config.ts`.

## Uninstallers

Windows uses the electron-builder NSIS uninstaller, extended by
`resources/installer.nsh`. The macOS app and the AppImage have no installer, so
`resources/uninstall.sh` is bundled into them instead. The .deb carries it too,
for the per-user data that apt leaves behind; apt removes the package itself.
Both ask whether to remove `settings.json`, keep it when run unattended unless
`--delete-app-data` is passed, and always remove caches.

When the app starts writing somewhere new, add that location to both files and
to Uninstalling in the README. Keep the script POSIX `sh`: Linux runs it with
`dash`.

`tests/uninstall.test.ts` runs the script against a temporary home directory
with stand-ins for `uname`, `pgrep`, `pkill`, `defaults` and `dpkg-query`. It
needs a POSIX shell and is skipped on Windows, so only the Linux and macOS CI jobs run it.
Nothing automated covers `installer.nsh`; test it by hand as described below.

## Before sending a pull request

```sh
npm ci
npm run check
npm run build
npm audit
```

For changes that reach the Android app, also run `npm run android:apk`.

Add regression tests for scanning, deletion, exports, previews, IPC and
uninstall script changes. Use disposable fixtures and mock Electron's shell and
dialogs; never operate on existing user files. `tests/android.test.ts` runs the
Android API and scanner against a stand-in for the Java plugin that uses Node's
`fs`.

Run `npm run format` to format changes. Describe the problem, resulting behavior
and testing in the PR, including any platforms you could not check.

## Releasing

1. Set the new version in `package.json` (`npm version <version> --no-git-tag-version`
   updates the lockfile too) and commit it.
2. Tag the commit `v<version>` and push the tag. A ruleset lets only the
   repository admin create, move or delete `v*` tags.
3. `.github/workflows/release.yml` checks that the tag matches `package.json`,
   creates a draft release with generated notes, builds the Windows, macOS
   (arm64 and x64) and Linux (AppImage and .deb) installers and the Android APK
   with a read-only token, then attaches each one with a `.sha256` file from a
   separate job. The notes start with a line saying that the macOS and Android
   builds are in beta, and that Android users must uninstall the previous
   version first; edit it in the workflow when that changes.
4. Smoke test the installers and the APK, edit the notes, then publish the draft.

The APK's `versionCode` is derived from the version as
`major * 10000 + minor * 100 + patch`, so minor and patch must stay below 100.
Each release runner generates a new debug signing key, which is why Android
will not update one release over another. Signing with a kept key needs a
keystore stored as a repository secret and a `signingConfigs.release` in
`android/app/build.gradle`.

Rerunning the workflow for the same tag replaces the attached files while the
release is a draft. Published releases are immutable: their files and tag can no
longer change, so fix a bad release with a new version.

## Desktop smoke test

Use a disposable directory with nested folders, several file sizes, two identical
files and a pair with different contents. Include a filename with quotes or HTML
characters where the operating system permits it, and one file of each preview
type: an image, a video, an audio file, a PDF, a text file, a CSV, Word, Excel
and PowerPoint documents, and a ZIP archive.

1. Run `npm run dev`, scan the fixture, and check totals and each view.
2. Cancel a scan and start another. Confirm that results belong to the new root.
   Search during the scan, then search a subfolder with **Selected folder** and
   the whole fixture with **Entire scan**; check wildcards, a name with accents,
   **Show in tree**, and that a deleted result drops out of the list.
3. Find duplicates and verify that different content is excluded.
4. Select each preview fixture and check that the pane shows its content and
   details. Seek in the video and audio, and page through the PDF.
5. Export each format. Check paths, escaping and totals; delete a fixture item
   and export again to ensure it is absent.
6. Cancel both native open and delete prompts. Confirm no action occurs.
7. Trash a fixture file, then restore it with the system file manager. Test
   permanent deletion only on another disposable fixture.
8. Run `npm run pack` and repeat the main flow with the packaged application.
   Check that preload loads and navigation stays inside the app.

Before releasing, test installers, previews, permissions and Trash behavior on
each target OS. Automated tests mock OS integration.

Uninstall on each OS as well:

1. Uninstall and keep the settings. Only `settings.json` should remain in the
   data folder; every other path listed under Uninstalling in the README should
   be gone.
2. Install again, uninstall and remove the settings. The data folder should be
   gone too.
3. On Windows, repeat both silently (`/S`, then `/S --delete-app-data`) and
   check that installing over an existing version keeps everything.
4. On macOS and Linux, repeat both with `-y` and `-y --delete-app-data`.
5. For the .deb, install it with `sudo apt install ./DiskGrove-*.deb`, check the
   menu entry and the `diskgrove` command, run the script from
   `/opt/DiskGrove/resources`, then `sudo apt remove diskgrove`. `/opt/DiskGrove`
   and `/usr/bin/diskgrove` should be gone.

The installed app and `npm run dev` share one data folder, so back up your own
settings before testing an uninstall on a development machine.

## Android

The Android app is the renderer in a Capacitor WebView. `src/android/main.tsx`
installs an Android implementation of `window.diskgrove` before the React app
starts, and the scanner shares `src/main/scan-results.ts` with desktop, reading
the filesystem through the `DiskGroveNative` Java plugin instead of Node's
`fs`. `tsconfig.android.json` typechecks that code without Node types, and
`node:path` resolves to `src/android/shims/path.ts` in the Android build.

Install JDK 21 and the Android SDK (platform 36 and platform tools), set
`ANDROID_HOME` and `JAVA_HOME`, then:

```sh
npm run android:sync  # build out/android and copy it into the Android project
npm run android:apk   # also build the signed release APK
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Use an emulator with Google APIs and API 30 or later, so that all files access
behaves as on current phones. To inspect the WebView from `chrome://inspect`,
install a debug build instead: run `./gradlew assembleDebug` in `android/` and
install `app/build/outputs/apk/debug/app-debug.apk`. Release builds turn WebView
debugging off.

Capacitor generated the project; `npx cap sync android` rewrites
`android/capacitor.settings.gradle` and `android/app/capacitor.build.gradle`, so
make changes elsewhere. The app's version comes from `package.json`.

## Android smoke test

Push the desktop fixture to the emulator, for example with
`adb push fixture /sdcard/Download/`, and check the same flow on a phone-sized
screen:

1. Grant all files access, then scan internal storage and the fixture with
   **Scan this folder**. Check totals, every view and both panes.
2. Pick a subfolder with **Select folder**, then check search and duplicates.
3. Preview each fixture type, including video and audio seeking.
4. Open a file with another app, cancel a delete prompt, then delete a
   disposable file and confirm that it is gone.
5. Export each format through the system file picker and check the files.
6. Press Back through dialogs, panes and folders, and check that the app goes to
   the background at the scan root.
7. Switch between light and dark themes and change the font size.

# Security

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/tanmay-73/diskgrove/security/advisories/new)
if enabled. Otherwise, open an issue requesting a private contact without exploit
details. Include the version, OS, reproduction steps and impact in the private report.

There is no guaranteed response time. Fixes target current source and the next
release; older versions have no promised backports.

## Boundaries

DiskGrove runs with the user's filesystem permissions. Avoid administrator or root
access for routine scans.

The renderer is sandboxed with context isolation, Node integration disabled and
a narrow preload API. IPC checks the sender window, top-level frame and app
document, then validates arguments. Navigation, popups and webviews are denied,
and so is every web permission except sanitized clipboard writes, which **Copy
path** uses. Production builds inject a CSP and block HTTP, HTTPS
and WebSocket requests in the Electron session. Development uses a local Vite
server with no CSP and no request blocking.

Opening and deletion require a main-process native dialog with Cancel as the
default. Paths must belong to the current scan. Before file actions, DiskGrove
rechecks file identity and ancestors and refuses traversal through symbolic
links or junctions. A scanned link itself may be deleted without deleting its
target. Scan and filesystem operations cannot overlap through IPC.

The preview pane reads only regular files in the current scan, after the same
identity check, and at most 16 MiB per request. Images, video and audio stream
through a private `diskgrove-media:` scheme with `nosniff` and a CSP that
blocks scripts. PDFs render with PDF.js in a worker with XFA forms disabled.
Office documents and ZIP archives are parsed in the renderer and shown as text
and tables; their contents never become HTML or script.

HTML reports escape data and apply a CSP. CSV cells with formula-like prefixes
are escaped. Reports and settings are written to exclusive temporary files and
renamed into place, with POSIX mode 0600; Windows uses the destination folder's
ACLs. Settings writes are serialized.

The uninstallers run with the user's permissions and delete fixed per-user
locations only. Settings are kept unless the user chooses to remove them or
passes `--delete-app-data`. The macOS and Linux script lists its targets and
asks before deleting, refuses to run unattended without `-y`, removes an app
bundle only if its `Info.plist` carries DiskGrove's bundle identifier, and
accepts a path argument only for such a bundle or a file named `*.AppImage`. It
never removes the .deb package; it tells the user to run `apt remove` instead.

The packaging configuration disables Electron's generic Node runtime,
`NODE_OPTIONS` and CLI inspection fuses, restricts code loading to ASAR and
enables embedded ASAR integrity checks where Electron supports them. Keep
Electron updated. It and the libraries Vite bundles into the renderer are listed
as development dependencies but ship in the app, so an audit with `--omit=dev`
misses them.

Release builds run with a read-only repository token; a separate job that runs no
npm code attaches the installers to the draft release. Only the repository admin
can create release tags or update `main`, and published releases are immutable.
Dependabot waits seven days before proposing a new dependency version, except for
security updates. CI checks the Gradle wrapper against Gradle's published
checksums before running it.

## Android

The Android app has no process boundary between the interface and the
filesystem. The React app, the scanner and `src/android/api.ts` share one
WebView, and that code calls the `DiskGroveNative` Java plugin, which can read
and delete anything in shared storage. `api.ts` applies the desktop validators,
accepts only paths in the current scan, and runs the same identity, ancestor and
link checks before file actions. These checks guard against interface mistakes.
They do not contain script running in the WebView. That page loads only from the
APK, under a CSP that allows the app's own scripts and no connections. The app
requests no `INTERNET` permission.

DiskGrove asks for All files access (`MANAGE_EXTERNAL_STORAGE`) on Android 11
and later, and for the storage permissions before that. App backups are off.
Deletion waits for a native dialog, and dismissing it deletes nothing. Opening a
file shows the system app chooser every time; the chosen app gets read access to
that file only, through a FileProvider that is not exported. Previews of
images, audio and video stream from a path on the app's own origin that answers
only GET requests for those types, with `nosniff` and a CSP that blocks scripts;
it is not limited to scanned files. Reports are saved through the system file
picker. Settings and recent scans stay in the WebView's storage inside the app's
private data.

## Limits

- Identity checks are not atomic with file actions. A local writer can still race
  them. Recursive deletion includes current contents, including hidden, unreadable
  or newly added entries.
- Opening a file invokes its OS handler and can execute a program.
- Previews parse untrusted file content with PDF.js and Chromium's image and
  media decoders. A flaw in one of them could be reached by selecting a crafted
  file; on desktop the renderer sandbox limits what it can do. On Android, such
  a flaw would run with the app's All files access, because the WebView also
  holds the native plugin.
- Duplicate results are snapshots of content hashes. Files can change afterward;
  hard links and reflinks can overstate recoverable space.
- Network mounts and OS handlers may access the network outside Electron's
  session. The app has no telemetry, accounts or automatic update service.
- Reports include full paths, and settings retain recent scan paths. Neither is
  encrypted by DiskGrove. Review exports before sharing them. Settings stay on
  disk after uninstalling unless you choose to remove them.
- The uninstall script finds AppImages by file name (`DiskGrove-*.AppImage`) in
  common folders of the home directory and closes processes named `diskgrove`
  (`DiskGrove` on macOS). Check the list it prints before confirming.
- Very large scans can exhaust memory or slow the UI.
- On Linux, Chromium's process sandbox needs unprivileged user namespaces. Where
  they are unavailable, the AppImage launcher starts DiskGrove with
  `--no-sandbox`, as other Electron AppImages do; context isolation, the preload
  boundary and IPC validation still apply. The .deb keeps the sandbox there by
  making `chrome-sandbox` setuid root at install time, and on Ubuntu 24.04 and
  later installs an AppArmor profile that allows DiskGrove user namespaces.
- Releases are not code-signed or notarized, so the operating system cannot
  verify the publisher. The `.sha256` files only detect corrupted downloads,
  since they are published alongside the installers. Development builds do not
  provide the same protections as packaged releases.
- The Android APK is signed with a debug key that the release runner generates,
  so the signature identifies nobody and changes with every release. Android
  treats each release as an unrelated app, so users must uninstall the previous
  one first and cannot rely on the signature to tell DiskGrove from a lookalike.

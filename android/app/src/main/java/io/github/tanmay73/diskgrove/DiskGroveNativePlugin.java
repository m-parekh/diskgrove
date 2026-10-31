package io.github.tanmay73.diskgrove;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.storage.StorageManager;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.Base64;
import android.view.Window;
import android.webkit.MimeTypeMap;
import androidx.activity.result.ActivityResult;
import androidx.appcompat.app.AlertDialog;
import androidx.core.app.ActivityCompat;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/**
 * The filesystem and system access the Android app's scanner needs. Its methods and results are
 * described by DiskGroveNativePlugin in src/android/native-api.ts.
 */
@CapacitorPlugin(
    name = "DiskGroveNative",
    permissions = {
        @Permission(
            alias = DiskGroveNativePlugin.STORAGE,
            strings = { Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE }
        )
    }
)
public class DiskGroveNativePlugin extends Plugin {

    static final String STORAGE = "storage";

    /** MAX_PREVIEW_READ in src/shared/preview.ts. */
    private static final long MAX_READ = 16 * 1024 * 1024;

    // Capacitor runs every plugin call on one thread, so slow work moves to these pools.
    private final ExecutorService fsPool = Executors.newFixedThreadPool(4);
    private final ExecutorService hashPool = Executors.newFixedThreadPool(2);
    private final ExecutorService exportPool = Executors.newSingleThreadExecutor();
    private final ExecutorService appsPool = Executors.newSingleThreadExecutor();
    private final ExecutorService mediaPool = Executors.newSingleThreadExecutor();

    private final AtomicInteger hashGeneration = new AtomicInteger();
    private final Map<String, Export> exports = new ConcurrentHashMap<>();

    // Main thread only.
    private Integer windowColor;
    private boolean windowDark;

    private static final class Export {

        final Uri uri;
        final OutputStream out;

        Export(Uri uri, OutputStream out) {
            this.uri = uri;
            this.out = out;
        }
    }

    private interface Task {
        void run() throws Exception;
    }

    private static void fail(PluginCall call, Exception e) {
        if (e instanceof NativeFs.FsException) {
            call.reject(e.getMessage(), ((NativeFs.FsException) e).code);
            return;
        }
        String message = e.getMessage();
        call.reject(message != null ? message : e.getClass().getSimpleName());
    }

    private void run(ExecutorService pool, PluginCall call, Task task) {
        try {
            pool.execute(() -> {
                try {
                    task.run();
                } catch (Exception e) {
                    fail(call, e);
                }
            });
        } catch (RejectedExecutionException e) {
            call.reject("DiskGrove is closing");
        }
    }

    private static boolean isAbsolutePath(Object value) {
        return value instanceof String && ((String) value).startsWith("/") && ((String) value).indexOf('\0') < 0;
    }

    private static String pathArg(PluginCall call, String key) {
        Object value = call.getData().opt(key);
        if (isAbsolutePath(value)) return (String) value;
        call.reject("Expected an absolute path", "EINVAL");
        return null;
    }

    /** A whole number of zero or more; Capacitor's getLong rejects the ones small enough to arrive as Integer. */
    private static Long countArg(PluginCall call, String key) {
        Object value = call.getData().opt(key);
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (number >= 0 && number <= Long.MAX_VALUE && number == Math.floor(number)) return ((Number) value).longValue();
        }
        call.reject("Expected a whole number for " + key, "EINVAL");
        return null;
    }

    private static JSObject result(String key, Object value) {
        JSObject out = new JSObject();
        out.put(key, value == null ? JSONObject.NULL : value);
        return out;
    }

    @Override
    protected void handleOnDestroy() {
        fsPool.shutdownNow();
        hashPool.shutdownNow();
        exportPool.shutdownNow();
        appsPool.shutdownNow();
        mediaPool.shutdownNow();
        for (Export export : exports.values()) {
            try {
                export.out.close();
            } catch (IOException ignored) {
                // The app is going away; the half-written report is removed below.
            }
            deleteDocument(export.uri);
        }
        exports.clear();
    }

    // Folders and files

    @PluginMethod
    public void listDir(PluginCall call) {
        String path = pathArg(call, "path");
        if (path == null) return;
        boolean follow = Boolean.TRUE.equals(call.getBoolean("followLinks", false));
        run(fsPool, call, () -> call.resolve(NativeFs.listDir(path, follow)));
    }

    @PluginMethod
    public void statMany(PluginCall call) {
        JSArray paths = call.getArray("paths");
        if (paths == null) {
            call.reject("Expected a list of paths", "EINVAL");
            return;
        }
        boolean follow = Boolean.TRUE.equals(call.getBoolean("follow", false));
        run(fsPool, call, () -> {
            JSArray results = new JSArray();
            for (int i = 0; i < paths.length(); i++) {
                Object path = paths.opt(i);
                JSObject entry = new JSObject();
                if (!isAbsolutePath(path)) {
                    entry.put("error", "EINVAL");
                } else {
                    try {
                        entry.put("stats", NativeFs.stats(follow ? Os.stat((String) path) : Os.lstat((String) path)));
                    } catch (ErrnoException e) {
                        entry.put("error", NativeFs.errnoName(e));
                    }
                }
                results.put(entry);
            }
            call.resolve(result("results", results));
        });
    }

    @PluginMethod
    public void realPath(PluginCall call) {
        String path = pathArg(call, "path");
        if (path == null) return;
        run(fsPool, call, () -> call.resolve(result("path", NativeFs.realPath(path))));
    }

    @PluginMethod
    public void hashFile(PluginCall call) {
        String path = pathArg(call, "path");
        if (path == null) return;
        Long size = countArg(call, "size");
        if (size == null) return;
        Long head = countArg(call, "head");
        if (head == null) return;
        Long tail = countArg(call, "tail");
        if (tail == null) return;
        if (head > Integer.MAX_VALUE || tail > Integer.MAX_VALUE) {
            call.reject("Sample sizes are too large", "EINVAL");
            return;
        }
        boolean full = "full".equals(call.getString("mode"));
        int generation = hashGeneration.get();
        run(hashPool, call, () ->
            call.resolve(
                NativeFs.hash(path, size, full, head.intValue(), tail.intValue(), () -> hashGeneration.get() != generation)
            )
        );
    }

    @PluginMethod
    public void cancelHashes(PluginCall call) {
        hashGeneration.incrementAndGet();
        call.resolve();
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String path = pathArg(call, "path");
        if (path == null) return;
        if (path.equals("/")) {
            call.reject("Refusing to delete the filesystem root", "EPERM");
            return;
        }
        run(fsPool, call, () -> {
            NativeFs.removeTree(path);
            // Gallery and other apps read the media index, which may still list what was just deleted.
            MediaScannerConnection.scanFile(getContext(), new String[] { path }, null, null);
            call.resolve();
        });
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        String path = pathArg(call, "path");
        if (path == null) return;
        Long offset = countArg(call, "offset");
        if (offset == null) return;
        Long length = countArg(call, "length");
        if (length == null) return;
        run(fsPool, call, () -> {
            FileDescriptor fd = NativeFs.openRegular(path);
            try {
                long size = NativeFs.fstat(fd, path).st_size;
                long start = Math.min(offset, size);
                int want = (int) Math.max(0, Math.min(Math.min(length, MAX_READ), size - start));
                byte[] buffer = new byte[want];
                int read = NativeFs.readAt(fd, path, buffer, want, start);
                JSObject out = new JSObject();
                out.put("data", Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP));
                out.put("offset", start);
                out.put("size", size);
                call.resolve(out);
            } finally {
                NativeFs.close(fd);
            }
        });
    }

    // Storage

    @PluginMethod
    public void volumes(PluginCall call) {
        run(fsPool, call, () -> call.resolve(result("volumes", StorageVolumes.list(getContext()))));
    }

    @PluginMethod
    public void space(PluginCall call) {
        String path = pathArg(call, "path");
        if (path == null) return;
        run(fsPool, call, () -> call.resolve(StorageVolumes.space(path)));
    }

    @PluginMethod
    public void home(PluginCall call) {
        call.resolve(result("path", StorageVolumes.primary().getAbsolutePath()));
    }

    private boolean hasStorageAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return Environment.isExternalStorageManager();
        return getPermissionState(STORAGE) == PermissionState.GRANTED;
    }

    @PluginMethod
    public void storageAccess(PluginCall call) {
        call.resolve(result("granted", hasStorageAccess()));
    }

    @PluginMethod
    public void requestStorageAccess(PluginCall call) {
        if (hasStorageAccess()) {
            call.resolve(result("granted", true));
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Uri app = Uri.parse("package:" + getContext().getPackageName());
            try {
                startActivityForResult(
                    call,
                    new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, app),
                    "storageAccessResult"
                );
            } catch (ActivityNotFoundException e) {
                try {
                    startActivityForResult(
                        call,
                        new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION),
                        "storageAccessResult"
                    );
                } catch (ActivityNotFoundException e2) {
                    call.reject("This device has no setting for all files access");
                }
            }
            return;
        }
        requestPermissionForAlias(STORAGE, call, "storagePermissionResult");
    }

    @ActivityCallback
    private void storageAccessResult(PluginCall call, ActivityResult ignored) {
        if (call != null) call.resolve(result("granted", hasStorageAccess()));
    }

    @PermissionCallback
    private void storagePermissionResult(PluginCall call) {
        boolean granted = hasStorageAccess();
        Activity activity = getActivity();
        if (
            !granted &&
            !ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.READ_EXTERNAL_STORAGE)
        ) {
            // Android stops asking after the permission was refused for good; only the app's settings can grant it.
            Intent settings = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:" + getContext().getPackageName()));
            try {
                activity.startActivity(settings);
            } catch (ActivityNotFoundException ignored) {
                // The access screen stays up, so the user can try again.
            }
        }
        call.resolve(result("granted", granted));
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        try {
            startActivityForResult(call, new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "pickFolderResult");
        } catch (ActivityNotFoundException e) {
            call.reject("This device has no folder picker");
        }
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult picked) {
        if (call == null) return;
        Intent data = picked.getData();
        Uri tree = picked.getResultCode() == Activity.RESULT_OK && data != null ? data.getData() : null;
        call.resolve(result("path", tree == null ? null : StorageVolumes.pathOfTree(getContext(), tree)));
    }

    // Access the user can grant

    private boolean holds(String permission) {
        return getContext().checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject access() {
        JSObject out = new JSObject();
        out.put("sdk", Build.VERSION.SDK_INT);
        out.put("files", hasStorageAccess());
        out.put("allFilesSetting", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R);
        out.put("usage", AppsInspector.hasUsageAccess(getContext()));
        out.put("appSizes", Build.VERSION.SDK_INT >= Build.VERSION_CODES.O);
        // Install-time permissions: granted with the app, but listed so the access screen shows all of them.
        out.put("packages", Build.VERSION.SDK_INT < Build.VERSION_CODES.R || holds(Manifest.permission.QUERY_ALL_PACKAGES));
        out.put("uninstall", Build.VERSION.SDK_INT < Build.VERSION_CODES.O || holds(Manifest.permission.REQUEST_DELETE_PACKAGES));
        out.put("clearCache", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R);
        return out;
    }

    @PluginMethod
    public void accessStatus(PluginCall call) {
        call.resolve(access());
    }

    @PluginMethod
    public void requestUsageAccess(PluginCall call) {
        if (AppsInspector.hasUsageAccess(getContext())) {
            call.resolve(access());
            return;
        }
        // Android 10 and later open DiskGrove's own switch when given its package; older versions list every app.
        Uri app = Uri.parse("package:" + getContext().getPackageName());
        try {
            startActivityForResult(call, new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, app), "accessResult");
        } catch (ActivityNotFoundException e) {
            try {
                startActivityForResult(call, new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS), "accessResult");
            } catch (ActivityNotFoundException e2) {
                call.reject("This device has no setting for usage access");
            }
        }
    }

    @ActivityCallback
    private void accessResult(PluginCall call, ActivityResult ignored) {
        if (call != null) call.resolve(access());
    }

    // Installed apps

    private static String packageArg(PluginCall call) {
        Object value = call.getData().opt("package");
        if (AppsInspector.isPackageName(value)) return (String) value;
        call.reject("Expected a package name", "EINVAL");
        return null;
    }

    @PluginMethod
    public void deviceStorage(PluginCall call) {
        run(appsPool, call, () -> call.resolve(AppsInspector.deviceSpace(getContext())));
    }

    @PluginMethod
    public void listApps(PluginCall call) {
        run(appsPool, call, () -> call.resolve(AppsInspector.list(getContext())));
    }

    @PluginMethod
    public void appInfo(PluginCall call) {
        String pkg = packageArg(call);
        if (pkg == null) return;
        run(appsPool, call, () -> call.resolve(result("app", AppsInspector.one(getContext(), pkg))));
    }

    @PluginMethod
    public void openApp(PluginCall call) {
        String pkg = packageArg(call);
        if (pkg == null) return;
        Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
        if (launch == null) {
            call.reject("This app cannot be opened");
            return;
        }
        try {
            getActivity().startActivity(launch);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("This app cannot be opened");
        }
    }

    /** The system's App info page, where the user can clear the app's cache and storage, or stop it. */
    @PluginMethod
    public void appDetails(PluginCall call) {
        String pkg = packageArg(call);
        if (pkg == null) return;
        Intent details = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
        try {
            startActivityForResult(call, details, "appReturnResult");
        } catch (ActivityNotFoundException e) {
            call.reject("This device has no App info page");
        }
    }

    /** Android's own uninstall dialog; nothing is removed unless the user confirms there. */
    @PluginMethod
    public void uninstallApp(PluginCall call) {
        String pkg = packageArg(call);
        if (pkg == null) return;
        if (pkg.equals(getContext().getPackageName())) {
            call.reject("DiskGrove cannot uninstall itself from here");
            return;
        }
        Intent uninstall = new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + pkg)).putExtra(
            Intent.EXTRA_RETURN_RESULT,
            true
        );
        try {
            startActivityForResult(call, uninstall, "appReturnResult");
        } catch (ActivityNotFoundException e) {
            call.reject("This device cannot uninstall apps from here");
        }
    }

    @ActivityCallback
    private void appReturnResult(PluginCall call, ActivityResult ignored) {
        if (call == null) return;
        String pkg = call.getString("package");
        run(appsPool, call, () -> call.resolve(result("app", AppsInspector.one(getContext(), pkg))));
    }

    /** Asks the user to clear every app's cache in shared storage (Android 11 and later, with all files access). */
    @PluginMethod
    public void clearAppCaches(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            call.reject("Clearing every app's cache needs Android 11 or later");
            return;
        }
        if (!hasStorageAccess()) {
            call.reject("Clearing every app's cache needs all files access");
            return;
        }
        try {
            startActivityForResult(call, new Intent(StorageManager.ACTION_CLEAR_APP_CACHE), "clearCacheResult");
        } catch (ActivityNotFoundException e) {
            call.reject("This device cannot clear app caches from here");
        }
    }

    @ActivityCallback
    private void clearCacheResult(PluginCall call, ActivityResult outcome) {
        if (call != null) call.resolve(result("cleared", outcome.getResultCode() == Activity.RESULT_OK));
    }

    /** The system's own "Free up space" screen. */
    @PluginMethod
    public void manageStorage(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) {
            call.reject("This device has no storage manager");
            return;
        }
        try {
            startActivityForResult(call, new Intent(StorageManager.ACTION_MANAGE_STORAGE), "manageStorageResult");
        } catch (ActivityNotFoundException e) {
            call.reject("This device has no storage manager");
        }
    }

    @ActivityCallback
    private void manageStorageResult(PluginCall call, ActivityResult ignored) {
        if (call != null) call.resolve();
    }

    // Shared storage by kind of file

    @PluginMethod
    public void mediaSummary(PluginCall call) {
        run(mediaPool, call, () -> call.resolve(MediaCategories.summary(getContext())));
    }

    @PluginMethod
    public void mediaFiles(PluginCall call) {
        Object kind = call.getData().opt("kind");
        if (!MediaCategories.isKind(kind)) {
            call.reject("Unknown kind of file", "EINVAL");
            return;
        }
        Long limit = countArg(call, "limit");
        if (limit == null) return;
        int cap = (int) Math.min(limit, 2000);
        run(mediaPool, call, () -> call.resolve(MediaCategories.files(getContext(), (String) kind, cap)));
    }

    // Other apps

    private static String mimeTypeOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0) return "*/*";
        String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
        return type != null ? type : "*/*";
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        String path = pathArg(call, "path");
        if (path == null) return;
        run(fsPool, call, () -> {
            if (!OsConstants.S_ISREG(NativeFs.stat(path).st_mode)) {
                throw new NativeFs.FsException("EISDIR", "Only files can be opened in other apps");
            }
            File file = new File(path);
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent view = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, mimeTypeOf(file.getName()))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            // The chooser asks every time, so opening a file always waits for the user to pick an app.
            Intent chooser = Intent.createChooser(view, null);
            getBridge().executeOnMainThread(() -> {
                try {
                    getActivity().startActivity(chooser);
                    call.resolve();
                } catch (ActivityNotFoundException e) {
                    call.reject("No app on this device can open this file");
                }
            });
        });
    }

    /**
     * Offers files to the apps that can receive them. The read grant is given explicitly, with the files
     * in the intent's ClipData: Android 17 asks apps not to rely on ACTION_SEND granting it implicitly.
     */
    @PluginMethod
    public void shareFiles(PluginCall call) {
        JSArray paths = call.getArray("paths");
        if (paths == null || paths.length() == 0 || paths.length() > 100) {
            call.reject("Expected between 1 and 100 paths", "EINVAL");
            return;
        }
        run(fsPool, call, () -> {
            ArrayList<Uri> uris = new ArrayList<>();
            String type = null;
            for (int i = 0; i < paths.length(); i++) {
                Object path = paths.opt(i);
                if (!isAbsolutePath(path)) throw new NativeFs.FsException("EINVAL", "Expected an absolute path");
                if (!OsConstants.S_ISREG(NativeFs.stat((String) path).st_mode)) {
                    throw new NativeFs.FsException("EISDIR", "Only files can be shared");
                }
                File file = new File((String) path);
                uris.add(FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file));
                String fileType = mimeTypeOf(file.getName());
                type = type == null || type.equals(fileType) ? fileType : commonType(type, fileType);
            }
            Intent send;
            if (uris.size() == 1) {
                send = new Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris.get(0));
            } else {
                send = new Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            }
            ClipData clip = ClipData.newRawUri(null, uris.get(0));
            for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
            send.setType(type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            send.setClipData(clip);
            Intent chooser = Intent.createChooser(send, null);
            getBridge().executeOnMainThread(() -> {
                try {
                    getActivity().startActivity(chooser);
                    call.resolve();
                } catch (ActivityNotFoundException e) {
                    call.reject("No app on this device can receive these files");
                }
            });
        });
    }

    /** image/* for a JPEG and a PNG, and any type for files that share nothing. */
    private static String commonType(String a, String b) {
        int slashA = a.indexOf('/');
        int slashB = b.indexOf('/');
        if (slashA > 0 && slashB > 0 && a.substring(0, slashA).equals(b.substring(0, slashB))) {
            return a.substring(0, slashA) + "/*";
        }
        return "*/*";
    }

    @PluginMethod
    public void confirm(PluginCall call) {
        String title = call.getString("title", "");
        String message = call.getString("message", "");
        String detail = call.getString("detail", "");
        String confirm = call.getString("confirm", "OK");
        getBridge().executeOnMainThread(() -> {
            Activity activity = getActivity();
            if (activity == null || activity.isFinishing()) {
                call.resolve(result("confirmed", false));
                return;
            }
            AtomicBoolean answered = new AtomicBoolean();
            int theme = windowColor == null ? 0 : windowDark ? R.style.DiskGroveDialog_Dark : R.style.DiskGroveDialog_Light;
            new AlertDialog.Builder(activity, theme)
                .setTitle(title)
                .setMessage(detail.isEmpty() ? message : message + "\n\n" + detail)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(confirm, (dialog, which) -> {
                    if (answered.compareAndSet(false, true)) call.resolve(result("confirmed", true));
                })
                .setOnDismissListener((dialog) -> {
                    if (answered.compareAndSet(false, true)) call.resolve(result("confirmed", false));
                })
                .show();
        });
    }

    // Report export

    @PluginMethod
    public void exportBegin(PluginCall call) {
        String name = call.getString("name", "diskgrove-report");
        String type = call.getString("type", "application/octet-stream");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(type)
            .putExtra(Intent.EXTRA_TITLE, name);
        try {
            startActivityForResult(call, intent, "exportBeginResult");
        } catch (ActivityNotFoundException e) {
            call.reject("This device has no way to save files");
        }
    }

    @ActivityCallback
    private void exportBeginResult(PluginCall call, ActivityResult picked) {
        if (call == null) return;
        Intent data = picked.getData();
        Uri uri = picked.getResultCode() == Activity.RESULT_OK && data != null ? data.getData() : null;
        if (uri == null) {
            JSObject out = result("id", null);
            out.put("name", "");
            call.resolve(out);
            return;
        }
        String fallbackName = call.getString("name", "diskgrove-report");
        run(exportPool, call, () -> {
            ContentResolver resolver = getContext().getContentResolver();
            OutputStream stream;
            try {
                stream = resolver.openOutputStream(uri, "wt");
            } catch (FileNotFoundException | IllegalArgumentException e) {
                // Some document providers cannot truncate; the document is new and empty anyway.
                stream = resolver.openOutputStream(uri, "w");
            }
            if (stream == null) throw new IOException("The report could not be written there");
            String id = UUID.randomUUID().toString();
            exports.put(id, new Export(uri, new BufferedOutputStream(stream, 64 * 1024)));
            JSObject out = result("id", id);
            out.put("name", displayName(resolver, uri, fallbackName));
            call.resolve(out);
        });
    }

    private static String displayName(ContentResolver resolver, Uri uri, String fallback) {
        try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
        } catch (RuntimeException ignored) {
            // The name the user was offered is the best guess left.
        }
        return fallback;
    }

    private void deleteDocument(Uri uri) {
        try {
            DocumentsContract.deleteDocument(getContext().getContentResolver(), uri);
        } catch (Exception ignored) {
            // The provider may not support deleting; an incomplete report is left behind.
        }
    }

    @PluginMethod
    public void exportWrite(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data", "");
        run(exportPool, call, () -> {
            Export export = id == null ? null : exports.get(id);
            if (export == null) throw new IOException("That export is not open");
            export.out.write(data.getBytes(StandardCharsets.UTF_8));
            call.resolve();
        });
    }

    @PluginMethod
    public void exportEnd(PluginCall call) {
        String id = call.getString("id");
        boolean ok = Boolean.TRUE.equals(call.getBoolean("ok", false));
        run(exportPool, call, () -> {
            Export export = id == null ? null : exports.remove(id);
            if (export == null) {
                call.resolve();
                return;
            }
            IOException closeError = null;
            try {
                export.out.close();
            } catch (IOException e) {
                closeError = e;
            }
            if (!ok || closeError != null) deleteDocument(export.uri);
            if (ok && closeError != null) throw closeError;
            call.resolve();
        });
    }

    // Window

    @PluginMethod
    public void setWindowColors(PluginCall call) {
        int color;
        try {
            color = Color.parseColor(call.getString("background", ""));
        } catch (IllegalArgumentException e) {
            call.reject("Expected a colour such as #112233", "EINVAL");
            return;
        }
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        getBridge().executeOnMainThread(() -> {
            windowColor = color;
            windowDark = dark;
            applyWindowColors();
            call.resolve();
        });
    }

    @SuppressWarnings("deprecation")
    private void applyWindowColors() {
        Activity activity = getActivity();
        if (windowColor == null || activity == null) return;
        Window window = activity.getWindow();
        window.getDecorView().setBackgroundColor(windowColor);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            window.setStatusBarColor(windowColor);
            window.setNavigationBarColor(windowColor);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.setNavigationBarContrastEnforced(false);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(!windowDark);
        controller.setAppearanceLightNavigationBars(!windowDark);
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        // Capacitor's SystemBars restores the theme's colours on every configuration change; the app's go back after it.
        new Handler(Looper.getMainLooper()).post(this::applyWindowColors);
    }
}

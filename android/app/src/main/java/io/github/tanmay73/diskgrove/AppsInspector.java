package io.github.tanmay73.diskgrove;

import android.Manifest;
import android.app.AppOpsManager;
import android.app.usage.StorageStats;
import android.app.usage.StorageStatsManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.Environment;
import android.os.Process;
import android.os.StatFs;
import android.os.storage.StorageManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Installed apps, with the space Android's storage statistics charge to each one and when it was last
 * used. Other apps' figures need usage access, which only the user can grant in the system settings.
 */
final class AppsInspector {

    /** Android keeps usage statistics for about two years. */
    private static final long USAGE_WINDOW = 2L * 365 * 24 * 60 * 60 * 1000;
    private static final Pattern PACKAGE = Pattern.compile("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)*$");

    private AppsInspector() {}

    static boolean isPackageName(Object value) {
        return value instanceof String && ((String) value).length() <= 255 && PACKAGE.matcher((String) value).matches();
    }

    /** Whether the user allowed usage access, which also opens up other apps' storage statistics. */
    @SuppressWarnings("deprecation")
    static boolean hasUsageAccess(Context context) {
        AppOpsManager ops = context.getSystemService(AppOpsManager.class);
        if (ops == null) return false;
        int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.getPackageName())
            : ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.getPackageName());
        if (mode == AppOpsManager.MODE_DEFAULT) {
            return context.checkSelfPermission(Manifest.permission.PACKAGE_USAGE_STATS) == PackageManager.PERMISSION_GRANTED;
        }
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    static boolean isInstalled(Context context, String packageName) {
        try {
            context.getPackageManager().getApplicationInfo(packageName, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    /** The device's internal storage, as the physical size Settings shows rather than the data partition's. */
    static JSObject deviceSpace(Context context) {
        JSObject out = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            StorageStatsManager stats = context.getSystemService(StorageStatsManager.class);
            try {
                out.put("total", stats.getTotalBytes(StorageManager.UUID_DEFAULT));
                out.put("free", stats.getFreeBytes(StorageManager.UUID_DEFAULT));
                return out;
            } catch (IOException | RuntimeException ignored) {
                // The data partition's own figures below are close enough.
            }
        }
        StatFs fs = new StatFs(Environment.getDataDirectory().getAbsolutePath());
        out.put("total", fs.getTotalBytes());
        out.put("free", fs.getAvailableBytes());
        return out;
    }

    static JSObject list(Context context) {
        PackageManager pm = context.getPackageManager();
        boolean usage = hasUsageAccess(context);
        Map<String, UsageStats> used = usage ? lastUse(context) : null;
        StorageStatsManager stats = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? context.getSystemService(StorageStatsManager.class)
            : null;
        Set<String> launchable = launchable(pm);
        JSArray apps = new JSArray();
        for (ApplicationInfo info : installed(pm)) {
            apps.put(describe(context, pm, stats, info, used, launchable));
        }
        JSObject out = new JSObject();
        out.put("apps", apps);
        out.put("usageAccess", usage);
        return out;
    }

    /** One app, as `list` describes it, or null when it is no longer installed. */
    static JSObject one(Context context, String packageName) {
        PackageManager pm = context.getPackageManager();
        ApplicationInfo info;
        try {
            info = pm.getApplicationInfo(packageName, PackageManager.MATCH_DISABLED_COMPONENTS);
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
        boolean usage = hasUsageAccess(context);
        StorageStatsManager stats = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? context.getSystemService(StorageStatsManager.class)
            : null;
        return describe(context, pm, stats, info, usage ? lastUse(context) : null, launchable(pm));
    }

    @SuppressWarnings("deprecation")
    private static List<ApplicationInfo> installed(PackageManager pm) {
        return pm.getInstalledApplications(PackageManager.MATCH_DISABLED_COMPONENTS);
    }

    private static Set<String> launchable(PackageManager pm) {
        Set<String> packages = new HashSet<>();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        for (ResolveInfo info : pm.queryIntentActivities(launcher, 0)) {
            if (info.activityInfo != null) packages.add(info.activityInfo.packageName);
        }
        return packages;
    }

    private static Map<String, UsageStats> lastUse(Context context) {
        UsageStatsManager usage = context.getSystemService(UsageStatsManager.class);
        long now = System.currentTimeMillis();
        try {
            return usage.queryAndAggregateUsageStats(now - USAGE_WINDOW, now);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static long lastUsed(UsageStats stats) {
        long last = stats.getLastTimeUsed();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) last = Math.max(last, stats.getLastTimeVisible());
        // Packages that never ran report times near the epoch.
        return last > 365L * 24 * 60 * 60 * 1000 ? last : 0;
    }

    private static long apkBytes(ApplicationInfo info) {
        long total = 0;
        if (info.sourceDir != null) total += new File(info.sourceDir).length();
        if (info.splitSourceDirs != null) for (String split : info.splitSourceDirs) total += new File(split).length();
        return total;
    }

    @SuppressWarnings("deprecation")
    private static PackageInfo packageInfo(PackageManager pm, String packageName) {
        try {
            return pm.getPackageInfo(packageName, PackageManager.MATCH_DISABLED_COMPONENTS);
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
    }

    private static JSObject describe(
        Context context,
        PackageManager pm,
        StorageStatsManager stats,
        ApplicationInfo info,
        Map<String, UsageStats> used,
        Set<String> launchable
    ) {
        JSObject app = new JSObject();
        app.put("package", info.packageName);
        CharSequence label = info.loadLabel(pm);
        app.put("label", label != null ? label.toString() : info.packageName);
        PackageInfo pkg = packageInfo(pm, info.packageName);
        app.put("version", pkg != null && pkg.versionName != null ? pkg.versionName : "");
        app.put("installed", pkg != null ? pkg.firstInstallTime : 0);
        app.put("updated", pkg != null ? pkg.lastUpdateTime : 0);
        app.put("system", (info.flags & ApplicationInfo.FLAG_SYSTEM) != 0);
        app.put("updatedSystem", (info.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0);
        app.put("enabled", info.enabled);
        app.put("launchable", launchable.contains(info.packageName));
        app.put("self", info.packageName.equals(context.getPackageName()));
        app.put("apkBytes", apkBytes(info));

        if (stats != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                StorageStats s = stats.queryStatsForPackage(info.storageUuid, info.packageName, Process.myUserHandle());
                long cache = s.getCacheBytes();
                app.put("appBytes", s.getAppBytes());
                // Android counts the cache as part of an app's data; Settings shows the two apart.
                app.put("dataBytes", Math.max(0, s.getDataBytes() - cache));
                app.put("cacheBytes", cache);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) app.put("externalCacheBytes", s.getExternalCacheBytes());
            } catch (PackageManager.NameNotFoundException | IOException | SecurityException e) {
                // Without usage access only DiskGrove's own figures are available.
            }
        }

        UsageStats usage = used != null ? used.get(info.packageName) : null;
        if (used != null) app.put("lastUsed", usage != null ? lastUsed(usage) : 0);
        return app;
    }

    /** The app's launcher icon as a PNG, `size` pixels square. */
    static byte[] iconPng(Context context, String packageName, int size) throws PackageManager.NameNotFoundException {
        Drawable drawable = context.getPackageManager().getApplicationIcon(packageName);
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        try {
            Canvas canvas = new Canvas(bitmap);
            drawable.setBounds(0, 0, size, size);
            drawable.draw(canvas);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
            return out.toByteArray();
        } finally {
            bitmap.recycle();
        }
    }
}

package io.github.tanmay73.diskgrove;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.DocumentsContract;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;

/** Shared storage volumes, as filesystem paths the scanner can walk. */
final class StorageVolumes {

    private static final String EXTERNAL_STORAGE_AUTHORITY = "com.android.externalstorage.documents";

    private StorageVolumes() {}

    static File primary() {
        return Environment.getExternalStorageDirectory();
    }

    private static File directoryOf(StorageVolume volume) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return volume.getDirectory();
        if (volume.isPrimary()) return primary();
        String uuid = volume.getUuid();
        return uuid == null ? null : new File("/storage", uuid);
    }

    private static boolean mounted(StorageVolume volume) {
        String state = volume.getState();
        return Environment.MEDIA_MOUNTED.equals(state) || Environment.MEDIA_MOUNTED_READ_ONLY.equals(state);
    }

    static JSObject space(String path) {
        StatFs fs = new StatFs(path);
        JSObject result = new JSObject();
        result.put("total", fs.getTotalBytes());
        result.put("free", fs.getAvailableBytes());
        return result;
    }

    static JSArray list(Context context) {
        JSArray volumes = new JSArray();
        StorageManager manager = context.getSystemService(StorageManager.class);
        for (StorageVolume volume : manager.getStorageVolumes()) {
            File dir = directoryOf(volume);
            if (dir == null || !mounted(volume)) continue;
            JSObject entry = new JSObject();
            entry.put("path", dir.getAbsolutePath());
            entry.put("label", volume.getDescription(context));
            entry.put("primary", volume.isPrimary());
            entry.put("removable", volume.isRemovable());
            try {
                JSObject space = space(dir.getAbsolutePath());
                entry.put("total", space.getLong("total"));
                entry.put("free", space.getLong("free"));
            } catch (Exception e) {
                entry.put("total", 0);
                entry.put("free", 0);
            }
            volumes.put(entry);
        }
        return volumes;
    }

    /**
     * The filesystem path of a folder picked in the system's folder picker, or null when it is not a
     * folder on local shared storage (a cloud drive, say).
     */
    static String pathOfTree(Context context, Uri tree) {
        if (!EXTERNAL_STORAGE_AUTHORITY.equals(tree.getAuthority())) return null;
        String id = DocumentsContract.getTreeDocumentId(tree);
        int colon = id.indexOf(':');
        if (colon < 0) return null;
        String volumeId = id.substring(0, colon);
        String relative = id.substring(colon + 1);

        File root = null;
        if ("primary".equalsIgnoreCase(volumeId)) {
            root = primary();
        } else if ("home".equalsIgnoreCase(volumeId)) {
            root = new File(primary(), Environment.DIRECTORY_DOCUMENTS);
        } else {
            StorageManager manager = context.getSystemService(StorageManager.class);
            for (StorageVolume volume : manager.getStorageVolumes()) {
                if (volumeId.equalsIgnoreCase(volume.getUuid())) root = directoryOf(volume);
            }
        }
        if (root == null) return null;
        File folder = relative.isEmpty() ? root : new File(root, relative);
        return folder.getAbsolutePath();
    }
}

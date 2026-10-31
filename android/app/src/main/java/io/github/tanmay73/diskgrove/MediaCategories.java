package io.github.tanmay73.diskgrove;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.system.OsConstants;
import android.system.StructStat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Shared storage by kind of file, read from Android's media index instead of walking every folder. With
 * all files access the index lists every file in shared storage, not only photos, videos and music.
 */
final class MediaCategories {

    /** Every indexed file belongs to exactly one of these. */
    static final List<String> TYPES = Arrays.asList("images", "videos", "audio", "documents", "archives", "apks", "other");
    /** Groups that cut across the types above. */
    static final List<String> COLLECTIONS = Arrays.asList("downloads", "screenshots", "oldScreenshots", "large", "trash");

    static final long LARGE_FILE = 50L * 1024 * 1024;
    static final long OLD_SCREENSHOT = 30L * 24 * 60 * 60 * 1000;

    /** The MTP format of folders, which the index lists next to files. */
    private static final int FORMAT_FOLDER = 0x3001;

    private static final Set<String> DOCUMENTS = new HashSet<>(
        Arrays.asList(
            "pdf", "doc", "docx", "docm", "dot", "dotx", "xls", "xlsx", "xlsm", "ppt", "pptx", "pps", "ppsx", "odt",
            "ods", "odp", "odg", "rtf", "txt", "md", "csv", "tsv", "epub", "mobi", "azw", "azw3", "fb2", "djvu",
            "pages", "numbers", "key", "tex", "log"
        )
    );
    private static final Set<String> ARCHIVES = new HashSet<>(
        Arrays.asList("zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst", "lz", "lzma", "cab", "iso")
    );
    private static final Set<String> APKS = new HashSet<>(Arrays.asList("apk", "apks", "xapk", "apkm"));
    private static final Set<String> IMAGES = new HashSet<>(
        Arrays.asList("jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "bmp", "dng", "raw", "svg")
    );
    private static final Set<String> VIDEOS = new HashSet<>(
        Arrays.asList("mp4", "m4v", "mkv", "webm", "3gp", "3g2", "mov", "avi", "wmv", "flv", "ts", "mpg", "mpeg")
    );
    private static final Set<String> AUDIO = new HashSet<>(
        Arrays.asList("mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "wav", "amr", "awb", "mid", "midi", "wma")
    );

    // The Download and Screenshots folders of any volume: /storage/emulated/0/Download/, /storage/ABCD-1234/DCIM/Screenshots/…
    private static final Pattern DOWNLOAD = Pattern.compile("^/storage/[^/]+(/\\d+)?/Download/", Pattern.CASE_INSENSITIVE);
    private static final Pattern SCREENSHOT = Pattern.compile("/Screenshots/", Pattern.CASE_INSENSITIVE);

    private MediaCategories() {}

    static boolean isKind(Object value) {
        return value instanceof String && (TYPES.contains(value) || COLLECTIONS.contains(value));
    }

    static final class Item {

        final String path;
        final long size;
        final long modified;
        final String mime;
        final String type;

        Item(String path, long size, long modified, String mime, String type) {
            this.path = path;
            this.size = size;
            this.modified = modified;
            this.mime = mime;
            this.type = type;
        }

        String name() {
            return path.substring(path.lastIndexOf('/') + 1);
        }
    }

    private interface Visitor {
        void visit(Item item);
    }

    private static String extension(String path) {
        int slash = path.lastIndexOf('/');
        int dot = path.lastIndexOf('.');
        return dot > slash + 1 ? path.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
    }

    /** Which of TYPES a file belongs to, from what the index and its name say it is. */
    static String typeOf(int mediaType, String mime, String path) {
        String ext = extension(path);
        if (APKS.contains(ext) || "application/vnd.android.package-archive".equals(mime)) return "apks";
        if (mediaType == MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE) return "images";
        if (mediaType == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) return "videos";
        if (mediaType == MediaStore.Files.FileColumns.MEDIA_TYPE_AUDIO) return "audio";
        if (DOCUMENTS.contains(ext)) return "documents";
        if (ARCHIVES.contains(ext)) return "archives";
        if (IMAGES.contains(ext)) return "images";
        if (VIDEOS.contains(ext)) return "videos";
        if (AUDIO.contains(ext)) return "audio";
        if (mime != null) {
            if (mime.startsWith("image/")) return "images";
            if (mime.startsWith("video/")) return "videos";
            if (mime.startsWith("audio/")) return "audio";
            if (mime.startsWith("text/") || mime.equals("application/pdf")) return "documents";
        }
        return "other";
    }

    static boolean inCollection(String kind, Item item, long now) {
        switch (kind) {
            case "downloads":
                return DOWNLOAD.matcher(item.path).find();
            case "screenshots":
                return "images".equals(item.type) && SCREENSHOT.matcher(item.path).find();
            case "oldScreenshots":
                return (
                    "images".equals(item.type) &&
                    SCREENSHOT.matcher(item.path).find() &&
                    item.modified > 0 &&
                    now - item.modified > OLD_SCREENSHOT
                );
            case "large":
                return item.size >= LARGE_FILE;
            default:
                return false;
        }
    }

    private static Uri filesUri() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL)
            : MediaStore.Files.getContentUri("external");
    }

    @SuppressWarnings("deprecation")
    private static void forEach(Context context, boolean trashed, Visitor visitor) {
        // The trash only exists from Android 11.
        if (trashed && Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        ContentResolver resolver = context.getContentResolver();
        boolean withPending = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
        String[] projection = {
            MediaStore.MediaColumns.DATA,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.Files.FileColumns.MEDIA_TYPE,
            withPending ? MediaStore.MediaColumns.IS_PENDING : MediaStore.MediaColumns.SIZE
        };
        String selection = "format != " + FORMAT_FOLDER;
        Cursor cursor;
        if (withPending) {
            Bundle args = new Bundle();
            args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
            args.putInt(MediaStore.QUERY_ARG_MATCH_TRASHED, trashed ? MediaStore.MATCH_ONLY : MediaStore.MATCH_EXCLUDE);
            // Files saved by path, rather than through MediaStore, can wait here unscanned with no size or date.
            args.putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_INCLUDE);
            cursor = resolver.query(filesUri(), projection, args, null);
        } else {
            cursor = resolver.query(filesUri(), projection, selection, null, null);
        }
        if (cursor == null) return;
        try {
            while (cursor.moveToNext()) {
                String path = cursor.getString(0);
                if (path == null || !path.startsWith("/")) continue;
                boolean pending = withPending && cursor.getInt(5) != 0;
                long size = cursor.isNull(1) ? 0 : cursor.getLong(1);
                long modified = cursor.isNull(2) ? 0 : cursor.getLong(2) * 1000;
                if (pending || size <= 0 || modified <= 0) {
                    // An app is still writing a file it created through MediaStore.
                    if (pending && path.substring(path.lastIndexOf('/') + 1).startsWith(".pending-")) continue;
                    try {
                        StructStat stat = NativeFs.lstat(path);
                        if (!OsConstants.S_ISREG(stat.st_mode)) continue;
                        size = stat.st_size;
                        modified = stat.st_mtime * 1000;
                    } catch (NativeFs.FsException e) {
                        continue;
                    }
                }
                if (size <= 0) continue;
                String mime = cursor.getString(3);
                String type = typeOf(cursor.getInt(4), mime, path);
                visitor.visit(new Item(path, size, modified, mime, type));
            }
        } finally {
            cursor.close();
        }
    }

    private static final class Total {

        long count;
        long bytes;

        void add(Item item) {
            count++;
            bytes += item.size;
        }

        JSObject json() {
            JSObject out = new JSObject();
            out.put("count", count);
            out.put("bytes", bytes);
            return out;
        }
    }

    /** How many files, and how many bytes, of every type and collection. */
    static JSObject summary(Context context) {
        long now = System.currentTimeMillis();
        Map<String, Total> totals = new LinkedHashMap<>();
        for (String kind : TYPES) totals.put(kind, new Total());
        for (String kind : COLLECTIONS) totals.put(kind, new Total());
        forEach(context, false, (item) -> {
            totals.get(item.type).add(item);
            for (String kind : COLLECTIONS) if (inCollection(kind, item, now)) totals.get(kind).add(item);
        });
        Total trash = totals.get("trash");
        forEach(context, true, trash::add);
        JSObject out = new JSObject();
        for (Map.Entry<String, Total> entry : totals.entrySet()) out.put(entry.getKey(), entry.getValue().json());
        return out;
    }

    /** The largest `limit` files of a type or collection, with the count and size of all of them. */
    static JSObject files(Context context, String kind, int limit) {
        long now = System.currentTimeMillis();
        boolean type = TYPES.contains(kind);
        PriorityQueue<Item> largest = new PriorityQueue<>(Math.max(1, limit), (a, b) -> Long.compare(a.size, b.size));
        Total total = new Total();
        Visitor keep = (item) -> {
            total.add(item);
            largest.add(item);
            if (largest.size() > limit) largest.poll();
        };
        if ("trash".equals(kind)) {
            forEach(context, true, keep);
        } else {
            forEach(context, false, (item) -> {
                if (type ? kind.equals(item.type) : inCollection(kind, item, now)) keep.visit(item);
            });
        }
        List<Item> items = new ArrayList<>(largest);
        Collections.sort(items, (a, b) -> Long.compare(b.size, a.size));
        JSArray list = new JSArray();
        for (Item item : items) {
            JSObject file = new JSObject();
            file.put("path", item.path);
            file.put("name", item.name());
            file.put("size", item.size);
            file.put("modified", item.modified);
            file.put("mime", item.mime != null ? item.mime : "");
            file.put("type", item.type);
            list.put(file);
        }
        JSObject out = total.json();
        out.put("files", list);
        return out;
    }
}

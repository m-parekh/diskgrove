package io.github.tanmay73.diskgrove;

import android.os.Build;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileDescriptor;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.function.BooleanSupplier;

/** Filesystem work for the plugin, reporting failures by errno name as Node does on desktop. */
final class NativeFs {

    private static final int HASH_BUFFER = 64 * 1024;

    private NativeFs() {}

    /** A failure carrying its errno name (EACCES, ENOENT…), which reaches JavaScript as the error's code. */
    static final class FsException extends Exception {

        final String code;

        FsException(String code, String message) {
            super(message);
            this.code = code;
        }

        static FsException of(ErrnoException e, String path) {
            String code = errnoName(e);
            return new FsException(code, code + ": " + Os.strerror(e.errno) + ", '" + path + "'");
        }
    }

    static String errnoName(ErrnoException e) {
        String name = OsConstants.errnoName(e.errno);
        return name != null ? name : "EIO";
    }

    static String join(String dir, String name) {
        return dir.endsWith("/") ? dir + name : dir + "/" + name;
    }

    private static double millis(long seconds, long nanos) {
        return seconds * 1000.0 + nanos / 1_000_000.0;
    }

    /** The fields of NativeStats in native-api.ts. Android reports no birth time. */
    static JSObject stats(StructStat st) {
        JSObject o = new JSObject();
        o.put("dev", st.st_dev);
        o.put("ino", st.st_ino);
        o.put("mode", st.st_mode);
        o.put("size", st.st_size);
        o.put("blocks", st.st_blocks);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            o.put("mtimeMs", millis(st.st_mtim.tv_sec, st.st_mtim.tv_nsec));
            o.put("atimeMs", millis(st.st_atim.tv_sec, st.st_atim.tv_nsec));
            o.put("ctimeMs", millis(st.st_ctim.tv_sec, st.st_ctim.tv_nsec));
        } else {
            o.put("mtimeMs", millis(st.st_mtime, 0));
            o.put("atimeMs", millis(st.st_atime, 0));
            o.put("ctimeMs", millis(st.st_ctime, 0));
        }
        o.put("birthtimeMs", 0);
        return o;
    }

    static StructStat lstat(String path) throws FsException {
        try {
            return Os.lstat(path);
        } catch (ErrnoException e) {
            throw FsException.of(e, path);
        }
    }

    static StructStat stat(String path) throws FsException {
        try {
            return Os.stat(path);
        } catch (ErrnoException e) {
            throw FsException.of(e, path);
        }
    }

    /** Where `path` leads once every link in it is followed. */
    static String realPath(String path) throws FsException, IOException {
        // getCanonicalPath() keeps going past a missing or unreadable part, so stat reports those first.
        stat(path);
        return new File(path).getCanonicalPath();
    }

    /** The names in a folder, or the reason it cannot be listed. */
    static String[] list(String path) throws FsException {
        String[] names = new File(path).list();
        if (names != null) return names;
        try {
            StructStat st = Os.stat(path);
            if (!OsConstants.S_ISDIR(st.st_mode)) return fail("ENOTDIR", path);
            Os.access(path, OsConstants.R_OK | OsConstants.X_OK);
        } catch (ErrnoException e) {
            throw FsException.of(e, path);
        }
        return fail("EIO", path);
    }

    private static String[] fail(String code, String path) throws FsException {
        throw new FsException(code, code + ", '" + path + "'");
    }

    /** A folder's entries, each with its lstat, and with `follow` where links lead. */
    static JSObject listDir(String path, boolean follow) throws FsException, IOException {
        JSObject result = new JSObject();
        if (follow) result.put("realPath", realPath(path));
        JSArray entries = new JSArray();
        for (String name : list(path)) {
            String child = join(path, name);
            JSObject entry = new JSObject();
            entry.put("name", name);
            try {
                StructStat own = Os.lstat(child);
                entry.put("lstat", stats(own));
                // A broken link is reported as unreadable, as desktop does when it follows links.
                if (follow && OsConstants.S_ISLNK(own.st_mode)) entry.put("stat", stats(Os.stat(child)));
            } catch (ErrnoException e) {
                entry.put("error", errnoName(e));
            }
            entries.put(entry);
        }
        result.put("entries", entries);
        return result;
    }

    /** Deletes a file, link or whole folder tree. Links are removed themselves; nothing they lead to is touched. */
    static void removeTree(String path) throws FsException {
        StructStat st = lstat(path);
        if (OsConstants.S_ISDIR(st.st_mode)) {
            for (String name : list(path)) removeTree(join(path, name));
        }
        try {
            Os.remove(path);
        } catch (ErrnoException e) {
            throw FsException.of(e, path);
        }
    }

    /** Opens a regular file for reading; stat comes first, since opening a FIFO or device can block. */
    static FileDescriptor openRegular(String path) throws FsException {
        StructStat st = stat(path);
        if (!OsConstants.S_ISREG(st.st_mode)) throw new FsException("EINVAL", "Only regular files can be read");
        try {
            // OsConstants only has O_CLOEXEC from Android 8.1; the app starts no processes for an fd to leak into.
            int cloexec = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1 ? OsConstants.O_CLOEXEC : 0;
            FileDescriptor fd = Os.open(path, OsConstants.O_RDONLY | OsConstants.O_NONBLOCK | cloexec, 0);
            if (!OsConstants.S_ISREG(Os.fstat(fd).st_mode)) {
                close(fd);
                throw new FsException("EINVAL", "Only regular files can be read");
            }
            return fd;
        } catch (ErrnoException e) {
            throw FsException.of(e, path);
        }
    }

    static void close(FileDescriptor fd) {
        try {
            Os.close(fd);
        } catch (ErrnoException ignored) {
            // Nothing was written, so there is nothing to lose.
        }
    }

    static StructStat fstat(FileDescriptor fd, String path) throws FsException {
        try {
            return Os.fstat(fd);
        } catch (ErrnoException e) {
            throw FsException.of(e, path);
        }
    }

    /** Fills `buffer` from `position` until it is full or the file ends; returns the bytes read. */
    static int readAt(FileDescriptor fd, String path, byte[] buffer, int length, long position) throws FsException {
        int read = 0;
        try {
            while (read < length) {
                int n = Os.pread(fd, buffer, read, length - read, position + read);
                if (n <= 0) break;
                read += n;
            }
        } catch (ErrnoException e) {
            throw FsException.of(e, path);
        } catch (InterruptedIOException e) {
            throw new FsException("EINTR", "Reading was interrupted");
        }
        return read;
    }

    /**
     * SHA-256 of a whole file, or of its first `head` and last `tail` bytes, followed by its size as text.
     * It matches hashFile in src/main/scanner.ts byte for byte.
     */
    static JSObject hash(String path, long size, boolean full, int head, int tail, BooleanSupplier stopped)
        throws FsException {
        FileDescriptor fd = openRegular(path);
        try {
            StructStat before = fstat(fd, path);
            MessageDigest digest = sha256();
            byte[] buffer = new byte[HASH_BUFFER];
            if (full || size <= head) {
                digestRange(fd, path, digest, buffer, 0, size, stopped);
            } else {
                digestRange(fd, path, digest, buffer, 0, head, stopped);
                digestRange(fd, path, digest, buffer, Math.max(0, size - tail), size, stopped);
            }
            StructStat after = fstat(fd, path);
            digest.update(Long.toString(size).getBytes(StandardCharsets.UTF_8));
            JSObject result = new JSObject();
            result.put("hash", hex(digest.digest()));
            result.put("before", stats(before));
            result.put("after", stats(after));
            return result;
        } finally {
            close(fd);
        }
    }

    private static void digestRange(
        FileDescriptor fd,
        String path,
        MessageDigest digest,
        byte[] buffer,
        long start,
        long end,
        BooleanSupplier stopped
    ) throws FsException {
        long position = start;
        while (position < end) {
            if (stopped.getAsBoolean()) throw new FsException("ECANCELED", "Duplicate search stopped");
            int want = (int) Math.min(buffer.length, end - position);
            int read = readAt(fd, path, buffer, want, position);
            if (read == 0) throw new FsException("EIO", "File was truncated while hashing");
            digest.update(buffer, 0, read);
            position += read;
        }
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        return out.toString();
    }
}

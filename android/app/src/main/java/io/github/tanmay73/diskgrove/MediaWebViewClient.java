package io.github.tanmay73.diskgrove;

import android.net.Uri;
import android.system.OsConstants;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Streams scanned media files to the page's img, video and audio elements, with the byte ranges video
 * seeking asks for. It mirrors mediaResponse in src/main/preview.ts; the page asks for these files
 * through mediaUrl in src/android/api.ts.
 */
class MediaWebViewClient extends BridgeWebViewClient {

    /** MEDIA_PATH in src/android/api.ts. */
    static final String MEDIA_PATH = "/_diskgrove_media_";

    private static final Pattern RANGE = Pattern.compile("^bytes=(\\d*)-(\\d*)$");
    private static final int SNIFF_BYTES = 16;

    private final Bridge bridge;

    MediaWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if (
            MEDIA_PATH.equals(url.getPath()) &&
            bridge.getScheme().equals(url.getScheme()) &&
            bridge.getHost().equals(url.getHost())
        ) {
            return serve(request);
        }
        return super.shouldInterceptRequest(view, request);
    }

    private static boolean isMediaType(String type) {
        return type != null && (type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/"));
    }

    static WebResourceResponse serve(WebResourceRequest request) {
        if (!"GET".equalsIgnoreCase(request.getMethod())) return empty(405, "Method Not Allowed", null);
        Uri url = request.getUrl();
        String path = url.getQueryParameter("path");
        String declared = url.getQueryParameter("type");
        if (path == null || !path.startsWith("/")) return empty(404, "Not Found", null);
        if (!isMediaType(declared)) return empty(415, "Unsupported Media Type", null);

        RandomAccessFile file = null;
        try {
            // Checked before opening: opening a FIFO or device can block.
            if (!OsConstants.S_ISREG(NativeFs.stat(path).st_mode)) return empty(404, "Not Found", null);
            file = new RandomAccessFile(path, "r");
            long size = file.length();
            byte[] head = new byte[SNIFF_BYTES];
            int headLength = Math.max(0, file.read(head, 0, SNIFF_BYTES));
            String type = sniffMediaType(head, headLength, declared);

            long start = 0;
            long end = size - 1;
            boolean partial = false;
            String range = header(request, "Range");
            if (range != null) {
                Matcher match = RANGE.matcher(range.trim());
                if (!match.matches() || (match.group(1).isEmpty() && match.group(2).isEmpty())) {
                    file.close();
                    return unsatisfiable(size);
                }
                try {
                    if (match.group(1).isEmpty()) {
                        start = Math.max(0, size - Long.parseLong(match.group(2)));
                    } else {
                        start = Long.parseLong(match.group(1));
                        if (!match.group(2).isEmpty()) end = Math.min(Long.parseLong(match.group(2)), size - 1);
                    }
                } catch (NumberFormatException e) {
                    file.close();
                    return unsatisfiable(size);
                }
                if (start >= size || start > end) {
                    file.close();
                    return unsatisfiable(size);
                }
                partial = true;
            }

            Map<String, String> headers = baseHeaders();
            if (size == 0) {
                file.close();
                headers.put("Content-Length", "0");
                return new WebResourceResponse(type, null, 200, "OK", headers, new ByteArrayInputStream(new byte[0]));
            }
            long length = end - start + 1;
            headers.put("Content-Length", Long.toString(length));
            if (partial) headers.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
            file.seek(start);
            InputStream body = new RangeStream(file, length);
            return partial
                ? new WebResourceResponse(type, null, 206, "Partial Content", headers, body)
                : new WebResourceResponse(type, null, 200, "OK", headers, body);
        } catch (Exception e) {
            if (file != null) {
                try {
                    file.close();
                } catch (IOException ignored) {
                    // The response below says the file could not be served.
                }
            }
            return empty(404, "Not Found", null);
        }
    }

    private static String header(WebResourceRequest request, String name) {
        Map<String, String> headers = request.getRequestHeaders();
        if (headers == null) return null;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (name.equalsIgnoreCase(entry.getKey())) return entry.getValue();
        }
        return null;
    }

    private static Map<String, String> baseHeaders() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept-Ranges", "bytes");
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
        return headers;
    }

    private static WebResourceResponse unsatisfiable(long size) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Range", "bytes */" + size);
        return empty(416, "Range Not Satisfiable", headers);
    }

    private static WebResourceResponse empty(int status, String reason, Map<String, String> extra) {
        Map<String, String> headers = baseHeaders();
        headers.put("Content-Length", "0");
        if (extra != null) headers.putAll(extra);
        return new WebResourceResponse("text/plain", null, status, reason, headers, new ByteArrayInputStream(new byte[0]));
    }

    private static boolean ascii(byte[] bytes, int length, int start, String text) {
        if (start + text.length() > length) return false;
        byte[] expected = text.getBytes(StandardCharsets.US_ASCII);
        for (int i = 0; i < expected.length; i++) if (bytes[start + i] != expected[i]) return false;
        return true;
    }

    private static int at(byte[] bytes, int length, int index) {
        return index < length ? bytes[index] & 0xff : -1;
    }

    /**
     * The container a media file really holds, read from its first bytes, within the audio or video
     * family of its extension's type. A port of sniffMediaType in src/shared/preview.ts.
     */
    static String sniffMediaType(byte[] head, int length, String fallback) {
        String family = fallback.startsWith("video/") ? "video" : fallback.startsWith("audio/") ? "audio" : null;
        if (family == null) return fallback;
        if (ascii(head, length, 4, "ftyp")) return family + "/mp4";
        if (ascii(head, length, 0, "OggS")) return family + "/ogg";
        if (at(head, length, 0) == 0x1a && at(head, length, 1) == 0x45 && at(head, length, 2) == 0xdf && at(head, length, 3) == 0xa3) {
            return family + "/webm";
        }
        if (ascii(head, length, 0, "RIFF") && ascii(head, length, 8, "WAVE")) return "audio/wav";
        if (ascii(head, length, 0, "fLaC")) return "audio/flac";
        if (ascii(head, length, 0, "ID3")) return "audio/mpeg";
        int b0 = at(head, length, 0);
        int b1 = at(head, length, 1);
        if (b0 == 0xff && b1 >= 0 && (b1 & 0xf0) == 0xf0 && (b1 & 0x06) == 0) return "audio/aac";
        if (b0 == 0xff && b1 >= 0 && (b1 & 0xe0) == 0xe0) return "audio/mpeg";
        return fallback;
    }

    /** Reads `remaining` bytes from the file's current position, then closes it with the stream. */
    private static final class RangeStream extends InputStream {

        private final RandomAccessFile file;
        private long remaining;

        RangeStream(RandomAccessFile file, long remaining) {
            this.file = file;
            this.remaining = remaining;
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0) return -1;
            int b = file.read();
            if (b >= 0) remaining--;
            return b;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (remaining <= 0) return -1;
            int n = file.read(buffer, offset, (int) Math.min(length, remaining));
            if (n > 0) remaining -= n;
            return n;
        }

        @Override
        public int available() {
            return (int) Math.min(Integer.MAX_VALUE, remaining);
        }

        @Override
        public void close() throws IOException {
            file.close();
        }
    }
}

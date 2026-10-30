package io.github.tanmay73.diskgrove;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.matcher.ViewMatchers.withId;
import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.util.Base64;
import android.view.inspector.WindowInspector;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
@SdkSuppress(minSdkVersion = 30)
public class NativeIntegrationTest {

    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private ActivityScenario<MainActivity> scenario;
    private File fixture;
    private long fixtureBytes;

    @Before
    public void setUp() throws Exception {
        Context context = instrumentation.getTargetContext();
        assertEquals("Tests must exercise the release APK", 0,
            context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE);
        storageAccess("allow");
        assertTrue("All files access was not granted", Environment.isExternalStorageManager());

        fixture = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "DiskGrove-smoke-" + UUID.randomUUID());
        assertTrue(fixture.mkdirs());
        assertTrue(new File(fixture, "nested").mkdir());
        assertTrue(new File(fixture, "empty-dir").mkdir());
        write("notes.txt", "hello world".getBytes(StandardCharsets.UTF_8));
        write("nested/copy.txt", "hello world".getBytes(StandardCharsets.UTF_8));
        write("different.txt", "hello there".getBytes(StandardCharsets.UTF_8));
        write("empty.txt", new byte[0]);
        write(".hidden", "hidden".getBytes(StandardCharsets.UTF_8));
        write("pixel.png", Base64.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
            Base64.DEFAULT));
        byte[] large = new byte[4 * 1024 * 1024];
        Arrays.fill(large, (byte) 42);
        write("large.bin", large);
        write("nested/large-copy.bin", large);
        large[large.length / 2] = 43;
        write("sample-collision.bin", large);
        scenario = ActivityScenario.launch(MainActivity.class);
        waitFor("window.diskgrove && document.body.innerText.includes('Where did my disk space go?')");
    }

    @After
    public void tearDown() throws Exception {
        try {
            if (scenario != null) {
                try {
                    if (fixture != null) {
                        String root = JSONObject.quote(fixture.getAbsolutePath());
                        runScript("await window.diskgrove.setSettings({recents: " +
                            "(await window.diskgrove.getSettings()).recents.filter(r => " +
                            "r.path !== " + root + " && !r.path.startsWith(" + root + " + '/'))});");
                    }
                } finally {
                    scenario.close();
                }
            }
        } finally {
            storageAccess("allow");
            if (fixture != null) removeFixture(fixture);
        }
    }

    @Test
    public void nativeFilesystemRoundTrip() throws Exception {
        JSONObject data = new JSONObject()
            .put("root", fixture.getAbsolutePath())
            .put("files", 9)
            .put("bytes", fixtureBytes);
        String script;
        try (InputStream input = instrumentation.getContext().getAssets().open("native-smoke.js")) {
            script = new String(readAll(input), StandardCharsets.UTF_8);
        }
        JSONObject result = runScript("const fixture = " + data + ";\n" + script);
        assertEquals(9, result.getJSONObject("value").getInt("files"));
        assertEquals(2, result.getJSONObject("value").getInt("duplicateGroups"));
    }

    @Test
    public void mediaByteRangesReadRealFiles() throws Exception {
        WebResourceResponse partial = MediaWebViewClient.serve(mediaRequest("bytes=0-7"));
        assertEquals(206, partial.getStatusCode());
        assertEquals("bytes 0-7/" + new File(fixture, "pixel.png").length(),
            partial.getResponseHeaders().get("Content-Range"));
        try (InputStream input = partial.getData()) {
            assertArrayEquals(new byte[] {(byte) 137, 80, 78, 71, 13, 10, 26, 10}, readAll(input));
        }
        WebResourceResponse invalid = MediaWebViewClient.serve(mediaRequest("bytes=9999-"));
        assertEquals(416, invalid.getStatusCode());
        try (InputStream input = invalid.getData()) {
            assertEquals(0, readAll(input).length);
        }
    }

    @Test
    public void deletionRequiresNativeConfirmation() throws Exception {
        String root = JSONObject.quote(fixture.getAbsolutePath());
        String target = JSONObject.quote(new File(fixture, "notes.txt").getAbsolutePath());
        runScript("await window.diskgrove.startScan(" + root + ", {followLinks:false, skipHidden:false});");

        beginScript("return await window.diskgrove.deleteItems([" + target + "], 'permanent');");
        waitForDialog(android.R.id.button2);
        onView(withId(android.R.id.button2)).perform(click());
        assertEquals(0, awaitResult().getJSONObject("value").getJSONArray("deleted").length());
        assertTrue(new File(fixture, "notes.txt").isFile());

        beginScript("return await window.diskgrove.deleteItems([" + target + "], 'permanent');");
        waitForDialog(android.R.id.button1);
        screenshot("delete-confirmation.png");
        onView(withId(android.R.id.button1)).perform(click());
        JSONObject deleted = awaitResult().getJSONObject("value");
        assertEquals(1, deleted.getJSONArray("deleted").length());
        assertEquals(0, deleted.getJSONArray("failed").length());
        assertFalse(new File(fixture, "notes.txt").exists());
        assertEquals(JSONObject.NULL,
            runScript("return await window.diskgrove.getNode(" + target + ");").get("value"));
    }

    @Test
    public void responsiveUiScansRealFiles() throws Exception {
        String root = JSONObject.quote(fixture.getAbsolutePath());
        runScript("await window.diskgrove.setSettings({recents:[{path:" + root +
            ", scannedAt:Date.now(), size:0, files:0}]});");
        scenario.recreate();
        waitFor("window.diskgrove && [...document.querySelectorAll('button')].some(b => b.textContent.includes(" + root + "))");
        runScript("window.__scanComplete = null; window.diskgrove.onComplete(r => window.__scanComplete = r);" +
            "[...document.querySelectorAll('button')].find(b => b.textContent.includes(" + root + ")).click();");
        waitFor("window.__scanComplete && document.body.innerText.includes('notes.txt')");
        JSONObject totals = (JSONObject) evaluate("window.__scanComplete");
        assertEquals(9, totals.getInt("files"));
        assertEquals(fixtureBytes, totals.getLong("bytes"));
        assertEquals(0, totals.getInt("unreadable"));
        assertEquals(Boolean.TRUE, evaluate("document.documentElement.scrollWidth <= window.innerWidth"));
        assertEquals(Boolean.TRUE, evaluate("['Folders','Preview'].every(label => " +
            "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === label))"));
        screenshot("scan.png");
    }

    private void write(String name, byte[] bytes) throws Exception {
        Files.write(new File(fixture, name).toPath(), bytes);
        fixtureBytes += bytes.length;
    }

    private WebResourceRequest mediaRequest(String range) {
        Uri url = Uri.parse("https://localhost" + MediaWebViewClient.MEDIA_PATH).buildUpon()
            .appendQueryParameter("path", new File(fixture, "pixel.png").getAbsolutePath())
            .appendQueryParameter("type", "image/png").build();
        return new WebResourceRequest() {
            @Override public Uri getUrl() { return url; }
            @Override public boolean isForMainFrame() { return false; }
            @Override public boolean isRedirect() { return false; }
            @Override public boolean hasGesture() { return false; }
            @Override public String getMethod() { return "GET"; }
            @Override public Map<String, String> getRequestHeaders() { return Map.of("Range", range); }
        };
    }

    private void storageAccess(String mode) throws Exception {
        String command = "appops set " + instrumentation.getTargetContext().getPackageName() +
            " MANAGE_EXTERNAL_STORAGE " + mode;
        try (ParcelFileDescriptor fd = instrumentation.getUiAutomation().executeShellCommand(command);
             InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(fd)) {
            assertEquals(command, "", new String(readAll(input), StandardCharsets.UTF_8).trim());
        }
    }

    private byte[] readAll(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int length;
        while ((length = input.read(buffer)) != -1) output.write(buffer, 0, length);
        return output.toByteArray();
    }

    private Object evaluate(String expression) throws Exception {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(
            "(" + expression + ")", value -> {
                result.set(value);
                completed.countDown();
            }));
        assertTrue("WebView evaluation timed out: " + expression, completed.await(10, TimeUnit.SECONDS));
        return new JSONTokener(result.get()).nextValue();
    }

    private void waitFor(String expression) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 30000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (Boolean.TRUE.equals(evaluate("Boolean(" + expression + ")"))) return;
            SystemClock.sleep(100);
        }
        fail("Timed out waiting for: " + expression + "\nPage: " + evaluate("document.body.innerText"));
    }

    private void beginScript(String body) throws Exception {
        evaluate("window.__nativeSmokeResult = null");
        evaluate("(async () => {" + body + "})().then(" +
            "value => window.__nativeSmokeResult = {ok:true, value:value ?? null}," +
            "error => window.__nativeSmokeResult = {ok:false, error:String(error.stack || error)})");
    }

    private JSONObject awaitResult() throws Exception {
        waitFor("window.__nativeSmokeResult");
        JSONObject result = (JSONObject) evaluate("window.__nativeSmokeResult");
        assertTrue(result.optString("error"), result.getBoolean("ok"));
        return result;
    }

    private JSONObject runScript(String body) throws Exception {
        beginScript(body);
        return awaitResult();
    }

    private void waitForDialog(int buttonId) {
        long deadline = SystemClock.elapsedRealtime() + 10000;
        AtomicBoolean visible = new AtomicBoolean();
        while (SystemClock.elapsedRealtime() < deadline) {
            instrumentation.runOnMainSync(() -> visible.set(WindowInspector.getGlobalWindowViews().stream()
                .anyMatch(view -> view.findViewById(buttonId) != null && view.findViewById(buttonId).isShown())));
            if (visible.get()) return;
            SystemClock.sleep(100);
        }
        fail("Native confirmation dialog did not appear");
    }

    private void screenshot(String name) throws Exception {
        String outputPath = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir");
        assertNotNull("Run through Gradle to retain screenshots", outputPath);
        File directory = new File(outputPath);
        assertTrue(directory.isDirectory() || directory.mkdirs());
        instrumentation.waitForIdleSync();
        instrumentation.getUiAutomation().waitForIdle(500, 5000);
        Bitmap image = instrumentation.getUiAutomation().takeScreenshot();
        assertNotNull("Could not capture screenshot", image);
        try (FileOutputStream output = new FileOutputStream(new File(directory, name))) {
            assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally {
            image.recycle();
        }
    }

    private void removeFixture(File file) throws Exception {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            assertNotNull("Cannot list test fixture: " + file, children);
            for (File child : children) removeFixture(child);
        }
        Files.delete(file.toPath());
    }
}

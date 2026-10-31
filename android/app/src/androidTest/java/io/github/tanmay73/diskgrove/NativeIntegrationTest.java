package io.github.tanmay73.diskgrove;

import static org.junit.Assert.*;

import android.app.Instrumentation;
import android.accessibilityservice.AccessibilityService;
import android.app.usage.StorageStats;
import android.app.usage.StorageStatsManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.os.Process;
import android.os.SystemClock;
import android.util.Base64;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.inspector.WindowInspector;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.test.core.app.ActivityScenario;
import androidx.lifecycle.Lifecycle;
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
import java.util.Locale;
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
        appOp("MANAGE_EXTERNAL_STORAGE", "allow");
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
        openHome();
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
            appOp("MANAGE_EXTERNAL_STORAGE", "allow");
            appOp("GET_USAGE_STATS", "default");
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
        clickDialogButton(android.R.id.button2);
        assertEquals(0, awaitResult().getJSONObject("value").getJSONArray("deleted").length());
        waitForDialogGone(android.R.id.button2);
        assertTrue(new File(fixture, "notes.txt").isFile());

        beginScript("return await window.diskgrove.deleteItems([" + target + "], 'permanent');");
        waitForDialog(android.R.id.button1);
        screenshot("delete-confirmation.png");
        clickDialogButton(android.R.id.button1);
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
        openHome();
        waitFor("[...document.querySelectorAll('button')].some(b => b.textContent.includes(" + root + "))");
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

        // Back at the scan root returns to the home screen rather than leaving the app.
        scenario.onActivity(a -> a.getOnBackPressedDispatcher().onBackPressed());
        waitFor("/Analyze folders/i.test(document.body.innerText) && !document.body.innerText.includes('notes.txt')");
        scenario.onActivity(a -> assertFalse(a.isFinishing()));
    }

    @Test
    public void androidFeaturesReadTheDevice() throws Exception {
        appOp("GET_USAGE_STATS", "allow");
        File photo = new File(fixture, "photo.png");
        Bitmap bitmap = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.rgb(46, 125, 50));
        try (FileOutputStream output = new FileOutputStream(photo)) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally {
            bitmap.recycle();
        }
        JSONObject data = new JSONObject()
            .put("root", fixture.getAbsolutePath())
            .put("pkg", instrumentation.getTargetContext().getPackageName())
            .put("photoBytes", photo.length());
        String script;
        try (InputStream input = instrumentation.getContext().getAssets().open("android-features.js")) {
            script = new String(readAll(input), StandardCharsets.UTF_8);
        }
        JSONObject value = runScript("const fixture = " + data + ";\n" + script).getJSONObject("value");
        assertTrue(value.toString(), value.getInt("apps") > value.getInt("sized"));
        assertTrue(value.toString(), value.getInt("images") >= 1);
    }

    @Test
    public void mediaDeletionUpdatesTheMediaIndex() throws Exception {
        File notes = new File(fixture, "notes.txt");
        String target = JSONObject.quote(notes.getAbsolutePath());
        String listed = "(await window.diskgrove.android.mediaFiles('downloads', 2000)).files" +
            ".some(f => f.path === " + target + ")";
        runScript("for (let i = 0; i < 100 && !" + listed + "; i++) await new Promise(r => setTimeout(r, 200));" +
            "if (!" + listed + ") throw new Error('MediaStore did not index the fixture');");

        beginScript("return await window.diskgrove.android.deleteMediaFiles([" + target + "]);");
        waitForDialog(android.R.id.button2);
        clickDialogButton(android.R.id.button2);
        assertEquals(0, awaitResult().getJSONObject("value").getJSONArray("deleted").length());
        waitForDialogGone(android.R.id.button2);
        assertTrue(notes.isFile());

        beginScript("return await window.diskgrove.android.deleteMediaFiles([" + target + "]);");
        waitForDialog(android.R.id.button1);
        clickDialogButton(android.R.id.button1);
        JSONObject deleted = awaitResult().getJSONObject("value");
        assertEquals(1, deleted.getJSONArray("deleted").length());
        assertEquals(0, deleted.getJSONArray("failed").length());
        assertFalse(notes.exists());
        assertEquals(Boolean.FALSE, runScript("return " + listed + ";").get("value"));
    }

    @Test
    public void onboardingLeadsToTheAndroidHome() throws Exception {
        appOp("GET_USAGE_STATS", "allow");
        runScript("localStorage.removeItem('diskgrove:access-onboarded');");
        scenario.recreate();
        waitFor("window.diskgrove && document.body.innerText.includes('Let DiskGrove see your storage')");
        assertEquals(Boolean.TRUE, evaluate("['All files access', 'Usage access', 'See installed apps']" +
            ".every(text => document.body.innerText.includes(text))"));
        assertNoOverflow();
        screenshot("onboarding.png");
        clickButton("Continue");
        waitFor("/Analyze folders/i.test(document.body.innerText) && document.body.innerText.includes('Images')");
        assertNoOverflow();
        screenshot("home-storage.png");

        clickTab("Apps");
        waitFor("[...document.querySelectorAll('img')].some(i => i.src.includes('_diskgrove_icon_') && i.naturalWidth > 0)" +
            " && document.body.innerText.includes('DiskGrove')");
        assertNoOverflow();
        screenshot("home-apps.png");

        clickTab("Clean");
        waitFor("document.body.innerText.includes('Duplicate files')");
        assertNoOverflow();
        screenshot("home-clean.png");

        scenario.recreate();
        waitFor("window.diskgrove && /Analyze folders/i.test(document.body.innerText)");
        assertEquals(Boolean.FALSE, evaluate("document.body.innerText.includes('Let DiskGrove see your storage')"));
    }

    @Test
    public void appsScreenGrantsUsageAccessAndShowsSystemSizes() throws Exception {
        appOp("GET_USAGE_STATS", "default");
        scenario.recreate();
        openHome();
        clickTab("Apps");
        waitFor("document.body.innerText.includes('See data and cache sizes')");
        assertEquals(Boolean.TRUE, evaluate(
            "[...document.querySelectorAll('[role=tab]')].find(e => e.textContent === 'Unused').disabled"));
        screenshot("apps-limited-access.png");

        clickButton("Allow usage access");
        waitForSystemPackage("com.android.settings");
        AccessibilityNodeInfo toggle = null;
        long deadline = SystemClock.elapsedRealtime() + 10000;
        while (toggle == null && SystemClock.elapsedRealtime() < deadline) {
            toggle = findSwitch(instrumentation.getUiAutomation().getRootInActiveWindow());
            if (toggle == null) SystemClock.sleep(100);
        }
        assertNotNull("Usage access setting has no switch", toggle);
        assertFalse("Usage access should initially be off", toggle.isChecked());
        AccessibilityNodeInfo control = toggle;
        while (control != null && !control.isClickable()) control = control.getParent();
        assertNotNull("Usage access switch has no clickable control", control);
        assertTrue("Could not toggle usage access", control.performAction(AccessibilityNodeInfo.ACTION_CLICK));
        screenshot("usage-access-setting.png");
        assertTrue("Android did not grant usage access",
            AppsInspector.hasUsageAccess(instrumentation.getTargetContext()));
        systemBack();
        waitFor("!document.body.innerText.includes('See data and cache sizes')" +
            " && [...document.querySelectorAll('[role=tab]')].some(e => e.textContent === 'Unused' && !e.disabled)");

        evaluate("[...document.querySelectorAll('[role=tab]')].find(e => e.textContent === 'All').click()");
        String pkg = "com.android.settings";
        String row = "[...document.querySelectorAll('button')].find(b => " +
            "b.querySelector('img')?.src.includes('package=" + pkg + "'))";
        waitFor(row);
        evaluate(row + ".click()");
        waitFor("document.querySelector('[role=dialog]')?.textContent.includes('" + pkg + "')");

        Context context = instrumentation.getTargetContext();
        ApplicationInfo info = context.getPackageManager().getApplicationInfo(pkg, 0);
        StorageStats stats = context.getSystemService(StorageStatsManager.class)
            .queryStatsForPackage(info.storageUuid, pkg, Process.myUserHandle());
        JSONObject expected = new JSONObject()
            .put("App", stats.getAppBytes())
            .put("Data", Math.max(0, stats.getDataBytes() - stats.getCacheBytes()))
            .put("Cache", stats.getCacheBytes())
            .put("Total", stats.getAppBytes() + stats.getDataBytes());
        JSONObject shown = (JSONObject) evaluate("Object.fromEntries(" +
            "[...document.querySelectorAll('[role=dialog] .tabular')]" +
            ".map(e => [e.previousElementSibling.textContent, e.textContent]))");
        assertTrue("System app has no measured code", expected.getLong("App") > 0);
        assertTrue("System app has no measured data", expected.getLong("Data") > 0);
        for (String label : new String[] {"App", "Data", "Cache", "Total"}) {
            assertEquals(label + " does not match Android StorageStats", formatBytes(expected.getLong(label)),
                shown.getString(label));
        }
        assertNoOverflow();
        screenshot("apps-system-sizes.png");
        writeEvidence("apps-ui.json", new JSONObject().put("package", pkg)
            .put("androidStorageStatsBytes", expected).put("displayedSizes", shown)
            .put("usageAccessGrantedThroughSettings", true));

        clickButton("App info");
        waitForSystemPackage("com.android.settings");
        screenshot("apps-system-app-info.png");
        systemBack();
        waitFor("[...document.querySelectorAll('[role=dialog] button')]" +
            ".some(b => b.textContent.trim() === 'App info' && !b.disabled)");
        assertEquals(Boolean.TRUE, evaluate("document.querySelector('[role=dialog]').textContent.includes('" + pkg + "')"));
    }

    @Test
    public void storageScreenListsDeletesAndRefreshesRealPhotos() throws Exception {
        File photo = createIndexedPhoto("gallery-" + UUID.randomUUID() + ".png");
        clickTab("Storage");
        evaluate("document.querySelector('button[aria-label=\"Refresh storage\"]').click()");
        waitFor("[...document.querySelectorAll('button')].some(b => " +
            "b.textContent.trim().startsWith('Images') && !b.disabled)");
        screenshot("storage-categories.png");
        clickButton("Images");
        String name = JSONObject.quote(photo.getName());
        String row = "[...document.querySelectorAll('li')].find(e => e.textContent.includes(" + name + "))";
        waitFor(row + "?.querySelector('img')?.naturalWidth > 0");
        assertEquals(formatBytes(photo.length()), evaluate(row + ".querySelector('.tabular').textContent"));
        int before = ((Number) evaluate("document.querySelectorAll('li').length")).intValue();
        long bytes = photo.length();
        assertNoOverflow();
        screenshot("storage-photo-list.png");

        String selection = "document.querySelector('[aria-label=\"Select " + photo.getName() + "\"]')";
        evaluate(selection + ".click()");
        waitFor(selection + ".getAttribute('aria-checked') === 'true'");
        scenario.onActivity(a -> a.getOnBackPressedDispatcher().onBackPressed());
        waitFor(selection + ".getAttribute('aria-checked') === 'false'");
        assertEquals("Images", evaluate("document.querySelector('h1').textContent"));

        evaluate(selection + ".click()");
        clickButton("Delete");
        waitForDialog(android.R.id.button2);
        clickDialogButton(android.R.id.button2);
        waitForDialogGone(android.R.id.button2);
        assertTrue("Cancel removed the photo", photo.exists());
        assertEquals(Boolean.TRUE, evaluate("Boolean(" + row + ")"));

        clickButton("Delete");
        waitForDialog(android.R.id.button1);
        screenshot("storage-delete-confirmation.png");
        clickDialogButton(android.R.id.button1);
        waitForDialogGone(android.R.id.button1);
        waitFor("!(" + row + ")");
        assertFalse("Confirmed delete left the real file behind", photo.exists());
        int after = ((Number) evaluate("document.querySelectorAll('li').length")).intValue();
        assertEquals("Deleted item did not disappear from the list", before - 1, after);
        assertEquals(Boolean.FALSE, runScript("return (await window.diskgrove.android.mediaFiles('images', 2000))" +
            ".files.some(f => f.path === " + JSONObject.quote(photo.getAbsolutePath()) + ");").get("value"));

        // Simulate another app adding a photo while DiskGrove is in the background.
        scenario.moveToState(Lifecycle.State.CREATED);
        File added = createIndexedPhoto("new-photo-" + UUID.randomUUID() + ".png");
        scenario.moveToState(Lifecycle.State.RESUMED);
        waitFor("document.body.innerText.includes(" + JSONObject.quote(added.getName()) + ")");
        screenshot("storage-refreshed.png");
        writeEvidence("storage-ui.json", new JSONObject().put("fixtureBytes", bytes)
            .put("rowsBeforeDeletion", before).put("rowsAfterDeletion", after)
            .put("cancelKeptFile", true).put("confirmedDeleteRemovedFileAndMediaRow", true)
            .put("backgroundPhotoAppearedOnResume", true));
        evaluate("document.querySelector('button[aria-label=\"Back\"]').click()");
        waitFor("/Analyze folders/i.test(document.body.innerText)");
    }

    private File createIndexedPhoto(String name) throws Exception {
        File photo = new File(fixture, name);
        Bitmap bitmap = Bitmap.createBitmap(640, 480, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.rgb(46, 125, 50));
        try (FileOutputStream output = new FileOutputStream(photo)) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally {
            bitmap.recycle();
        }
        CountDownLatch indexed = new CountDownLatch(1);
        AtomicReference<Uri> uri = new AtomicReference<>();
        MediaScannerConnection.scanFile(instrumentation.getTargetContext(), new String[] {photo.getAbsolutePath()},
            new String[] {"image/png"}, (path, result) -> {
                uri.set(result);
                indexed.countDown();
            });
        assertTrue("Photo was not indexed", indexed.await(20, TimeUnit.SECONDS));
        assertNotNull("MediaStore did not accept the photo", uri.get());
        return photo;
    }

    private void waitForSystemPackage(String pkg) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 15000;
        String observed = "no accessibility root";
        while (SystemClock.elapsedRealtime() < deadline) {
            AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
            if (root != null) {
                observed = root.toString();
                if (pkg.contentEquals(root.getPackageName())) return;
            }
            SystemClock.sleep(100);
        }
        screenshot("unexpected-system-screen.png");
        fail("Android did not open " + pkg + ": " + observed);
    }

    private AccessibilityNodeInfo findSwitch(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isCheckable() && node.getClassName().toString().endsWith("Switch")) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = findSwitch(node.getChild(i));
            if (found != null) return found;
        }
        return null;
    }

    private void systemBack() {
        assertTrue("System Back failed",
            instrumentation.getUiAutomation().performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK));
    }

    private String formatBytes(long bytes) {
        if (bytes == 0) return "0 B";
        String[] units = {"B", "KB", "MB", "GB", "TB"};
        int unit = Math.min((int) (Math.log(bytes) / Math.log(1024)), units.length - 1);
        double value = bytes / Math.pow(1024, unit);
        int digits = unit == 0 ? 0 : value >= 100 ? 1 : 2;
        return String.format(Locale.US, "%." + digits + "f %s", value, units[unit]);
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

    private void appOp(String op, String mode) throws Exception {
        String command = "appops set " + instrumentation.getTargetContext().getPackageName() + " " + op + " " + mode;
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

    /** Waits for the Android home, going past the access screen shown on first launch. */
    private void openHome() throws Exception {
        waitFor("window.diskgrove && /Let DiskGrove see your storage|Analyze folders/i.test(document.body.innerText)");
        if (Boolean.TRUE.equals(evaluate("document.body.innerText.includes('Let DiskGrove see your storage')"))) {
            clickButton("Continue");
        }
        waitFor("/Analyze folders/i.test(document.body.innerText)");
    }

    private void clickButton(String label) throws Exception {
        String quoted = JSONObject.quote(label);
        waitFor("[...document.querySelectorAll('button')].some(b => b.textContent.trim().startsWith(" + quoted + "))");
        evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(" + quoted +
            ")).click()");
    }

    private void clickTab(String label) throws Exception {
        String button = "[...document.querySelectorAll('nav[aria-label=\"Home\"] button')]" +
            ".find(b => b.textContent.trim() === " + JSONObject.quote(label) + ")";
        waitFor(button);
        evaluate(button + ".click()");
        waitFor(button + ".getAttribute('aria-current') === 'page'");
    }

    private void assertNoOverflow() throws Exception {
        assertEquals("Page is wider than the screen", Boolean.TRUE,
            evaluate("document.documentElement.scrollWidth <= window.innerWidth"));
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
        if (!awaitDialog(buttonId, true)) fail("Native confirmation dialog did not appear");
    }

    /** Presses the button itself: a touch can miss while the dialog is still animating in. */
    private void clickDialogButton(int buttonId) {
        AtomicBoolean clicked = new AtomicBoolean();
        instrumentation.runOnMainSync(() -> WindowInspector.getGlobalWindowViews().stream()
            .<View>map(view -> view.findViewById(buttonId))
            .filter(button -> button != null && button.isShown())
            .findFirst()
            .ifPresent(button -> clicked.set(button.performClick())));
        assertTrue("Could not press the dialog button", clicked.get());
    }

    /** A dismissed dialog stays in the window list while it animates away. */
    private void waitForDialogGone(int buttonId) {
        if (!awaitDialog(buttonId, false)) fail("Native confirmation dialog did not close");
    }

    private boolean awaitDialog(int buttonId, boolean shown) {
        long deadline = SystemClock.elapsedRealtime() + 10000;
        AtomicBoolean visible = new AtomicBoolean();
        while (SystemClock.elapsedRealtime() < deadline) {
            instrumentation.runOnMainSync(() -> visible.set(WindowInspector.getGlobalWindowViews().stream()
                .anyMatch(view -> view.findViewById(buttonId) != null && view.findViewById(buttonId).isShown())));
            if (visible.get() == shown) return true;
            SystemClock.sleep(100);
        }
        return false;
    }

    private void screenshot(String name) throws Exception {
        File directory = evidenceDirectory();
        // The WebView draws a frame or two after the page changes.
        SystemClock.sleep(750);
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

    private File evidenceDirectory() {
        String outputPath = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir");
        assertNotNull("Run through Gradle to retain test evidence", outputPath);
        File directory = new File(outputPath);
        assertTrue(directory.isDirectory() || directory.mkdirs());
        return directory;
    }

    private void writeEvidence(String name, JSONObject result) throws Exception {
        Files.write(new File(evidenceDirectory(), name).toPath(), result.toString(2).getBytes(StandardCharsets.UTF_8));
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

package io.github.tanmay73.diskgrove;

import android.os.Bundle;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(DiskGroveNativePlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge == null) return;

        bridge.setWebViewClient(new MediaWebViewClient(bridge));
        WebSettings settings = bridge.getWebView().getSettings();
        // The app's font size setting scales the page through its viewport tag, which needs a wide viewport.
        settings.setUseWideViewPort(true);
        // Android's own font size would grow text inside fixed-height rows; the app's setting scales everything.
        settings.setTextZoom(100);
    }
}

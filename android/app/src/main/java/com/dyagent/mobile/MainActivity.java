package com.dyagent.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Native plugins must be registered before the bridge loads.
        registerPlugin(GemmaLlmPlugin.class);
        registerPlugin(ModelDownloaderPlugin.class);
        registerPlugin(PhoneActionsPlugin.class);
        registerPlugin(DYBrowserPlugin.class);
        registerPlugin(DYFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

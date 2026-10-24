# Wiring the on-device Gemma 4 E2B plugin into the Android project

The web layer talks to a Capacitor plugin named **`GemmaLlm`**. This folder holds
the native implementation (`GemmaLlmPlugin.kt`). After you generate the Android
project (`npx cap add android`), do the following.

## 1. Copy the plugin into the app

Place `GemmaLlmPlugin.kt` under:

```
android/app/src/main/java/ai/dyagent/mobile/GemmaLlmPlugin.kt
```

(The package `com.dyagent.mobile` matches `appId` in `capacitor.config.json`.)

## 2. Register it

In `android/app/src/main/java/ai/dyagent/mobile/MainActivity.java` (or `.kt`),
register the plugin before `super.onCreate` loads the bridge:

```java
import com.dyagent.mobile.GemmaLlmPlugin;
import com.dyagent.mobile.ModelDownloaderPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GemmaLlmPlugin.class);
        registerPlugin(ModelDownloaderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
```

`ModelDownloaderPlugin.kt` (same folder as the Gemma plugin) wraps the Android
system **DownloadManager** so the multi-GB model download keeps running with
the screen off or the app closed, auto-retries, and shows progress in the
notification shade. It saves to the app-specific external files dir (no storage
permission needed) and the web layer passes the resulting absolute path to
`GemmaLlm.load`.

## 3. Add the inference runtime dependency

> **Current state:** `GemmaLlmPlugin.kt` is written against **Option B
> (LiteRT-LM)** — `com.google.ai.edge.litertlm:litertlm-android:0.14.0`, with
> `kotlin-gradle-plugin` **2.2.21** (the library's Kotlin 2.x metadata rejects
> KGP 1.9). LiteRT-LM ships arm64-v8a / x86_64 native libs only, so drop any
> armeabi-v7a ABI split. Note the HF repo's `-web.task` file is a raw TFLite
> flatbuffer, *not* a MediaPipe zip bundle — Option A cannot load it.

### Option A — MediaPipe LLM Inference (historical)

In `android/app/build.gradle`:

```gradle
dependencies {
    implementation 'com.google.mediapipe:tasks-genai:0.10.24'
    // MPImage / BitmapImageBuilder (vision input) live in tasks-core,
    // which tasks-genai does NOT pull in transitively:
    implementation 'com.google.mediapipe:tasks-core:0.10.21'
}
```

The plugin is Kotlin, and the generated Capacitor project is Java-only, so also:

- `android/build.gradle` (buildscript deps):
  `classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25'`
- `android/app/build.gradle`: `apply plugin: 'org.jetbrains.kotlin.android'`
  and, inside `android { ... }`, `kotlinOptions { jvmTarget = '17' }`
  (AGP compiles Java at 17; Kotlin must match or the build fails).
- `android/variables.gradle`: `minSdkVersion = 24` (required by tasks-genai;
  Capacitor's default is 22).

Model file: download **`gemma-4-E2B-it-web.task`** (or the Android `.task`
bundle) from the LiteRT community / Kaggle and ship or download it at runtime.

### Option B — LiteRT-LM (recommended by Google; `.litertlm`)

LiteRT-LM is the newer, faster path (keeps per-layer embeddings out of memory,
loads vision/audio encoders on demand). This path is **field-proven for this
project**: the PhonePilot v3.4 reference APK runs Gemma this way, bundling
`libLiteRt.so`, `libLiteRtClGlAccelerator.so`, and `liblitertlm_jni.so` for
`arm64-v8a` (+ `x86_64` for the emulator).

The Kotlin API surface (package `com.google.ai.edge.litertlm`) maps cleanly
onto this plugin's contract:

| Plugin method | LiteRT-LM API |
|---|---|
| `load()` | `Engine(EngineConfig(modelPath, backend = Backend.GPU))` |
| `generate()` | `engine.createSession()` / `Conversation.sendMessageAsync(...)` |
| `token` events | streaming callback of `sendMessageAsync` |
| images | `Content`/`Message` parts (vision modality) |
| (future) native tools | `Tool` / `ToolSet` — LiteRT-LM has first-class function calling |

Use the **`gemma-4-E2B-it.litertlm`** file from
`huggingface.co/litert-community/gemma-4-E2B-it-litert-lm`. The plugin's JS
contract (`isReady` / `load` / `generate` + `token` events) stays identical, so
only the body of `load()` and `generate()` changes.

> Note: the JS agent loop implements tool calling in the prompt layer, so it
> works on both options. If you adopt LiteRT-LM's native `ToolSet`, you can
> move tool dispatch into Kotlin later without touching the web layer.

## 4. Ship the model weights

The `.task` / `.litertlm` file is multi-GB, so do **not** bundle it in the APK.
Download it on first launch into the app files dir (`context.filesDir`), which is
where `load({ modelPath: "gemma-4-E2B-it.litertlm" })` looks by default.

This is already implemented in the web layer: when the app runs on-device and no
model is loaded, `www/index.html` shows a **model download card** (URL prefilled
with the Hugging Face `litert-community` file; editable for token-gated links or
mirrors). The download streams straight to `filesDir` via
`Filesystem.downloadFile({ directory: "DATA", progress: true })` — no base64, no
memory blow-up — then calls `GemmaLlm.load(...)` automatically. Alternative for
development: push the file with adb and restart the app:

```bash
adb push gemma-4-E2B-it.litertlm /data/local/tmp/
adb shell run-as com.dyagent.mobile sh -c \
  'cp /data/local/tmp/gemma-4-E2B-it.litertlm files/'   # debug builds only
```

## 4b. Launcher icon

`../resources/` holds the hand-drawn app icon (SVG sources + Android drawables).
After `npx cap add android`, copy `resources/android/*` over the template's
launcher resources (see `resources/README.md` for target paths and how to render
the legacy PNG densities).

## 5. GPU backend

`setPreferredBackend(GPU)` uses OpenCL on Android (~52 tok/s on E2B). If a device
lacks a compatible GPU, MediaPipe falls back to CPU automatically; for LiteRT-LM,
select the CPU backend in its engine options.

## 6. Permissions

Camera + storage for the multimodal features. Capacitor's Camera and Filesystem
plugins add most of what's needed; confirm `android/app/src/main/AndroidManifest.xml`
has:

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.INTERNET" />
```

Also, inside `<application>`, declare the OpenCL vendor libraries (Android 12+
hides undeclared native libs from the app, so the GPU backend fails with
"Can not find OpenCL library" even on devices that have one) and enable
`android:largeHeap="true"` for the multi-GB model:

```xml
<uses-native-library android:name="libOpenCL.so" android:required="false" />
<uses-native-library android:name="libOpenCL-car.so" android:required="false" />
<uses-native-library android:name="libOpenCL-pixel.so" android:required="false" />
```

## GenerationService (background generation)

`GenerationService.kt` is a foreground service that keeps on-device
generation running when the screen is off or the app is backgrounded (a plain
background thread gets its CPU suspended otherwise). `GemmaLlmPlugin.generate()`
start()s it before inference and stop()s it on every terminal path.

Manifest additions required (in `android/app/src/main/AndroidManifest.xml`):

```xml
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<!-- inside <application> -->
<service
    android:name=".GenerationService"
    android:exported="false"
    android:foregroundServiceType="dataSync" />
```

No MainActivity registration is needed (services are started via Intent, not
registered like Capacitor plugins).

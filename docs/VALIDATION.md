# DY PHONE release validation

The web interface was checked on October 24, 2026, and the APKs on October 25, 2026 (Asia/Seoul). This record covers the v3.19.0 release.

## Source and packaging checks

- Installed the locked dependencies with `npm ci --ignore-scripts --no-audit --no-fund`.
- Ran `npx cap sync android` to copy the web assets and app configuration into the Android project and update the plugin registrations.
- Checked the syntax of seven application JavaScript modules and parsed the Android XML files.
- Verified the DY PHONE name in the Android launcher, activity title, Capacitor configuration, HTML title, greeting, system prompt, and notifications for model downloads and generation.
- Verified the existing Android application ID (`com.dyagent.mobile`) and internal storage keys.
- Scanned the files selected for publication for private keys and common token patterns. The release source excludes private keys, environment files, signing configuration, local SDK paths, and `node_modules`.
- Compared the third-party libraries and 35 existing PNG files with the original ZIP. They matched byte for byte.

## Browser checks

The app ran from a local web server in Chrome with a 412 × 892 CSS pixel viewport. The interface and test prompt were in Korean.

| Action | Observed result |
| --- | --- |
| Open the chat | The title and greeting displayed DY PHONE. |
| Ask the assistant to calculate `12000 * 3 + 5000` | The mock backend called the calculator and returned `41000`. |
| Open the virtual OS from the chat menu | The DY OS app grid appeared. |
| Open the code editor and run its default JavaScript example | The output reported that the sum of the integers from 1 to 10 was `55`. |

The [chat](images/chat-mobile.png), [workspace](images/workspace-mobile.png), and [code editor](images/code-mobile.png) screenshots capture those browser checks. The [original preview image](images/dy-phone-preview.png) combines the captures with a title and captions. The screens and responses came from the running web interface. The `mock (dev)` label identifies the demo backend.

## Android release checks

- Built `assembleRelease` with JDK 17, Gradle 8.14.2, Android Gradle Plugin 8.13.2, Kotlin 2.3.10, and Android SDK Platform 34. The build used `-Pandroid.overridePathCheck=true` for a Windows path containing Korean characters.
- Verified the application ID `com.dyagent.mobile`, display name `DY PHONE`, version code `40`, and version name `3.19`. The GitHub release tag is `v3.19.0`.
- Signed the APKs with a dedicated release key. Both passed APK Signature Scheme v2 and v3 verification and `zipalign -c -v 4`.
- Verified ZIP integrity, compared the main bundled web assets byte for byte with their source files, and confirmed the Capacitor app name.
- Sent an HTTP HEAD request to the model download URL. It returned HTTP 200 and reported a file size of 2,588,147,712 bytes. The check covered the download metadata only.
- Checked that the public source and APKs excluded the private signing key, passwords, and local SDK settings.
- Ran `:app:lintRelease`. It passed with 0 errors and 33 warnings recorded in the lint report.

**Signing certificate SHA-256**

```text
31aa1c077e610de2aaeb1a702b07086d4b6711b04ec9e5811e09e07d7ab80736
```

| File | Bytes | Native architectures | SHA-256 |
| --- | ---: | --- | --- |
| DY-PHONE-3.19.0-arm64-v8a.apk | 28383271 | arm64-v8a | `1e20290f389eed190e33d431336ae5d3f021546f4688a65c99c70762ddeef30f` |
| DY-PHONE-3.19.0-universal.apk | 53033630 | arm64-v8a, x86_64 | `2a9f8b04ca3fdce251bc85259c01d26f49f83813d024420fedec851a980d36ad` |

## Features still awaiting verification

No physical Android device was connected for this release. The following items remained untested:

- Installation and launch on a device, including the native plugins.
- A full model download, native LiteRT-LM inference, image understanding, and device-specific speed, memory use, and battery use.
- Camera access, calls, text messages, background services, and export and preview across all document formats.

# App icon sources

The DY PHONE mark is the **agent loop**: a warm 270° arc (act) meeting a cool
90° arc (observe) around a core dot. Hand-drawn as SVG paths — no stock/emoji art.

- `icon-square.svg` / `icon-round.svg` — legacy launcher icons (API < 26)
- `icon-foreground.svg` — adaptive-icon foreground layer (art within the 66dp safe zone)
- `android/` — drop-in Android resources:
  - `ic_launcher_foreground.xml` → `res/drawable-v24/`
  - `ic_launcher_background.xml` → `res/values/`
  - `ic_launcher.xml` → `res/mipmap-anydpi-v26/ic_launcher.xml` **and** `ic_launcher_round.xml`

Legacy PNGs (`res/mipmap-*/ic_launcher*.png`) are rendered from the SVGs at
48/72/96/144/192 px (and 108/162/216/324/432 px for the foreground), e.g. with
headless Chromium:

```bash
chromium --headless --no-sandbox --default-background-color=00000000 \
  --window-size=192,192 --screenshot=ic_launcher.png icon-square.svg
```

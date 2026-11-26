# Native icon sources and generation

`icon.svg` is the official [Phantom workbench P](https://ashlr.ai/logos/phantom-workbench-logo.svg), SHA-256 `1917d65cc411186522e1ccacea4a461b7b04707ce0ab444a33abbc1a1d880bba`. It is not the Phantom Secrets ghost.

The following generated files must exist before `cargo tauri build` bundles the app:

| File | Size | Used by |
|------|------|---------|
| `32x32.png` | 32×32 px | Bundle icon |
| `128x128.png` | 128×128 px | Bundle icon |
| `128x128@2x.png` | 256×256 px | Retina bundle icon |
| `icon.icns` | Multiple sizes | macOS app |
| `icon.ico` | Multiple sizes | Windows executable and installer |

The release workflow regenerates the bundle icons from the tracked SVG. The checked-in outputs also cover Windows Store, iOS and Android. The separately generated `tray.png` is a monochrome P template; macOS chooses its ink color for the menu bar.

## Generate

With Node.js and ImageMagick's `convert` available, regenerate the bundle and tray icons together:

```sh
./desktop/src-tauri/icons/generate-icons.sh
```

The script pins the same Tauri CLI version as the desktop release workflow. For bundle icons only, the Tauri SVG pipeline does not require ImageMagick.

For an isolated bundle-only reproduction, run `npx --yes @tauri-apps/cli@2.11.4 icon desktop/src-tauri/icons/icon.svg --output /absolute/private/output`. The artwork does not rename the native bundle, signing identity or package.

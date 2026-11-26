# Customize Phantom Desktop

Open **Settings → Appearance**. Under **Sidebar mark**, choose **Phantom P** (the default), **Ghost** (the legacy mark), or **Upload image**. Upload an SVG, PNG, or WebP up to 512 KiB. A selected upload can be replaced in the same row. Choose **Reset to defaults** to restore the Phantom P and the other shipped appearance settings.

The same panel controls theme (System, Light, Dark, or High contrast), accent, and density. System follows the OS. The sidebar mark changes independently of the accent.

## Use the CLI

```sh
phm settings appearance get --json
phm settings appearance set --brand ghost --theme dark --accent '#6366f1' --density compact --json
phm settings appearance set --brand-file ./my-mark.svg --json
phm settings appearance --reset --json
```

The JSON response includes `appearance.brand` (`p`, `ghost`, or `upload`). CLI writes work without the server running, and an open desktop window picks them up on its next appearance refresh (within 15 seconds while visible). UI uploads require the local server's existing write authority; in a local browser, unlock writes under **Settings → Connection** if prompted.

## Edit the shared record

The CLI and desktop use `~/.ashlr-runs/ui/appearance.json` (or `$ASHLR_RUNS_DIR/ui/appearance.json`). If no file exists, start by writing one with the CLI. This is an example record:

```json
{
  "version": 1,
  "revision": 1,
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "updatedBy": "example",
  "appearance": {
    "brand": "ghost",
    "theme": "dark",
    "accentH": 245,
    "accentS": 72,
    "accentL": 58,
    "density": "compact"
  }
}
```

Preserve other fields and increment `revision` whenever you edit the file directly so an open window applies the change. Hue wraps to 0–359, saturation is 0–100, and accent lightness is clamped to 30–78 for readability. Older files without `brand` still use the Phantom P.

Use the CLI or UI to import a custom image. They store only the sanitized bytes in `~/.ashlr/sidebar-marks/` and write an opaque `brandAsset` digest alongside `"brand": "upload"`. The local server serves the selected image through its authenticated API; it is not a public static asset or available on the phone gateway. SVG uploads keep common geometry, presentation attributes, and local fragment references; scripts, event handlers, external references, styles and foreign content are removed. If a custom mark is unavailable, the sidebar falls back to the Phantom P.

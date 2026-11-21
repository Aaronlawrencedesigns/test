# Desktop Sidekicks (Mac app)

The app customers download. It shows their pet (made by `petgen`) in the corner of the screen,
using the product player in `petgen/engine/` (synced into `renderer/` by `npm run sync`).
Separate from Chunky's own app (`src/`), which stays as it is.

**Adding a pet:** the customer's "is ready" email has a code like `K7QM-4XTP-9HRC` and a
link to `desktopsidekicks.com/add/<CODE>`, which opens `desktopsidekicks://add/<CODE>`. The app
downloads `https://desktopsidekicks.com/api/pet/<CODE>` (a zip with `manifest.json`, `clips/`,
`stills/`, `look/`) into `~/Library/Application Support/Desktop Sidekicks/pets/<CODE>/`.
Several pets are supported: they're switched from the menu-bar paw.

## Build the signed DMG (on the owner's Mac)

    cd ~/chunky && git pull
    cd app
    npm install
    npm run dist:signed        # signs with the Developer ID cert, notarizes (Keychain profile chunky-notary)

Result: `app/dist/Desktop-Sidekicks.dmg` (universal: Apple silicon + Intel). Upload it to the top
of the R2 bucket `desktopsidekicks-orders` as `Desktop-Sidekicks.dmg` (Cloudflare dashboard → R2 →
the bucket → Upload). The site serves it at `desktopsidekicks.com/download`.

Try it unsigned first: `npm start` (needs a delivered pet code), or `npm run dist`.
Set `SIDEKICKS_SITE=http://localhost:8788` to point it at a local site.

## Windows (testing)
The same app runs on Windows. Differences in `main.js`: pets unzip with PowerShell's `Expand-Archive`, the tray uses
the colour icon (`tray-win.png`; left-click opens the menu) and the "Add your pet" window hides its menu bar.

- `npm run dist:win`: NSIS installer `dist/Desktop-Sidekicks-Setup.exe`. Build it on Windows (or a GitHub Actions
  windows runner): on Linux electron-builder needs Wine, which crashes in the cloud container.
- What the testers have now (built on Linux): the **portable** app, one unsigned .exe with no installer:
  `npx electron-builder --win portable --x64 -c.win.signAndEditExecutable=false -c.portable.artifactName='Desktop-Sidekicks-Windows.${ext}'`
  (run `npm run sync` first). It shows Electron's default icon on the .exe, and Windows SmartScreen asks
  "More info -> Run anyway" because it isn't signed.
- Hosted at `/download/windows` (R2 `Desktop-Sidekicks-Windows.exe`). It's not linked from the site yet.

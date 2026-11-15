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

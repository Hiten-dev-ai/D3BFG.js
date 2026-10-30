# D3BFG.js 0.2.1 — experimental follow-up

**Campaign co-op remains VERY EXPERIMENTAL. It can crash; back up your saves.**

- Fixed the captured guest-spawn `idBitMsg::WriteBits: value overflow -1 6` path: unarmed weapon selection is a valid signed snapshot state, not an unsigned slot. Protocol 6 requires both players to reload. The later proxy assertion was a shutdown symptom, not the original error.
- Menu fades multiply final SWF render colour after timeline evaluation. Earlier alpha updates were overwritten before drawing. Covers multiplayer entry, subpages and exit without gating Escape/network actions.
- Restored campaign intro playback in all campaigns. Cinematic skip mode now means what happens when the player requests a skip; it no longer automatically bypasses intro movies.
- Added live Audio setting **Pause audio when unfocused**, enabled by default. Background suspension does not pause network simulation; focus does not resume contexts that this policy did not pause.
- Added `OFFLINE_PLAYBACK_ALLOWED=true` and detailed configuration docs. A last-known disabled policy blocks offline startup. Offline-start notices are main-menu-only and one-shot.
- Applied supplied square project art to icons and widescreen art to launcher surfaces. Added original-size owner-supplied screenshots with only address-bar text covered in black.
- Updated offline shell assets to match actual package files. Native fatal errors are reported before secondary proxy failures can consume the fatal reserve.

See [configuration](CONFIGURATION.md), [server setup](SERVER_SETUP.md) and
[partner inventory](COOP_INVENTORY.md). Packages contain no commercial game
resource archives, credentials or personal saves. Bring your own legally obtained
game installation. Artwork/screenshots are presentation media, not playable data.

Validation includes compiled source-derived regressions and server/package smoke
tests. These do not establish sustained two-engine co-op stability, complete
campaign compatibility or universal browser behavior.

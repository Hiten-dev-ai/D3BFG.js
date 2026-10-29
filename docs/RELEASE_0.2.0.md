# D3BFG.js 0.2.0 — experimental public release

Native DOOM 3 BFG-derived engine in a browser, with a self-hosted asset/account/save server. Bring your own legally owned game installation. No commercial game data is included.

## Included

- Windows x64 and native Windows ARM64 server ZIPs, bundled Node 24.18.0.
- Linux x64 portable archive and an Ubuntu/Debian-compatible amd64 `.deb`.
- Complete corresponding adapted-engine source archive and dependency notices.
- `.env.example`, owner-account bootstrap, multiplayer and shared compressed-asset cache switches, browser defaults, setup documentation and checksums.

## This pass

- Renamed the project and launcher to D3BFG.js. DEV sits before Quit with matching descriptions when enabled. Extras' Test autosave is removed.
- Create/Join pages open without waiting for the relay. Multiplayer network commands use copied, owned asynchronous dispatch; Back still cancels pending operations. Subpages get a nonblocking fade even when their retail SWF lacks a list rollOn label. Command timing appears in bounded native diagnostics.
- Developer Load Level lives within the Create Game campaign choices, beside Continue/New/Load, and cannot save campaign progress.
- Save-owned partner inventory is cloned once from the host, then retained across reconnects, map transitions and later saves/solo continuations.
- Friendly Fire is host-owned, snapshot-synchronized and checked before partner damage effects in both directions.
- Guest light/static-entity spawn metadata and current light materials are replicated rather than reconstructed from class defaults alone.
- Skip mode suppresses accelerated gameplay-cinematic camera frames while authored scripts resolve in bounded batches. Fast-forward mode still renders them. This is not an unsafe jump over script events or a promise that every scene resolves instantly.
- Fullscreen/windowed changes immediately publish native setting revisions. Wheel events do not scroll/overscroll the game page; account dialogs retain contained scrolling.

## Validation

- Full Release Wasm worker compile/link, TypeScript/Vite and all source regression scripts passed; **42 Node server tests passed**.
- Both extracted Windows packages passed startup, first-owner/login, isolation headers, private-asset authorization, server defaults, engine manifest, GPL shader serving and `.env` protection checks. ARM64 ran natively; x64 ran under Windows ARM emulation.
- Linux portable and extracted `.deb` payloads passed the same checks on **Ubuntu 24.04 x64**. `dpkg-deb` validated/extracted the package. System-wide service installation and a separate Debian machine were **not** exercised.
- Actual guest lighting, audible cinematic behavior, combat and campaign save/continue still require two-engine in-game acceptance. No measured loading/FPS gain is claimed. Native Android is planned, not included.

Pull requests, testing and contributions are welcome. See the README and CONTRIBUTING.md.

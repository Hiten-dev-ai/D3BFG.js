# D3BFG.js server setup

## Portable Windows / Linux

Extract into a writable folder. Copy `.env.example` to `.env`, set an owned game directory and unique initial owner credentials, then run `start.cmd` / `./start.sh`. No npm install is required in a release package: Node and production dependencies are bundled.

Default address: `127.0.0.1:8080`. Local loopback HTTP is for local testing only. Remote play requires an HTTPS reverse proxy. Set `NODE_ENV=production` before exposing an instance; production cookies require HTTPS.

Some retail installations keep the shared multiplayer HUD and map thumbnails
inside a versus map archive. If these are missing during multiplayer, use the
included helper with Python 3 on **your own installation**:

```sh
python scripts/prepare-multiplayer-ui.py --game-dir /path/to/your/game --previews
```

It validates the resource table and only extracts the named small UI resources,
refusing to overwrite differing installed files. These generated commercial UI
assets stay in your private game directory and must never be committed or shipped.

## Ubuntu / Debian package

```sh
sudo apt install ./d3bfg-js_0.2.0_amd64.deb
sudoedit /etc/d3bfg-js/server.env
# Set an absolute game directory readable by d3bfg-js, credentials and TLS mode.
sudo systemctl enable --now d3bfg-js
sudo systemctl status d3bfg-js
```

The package does **not** start automatically before it is configured. Its dedicated unprivileged service user must be able to read the supplied game directory and write `/var/lib/d3bfg-js`. Keep configuration mode 0600, owned by `d3bfg-js`, because it initially contains a password. Remove that password after the first successful startup. Upgrades preserve the conffile and state directory. Removing the program must not remove your game installation or account/save backups.

Linux packages require a modern glibc distribution compatible with bundled Node 24 (glibc 2.28 or newer). Ubuntu 24.04 is the tested Linux target; Debian compatibility is based on the runtime's documented ABI requirements, not a separate Debian execution test.

## Reverse proxy example

```caddy
doom.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Preserve `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, and WebSocket upgrades. Don't cache `/__session/`, `/__browser_sync/`, `/__multiplayer`, lease or diagnostic APIs. Do not publish your game folder through a separate unauthenticated static server.

## Upgrades and backups

Stop your instance, back up `.env`/`server.env`, `data/accounts` and `data/saves`, replace program files, then restart. Never copy another server's account database over your own. Server release archives contain no real `.env`, accounts, saves or game assets.

Both players must reload after a network protocol update. Old clients are rejected instead of interpreting incompatible campaign snapshots.

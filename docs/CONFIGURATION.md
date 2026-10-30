# Server configuration reference

Copy `.env.example` to `.env` in the portable package root. On Ubuntu/Debian,
edit `/etc/d3bfg-js/server.env`. The service selects that file through
`D3BFG_ENV_FILE`; use that variable to select another configuration file.

**Never commit a real environment file, credentials, account database, saves or
commercial game resources.** Packages ship only a template with an empty initial
password.

## Parsing and precedence

- Process/service environment variables take precedence over file values.
- Use `KEY=value`, with `true`/`false` or `1`/`0` for booleans. Invalid booleans,
  ports and numeric ranges fail startup rather than being silently guessed.
- Quote values containing spaces or `#`, especially passwords and Windows paths.
  Forward slashes work in Windows paths, for example `D:/Games/DOOM 3 BFG Edition`.
- Relative storage/game paths resolve from the **package root**, not the browser
  or launching directory. Absolute paths are recommended for services. Restart
  the server after configuration changes.

## Listener, paths and ownership

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address. Keep loopback behind a reverse proxy. |
| `PORT` | `8080` | TCP port, 1–65535. Relay uses the same listener. |
| `NODE_ENV` | Set in template | `development` for local loopback HTTP; `production` with HTTPS for remote hosting and secure cookies. |
| `DOOM3BFG_GAME_DIR` | `./game` | Your legally owned installation, containing `base/` and applicable expansion data. No game data is supplied. |
| `DOOM3BFG_ACCOUNTS_DIR` | `./data/accounts` | Private account/password-hash and session database. |
| `DOOM3BFG_SYNC_DIR` | `./data/saves` | Account-isolated synchronized save snapshots. |
| `DOOM3BFG_ENCODED_DIR` | Beside game data; template uses `./data/encoded-assets` | Optional precompressed asset cache. Never expose it as an unauthenticated directory. |
| `D3BFG_ENV_FILE` | `<package>/.env` | Alternate environment-file path, supplied by the launcher/service environment. |

The `.deb` template uses `/srv/d3bfg-game` for owned assets and
`/var/lib/d3bfg-js` for state. Program files belong to `/opt/d3bfg-js`. The service
user needs read access to game assets and write access only to its state
directory. The service is not automatically started before configuration.

## First owner

| Variable | Meaning |
| --- | --- |
| `FIRST_USERNAME` | Initial owner's display/login name, 2–48 permitted characters. |
| `FIRST_EMAIL` | Initial owner's email/login address. Required for first setup. |
| `FIRST_PASSWORD` | A unique 12–256-character initial password; there is no accepted default password. |

Used **only when no account database exists**. Passwords are salted and hashed;
changing these variables does not reset existing accounts. Remove
`FIRST_PASSWORD` after successful setup. Use the owner interface to manage player
accounts and the profile interface to change passwords. Do not delete the account
database to resolve a login problem without first backing it up.

Legacy installations may use `DOOM3BFG_AUTH_CONFIG` and `DOOM3BFG_OWNER_EMAIL`
for one-time migration. New installations should use the first-owner fields.

## Multiplayer and caching

| Variable | Default | Meaning |
| --- | --- | --- |
| `MULTIPLAYER_ENABLED` | `true` | Allow authenticated multiplayer connections. `false` disables rooms, not local campaign play. |
| `SHARED_ASSET_CACHE` | `true` | Reuse prepared compressed assets across authenticated clients. Never shares accounts/saves or caches their APIs. |
| `OFFLINE_PLAYBACK_ALLOWED` | `true` | Let a previously authenticated device start from cached engine/game resources when the server is unreachable. |

### Offline policy limits

The browser remembers the last successfully received policy. A last-known
`false` blocks an offline start before engine launch, with a connection-required
message. `true` still requires the needed assets to be cached; it cannot supply
missing maps or videos offline.

This is an operator/browser preference, **not DRM or an offline revocation
guarantee**. A disconnected device cannot learn a new server setting until it
connects again, and browser storage is controlled by the device owner. Changing
policy does not erase caches or saves. Established play is not destroyed merely
because a connection drops. Online account replacement/revocation still follows
normal session rules.

The offline-start notice is queued once per boot and shown only at the native
DOOM 3 BFG main menu—not the franchise selector. Waiting for that menu requires
no network request and does not block navigation.

## Initial browser preferences

These are **defaults**, not per-player overrides. Existing preferences in that
browser take priority. New browsers/profiles receive the server defaults; users
can change them in native Browser/Extras/Audio settings.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSER_CACHE_MODE` | `1` | `0`: temporary session; `1`: current level; `2`: visited levels; `3`: all maps. Licensed assets stay under the selected OPFS policy. |
| `BROWSER_PERSIST_SAVES` | `true` | Default local persistence; account save handling retains its safety rules. |
| `BROWSER_DEVELOPER_LEVELS` | `false` | Show developer entry points. Developer co-op does not advance campaign saves. |
| `BROWSER_ENABLE_CONSOLE` | `false` | Default console availability. |
| `BROWSER_SKIP_CINEMATICS` | `true` | Skip-action behavior: `true` hides accelerated frames while scripts resolve; `false` shows fast-forward. **Does not automatically omit campaign intro movies.** |
| `BROWSER_PAUSE_AUDIO_UNFOCUSED` | `true` | Suspend audio while the browser tab/window is unfocused or hidden. Restores only contexts paused by this policy; does not stop multiplayer simulation. Native Audio option applies immediately. |
| `BROWSER_FRAME_RATE_CAP` | `60` | Initial cap, 60–360; choices depend on display cadence and game mode. |

## HTTPS, backups and troubleshooting

For remote hosting, terminate HTTPS at a reverse proxy, forward WebSocket
upgrades and preserve COOP/COEP headers. Do not cache account, save, relay, lease
or diagnostic APIs. Cross-origin isolation and OPFS/WebGL 2 support are required.
A plain public HTTP login is not a supported safe setup.

Back up configuration, accounts and saves before upgrading. Replace program
files, not state. Both players must reload after protocol updates. **Campaign
co-op is very experimental and may still crash.** Report the version, map,
host/guest role and redacted diagnostics; never upload commercial resources,
cookies or credentials to an issue.

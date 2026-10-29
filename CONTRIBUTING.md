# Contributing to D3BFG.js

Pull requests are welcome. Please open an issue before undertaking large changes so we can agree on scope and avoid duplicated work.

## Development rules

- Preserve the native game presentation and original campaign behavior.
- Keep browser UI/menu operations nonblocking. Network failure must not trap Back/Escape.
- Treat host world state and per-save partner inventory as authoritative. Change network layouts only with a protocol bump.
- Never remove an existing user's saves, accounts or cache as a shortcut to fixing a bug.
- Do not commit commercial assets, generated JS/Wasm builds, credentials, `.env`, logs, account databases or saves.
- Retain upstream copyright and license notices. New source contributions are GPL-3.0-or-later unless a file's existing license requires otherwise.

## Before submitting

1. Build the worker and frontend using the README instructions.
2. Run `npm test` in `web/` and the relevant `scripts/check-*` regression checks from the root.
3. Add a focused regression test for a bug fix. Source-extracted fixtures are useful, but say clearly when an actual two-engine/audio/visual test has not been performed.
4. Explain the change, verification, remaining risks and any save/protocol compatibility impact.

Screenshots and short recordings help with visual bugs. Redact account details and avoid uploading game files. Security problems should be reported privately rather than accompanied by public credentials or live exploit instructions.

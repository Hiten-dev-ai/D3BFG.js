# Campaign co-op partner inventory

## Ownership and initialization

The host owns the world, save and two player slots. Slot 0 is the host; slot 1 is
the save's **partner**, not an account ID. On the first guest spawn, an unseeded
partner slot copies the host's inventory (weapons, ammo, clips, armor, carried
items, PDA/media and level-trigger inventory). It does **not** copy host
achievements, health, account information or remaining lives.

`web_coop_inventory_seeded` marks initialization. A reconnect restores that
partner's current inventory, rather than granting a fresh copy of the host's
latest equipment. A different invited guest assumes the same partner slot;
this is deliberate save ownership, not a per-account inventory database.

## Lifetime and persistence

- Disconnect captures the departing partner's persistent state before deleting
  the entity. Rejoin uses it without reseeding.
- Saving refreshes live player inventory. A `web_partner_` envelope in the
  host's existing persistent dictionary preserves the partner even while absent.
- The envelope is carried through subsequent saves, including a solo continuation
  of that campaign. Replacing it first removes obsolete keys so discarded items
  do not reappear. It uses the existing extensible save dictionary, not an
  incompatible insertion into the binary player save layout.
- Load clears unrelated prior-room guest dictionaries, decodes the save's
  envelope, and recreates current lobby users. A saved guest entity is not reused
  as a browser identity. Existing older co-op saves can recover inventory from
  their restored guest entity; older solo saves seed from the host on first join.
- Normal co-op map transitions capture and restore both dictionaries. New rooms
  and fresh campaigns clear previous-room inventory.
- Developer co-op launches are isolated: campaign saves are blocked and finishing
  a developer map exits the test session rather than advancing campaign progress.

## Client synchronization

Ordinary snapshots synchronize weapons/ammo state. A bounded, ordered reliable
initial-inventory transfer also supplies PDA/items that those snapshots do not
represent. Chunks stay below the reliable-message buffer size and apply complete
inventory to a newly created guest, not to every frame of active play.

Native and relay protocol **6** rejects older incompatible clients. Both players
must reload after an update. Friendly Fire is host-owned and repeated in co-op
game snapshots; partner-damage suppression runs before armor and knockback in
both directions. Enemy and self damage retain their normal rules.

Unarmed/not-yet-selected weapon `-1` is transmitted as a signed snapshot field.
The previous unsigned six-bit field aborted when a new guest inherited an
unarmed host's selection during the opening campaign sequence.

## Verification boundary

Source-derived compiled regressions execute seeding and envelope persistence,
disconnect/reconnect retention, save decoding, solo carry-forward, obsolete-item
replacement and the two-direction Friendly Fire guard. The worker fully compiles
and links. These tests do not substitute for an authenticated two-engine campaign,
visual/PDA inspection or a real manual save/continue acceptance session.

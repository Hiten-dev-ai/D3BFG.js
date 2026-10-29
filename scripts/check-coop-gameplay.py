#!/usr/bin/env python3
"""Source-derived acceptance harness for co-op respawn, damage, and key sharing."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "engine" / "chocolate-doom3-bfg" / "neo" / "d3xp"


def strip_comments(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"//[^\n]*", "", source)


def matching(source: str, start: int, opening: str, closing: str) -> int:
    """Return the matching delimiter while skipping C++ comments and strings."""
    depth = 0
    i = start
    quote = None
    while i < len(source):
        char = source[i]
        pair = source[i : i + 2]
        if quote:
            if char == "\\":
                i += 2
                continue
            if char == quote:
                quote = None
        elif pair == "//":
            end = source.find("\n", i + 2)
            i = len(source) if end < 0 else end
            continue
        elif pair == "/*":
            end = source.find("*/", i + 2)
            if end < 0:
                raise AssertionError("unterminated C++ comment")
            i = end + 2
            continue
        elif char in ('"', "'"):
            quote = char
        elif char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise AssertionError(f"unmatched C++ {opening}")


def function_body(source: str, signature: str) -> str:
    start = source.find(signature)
    if start < 0:
        raise AssertionError(f"source function not found: {signature}")
    opening = source.find("{", start)
    if opening < 0:
        raise AssertionError(f"function body not found: {signature}")
    return source[opening + 1 : matching(source, opening, "{", "}")]


def if_block(source: str, marker: str = "if") -> tuple[str, str]:
    marker_index = source.find(marker)
    if marker_index < 0:
        raise AssertionError(f"C++ branch not found: {marker}")
    if marker.lstrip().startswith("else if"):
        start = marker_index + marker.find("if")
    elif marker.lstrip().startswith("if"):
        start = marker_index
    else:
        start = source.rfind("if", 0, marker_index + 1)
    paren = source.find("(", start + 2)
    if paren < 0:
        raise AssertionError(f"condition not found for branch: {marker}")
    close_paren = matching(source, paren, "(", ")")
    opening = source.find("{", close_paren)
    if opening < 0:
        raise AssertionError(f"body not found for branch: {marker}")
    return source[paren + 1 : close_paren], source[opening + 1 : matching(source, opening, "{", "}")]


def cpp_bool(expression: str, **values: object) -> bool:
    """Evaluate the small boolean-predicate subset used by the extracted C++ gates."""
    expression = strip_comments(expression).strip()
    replacements = {
        "gameLocal.gameType": "game_type",
        "gameLocal.gameState": "game_state",
        "gameState": "game_state",
        "gameLocal.serverInfo.GetBool(\"si_teamDamage\")": "team_damage",
        "damageDef->GetBool(\"noTeam\")": "no_team",
        "gameLocal.mpGame.IsGametypeTeamBased()": "team_based",
        "gameLocal.mpGame.IsGametypeCoopBased()": "coop_based",
        "mpGame.IsGametypeCoopBased()": "coop_based",
        "IsGametypeTeamBased()": "team_based",
        "IsGametypeCoopBased()": "coop_based",
        "WantRespawn(p)": "want_respawn",
        "p == spectator": "is_spectator",
        "player != this": "other_attacker",
        "player->team == team": "same_team",
        "common->IsServer()": "is_server",
        "spawnArgs.GetBool(\"inv_carry\")": "is_carry_item",
        "entityNumber == 0": "is_host_slot",
        "spot == infoPlayerStartSpot": "spot_is_start",
        "usedCoopStartPoint": "used_start",
        "spawnPhaseWalk": "spawn_phase",
        "spectating": "is_spectating",
        "health > 0": "alive",
        "health <= 0": "not alive",
        "IsCollidingWithPlayer()": "player_overlap",
        "other == NULL": "other_null",
        "other == this": "other_is_self",
        "other == this": "other_is_self",
        "other->IsType(idPlayer::Type)": "other_is_player",
        "hit->IsType(idPlayer::Type)": "hit_is_player",
        "ent->IsType(idPlayer::Type)": "spawn_is_player",
        "physics->ClipContents(clipModel)": "clip_contents",
        'idStr::FindText(this->GetEntityDefName(), "item_key", false)': 'entity_def.find("item_key")',
        'idStr::FindText(this->GetEntityDefName(), "item_powercell", false)': 'entity_def.find("item_powercell")',
    }
    for old, new in sorted(replacements.items(), key=lambda item: -len(item[0])):
        expression = expression.replace(old, new)
    expression = re.sub(r"\bplayer\b", "has_player", expression)
    expression = re.sub(r"game_type\s*==\s*(GAME_[A-Z0-9_]+)", r"game_type == '\1'", expression)
    expression = re.sub(r"game_state\s*==\s*(GAMEON|WARMUP|COUNTDOWN)", r"game_state == '\1'", expression)
    expression = expression.replace("||", " or ").replace("&&", " and ")
    expression = re.sub(r"!(?!=)", " not ", expression)
    expression = expression.replace("true", "True").replace("false", "False")
    allowed_names = {key: value for key, value in values.items()}
    try:
        return bool(eval(f"({expression})", {"__builtins__": {}}, allowed_names))
    except Exception as error:
        raise AssertionError(f"could not evaluate extracted C++ predicate {expression!r}: {error}") from error


def require(condition: bool, description: str, failures: list[str]) -> None:
    if condition:
        print(f"PASS {description}")
    else:
        failures.append(description)
        print(f"FAIL {description}")


def check_respawn(failures: list[str]) -> None:
    source = strip_comments((ENGINE / "MultiplayerGame.cpp").read_text(encoding="utf-8"))
    body = function_body(source, "void idMultiplayerGame::CheckRespawns(")
    outer_condition, outer_body = if_block(body, "if (WantRespawn(p) || p == spectator)")
    normal_start = outer_body.find("} else {")
    if normal_start < 0:
        raise AssertionError("normal respawn dispatch block not found")
    normal_branch = outer_body[normal_start + len("} else {") :]
    coop_condition, coop_body = if_block(normal_branch, "if (gameLocal.gameType == GAME_COOP)")
    coop_state_condition, coop_state_body = if_block(coop_body, "if (gameState == GAMEON)")
    versus_branch = normal_branch[normal_branch.find("else if (gameLocal.gameType == GAME_DM") :]
    dispatch_condition, dispatch_body = if_block(versus_branch, "if (gameLocal.gameType == GAME_DM")
    state_condition, state_body = if_block(dispatch_body, "if (gameState == WARMUP")

    def respawns(game_type: str, game_state: str, team_based: bool = False) -> bool:
        want_respawn = cpp_bool(outer_condition, want_respawn=True, is_spectator=False)
        if game_type == "GAME_COOP":
            return want_respawn and cpp_bool(coop_condition, game_type=game_type) and cpp_bool(
                coop_state_condition, game_state=game_state
            ) and "p->ServerSpectate(false)" in coop_state_body
        return (
            want_respawn
            and cpp_bool(dispatch_condition, game_type=game_type, team_based=team_based)
            and cpp_bool(state_condition, game_state=game_state)
            and "p->ServerSpectate(false)" in state_body
        )

    require(respawns("GAME_COOP", "GAMEON"), "GAME_COOP dead player exits spectate during GAMEON", failures)
    require(not respawns("GAME_COOP", "WARMUP"), "co-op does not use the multiplayer warmup respawn path", failures)
    require(not respawns("GAME_COOP", "COUNTDOWN"), "co-op respawn remains limited to GAMEON", failures)
    require(not respawns("GAME_SP", "GAMEON"), "single-player does not enter multiplayer respawn dispatch", failures)
    require(respawns("GAME_DM", "GAMEON"), "original DM respawn path remains enabled", failures)
    require(respawns("GAME_TDM", "GAMEON", team_based=True), "original team-mode respawn path remains enabled", failures)


def check_friendly_fire(failures: list[str]) -> None:
    source = strip_comments((ENGINE / "Player.cpp").read_text(encoding="utf-8"))
    body = function_body(source, "void idPlayer::CalcDamagePoints(")
    marker = body.find("if ((gameLocal.mpGame.IsGametypeTeamBased()")
    if marker < 0:
        raise AssertionError("damage suppression block not found")
    condition, action = if_block(body[marker:], "if")

    def suppressed(game_type: str, team_based: bool, team_damage: bool, no_team: bool, same_team: bool) -> bool:
        return cpp_bool(
            condition,
            game_type=game_type,
            team_based=team_based,
            coop_based=game_type == "GAME_COOP",
            team_damage=team_damage,
            no_team=no_team,
            has_player=True,
            other_attacker=True,
            same_team=same_team,
        ) and "damage = 0" in action

    require(suppressed("GAME_COOP", False, False, False, True), "co-op teammate damage is suppressed by default", failures)
    require(not suppressed("GAME_COOP", False, True, False, True), "si_teamDamage enables co-op friendly fire", failures)
    require(not suppressed("GAME_COOP", False, False, True, True), "noTeam damage definitions bypass co-op suppression", failures)
    require(suppressed("GAME_TDM", True, False, False, True), "original team-mode damage suppression remains enabled", failures)
    require(not suppressed("GAME_DM", False, False, False, True), "original non-team versus damage remains unchanged", failures)


def check_item_sharing(failures: list[str]) -> None:
    source = strip_comments((ENGINE / "Item.cpp").read_text(encoding="utf-8"))
    body = function_body(source, "bool idItem::GiveToPlayer(")
    carry_condition, carry_body = if_block(body, "if (spawnArgs.GetBool(\"inv_carry\"))")
    require(cpp_bool(carry_condition, is_carry_item=True), "carry items use inventory grant path", failures)

    # Interpret the source's optional server/co-op sharing block and item-name gates.
    share_marker = "if (common->IsServer() && gameLocal.mpGame.IsGametypeCoopBased())"
    share_available = share_marker in carry_body
    item_selector = "False"
    shares_other_player = False
    share_condition = "False"
    if share_available:
        share_condition, share_body = if_block(carry_body, share_marker)
        selector_start = share_body.find("const bool sharedCampaignItem =")
        if selector_start >= 0:
            selector_end = share_body.find(";", selector_start)
            item_selector = share_body[share_body.find("=", selector_start) + 1 : selector_end]
        action_condition, action_body = if_block(share_body, "if (sharedCampaignItem)")
        shares_other_player = (
            "otherPlayer->GiveInventoryItem(&spawnArgs, giveFlags)" in action_body
            and "otherPlayer != player" in action_body
            and "i < gameLocal.numClients" in action_body
            and "ent->IsType(idPlayer::Type)" in action_body
        )

    def recipients(item_name: str, is_server: bool, coop: bool, is_carry: bool = True) -> set[str]:
        result = {"touching_player"} if is_carry and cpp_bool(carry_condition, is_carry_item=is_carry) else set()
        if (
            share_available
            and cpp_bool(share_condition, is_server=is_server, coop_based=coop)
            and shares_other_player
            and cpp_bool(item_selector, entity_def=item_name)
        ):
            result.add("other_player")
        return result

    expected_shared = {"touching_player", "other_player"}
    require(recipients("item_key", True, True) == expected_shared, "host pickup shares campaign keys with the peer", failures)
    require(recipients("item_powercell", True, True) == expected_shared, "host pickup shares campaign powercells with the peer", failures)
    require(recipients("item_key", False, True) == {"touching_player"}, "client pickup does not authoritatively share carry items", failures)
    require(recipients("item_key", True, False) == {"touching_player"}, "single-player and versus pickup ownership stays local", failures)
    require(recipients("ammo_clip", True, True, is_carry=False) == set(), "ordinary ammo does not use campaign carry sharing", failures)


def check_spawn_overlap(failures: list[str]) -> None:
    game_source = strip_comments((ENGINE / "Game_local.cpp").read_text(encoding="utf-8"))
    randomize_body = function_body(game_source, "void idGameLocal::RandomizeInitialSpawns(")
    spawn_def = re.search(
        r'spawnDefName\s*=\s*mpGame\.IsGametypeCoopBased\(\)\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"',
        randomize_body,
    )
    require(spawn_def is not None, "spawn collection selects a co-op-specific spawn def", failures)
    if spawn_def:
        require(spawn_def.group(1) == "info_player_coop", "co-op prefers info_player_coop spots", failures)
        require(spawn_def.group(2) == "info_player_deathmatch", "versus keeps info_player_deathmatch spots", failures)

    player_source = strip_comments((ENGINE / "Player.cpp").read_text(encoding="utf-8"))
    select_body = function_body(player_source, "void idPlayer::SelectInitialSpawnPoint(")
    host_start_condition, host_start_body = if_block(
        select_body,
        "if (gameLocal.mpGame.IsGametypeCoopBased() && entityNumber == 0 && !spectating && !usedCoopStartPoint)",
    )
    host_gets_start = cpp_bool(
        host_start_condition,
        coop_based=True,
        is_host_slot=True,
        is_spectating=False,
        used_start=False,
    )
    require(host_gets_start and "spot = infoPlayerStartSpot" in host_start_body,
            "first live host spawn uses info_player_start", failures)
    require(
        not cpp_bool(
            host_start_condition,
            coop_based=True,
            is_host_slot=False,
            is_spectating=False,
            used_start=False,
        ),
        "guest does not consume the host-only campaign start point", failures)
    require("usedCoopStartPoint = true" in host_start_body,
            "host start target gate becomes consumed after first live spawn", failures)

    start_fallback_condition, start_fallback_body = if_block(
        select_body,
        "if (gameLocal.mpGame.IsGametypeCoopBased() && spot == infoPlayerStartSpot)",
    )
    activate_condition, activate_body = if_block(select_body, "if (activateSpawnTargets)")
    start_fallback_suppresses_targets = cpp_bool(
        start_fallback_condition,
        coop_based=True,
        spot_is_start=True,
    ) and "activateSpawnTargets = false" in start_fallback_body
    host_first_activates = "activateSpawnTargets = true" in select_body and "usedCoopStartPoint = true" in host_start_body
    require(start_fallback_suppresses_targets and host_first_activates and
            "spot->PostEventMS(&EV_ActivateTargets, 0, this)" in activate_body,
            "fallback/respawn does not refire info_player_start targets", failures)
    require("if (!gameLocal.mpGame.IsGametypeCoopBased())" in select_body or
            "activateSpawnTargets = true" in select_body,
            "single-player spawn target activation remains enabled", failures)

    overlap_body = function_body(player_source, "bool idPlayer::IsCollidingWithPlayer(")
    skip_condition, skip_body = if_block(
        overlap_body,
        "if (other == NULL || other == this || !physics->ClipContents(clipModel))",
    )
    player_condition, player_body = if_block(overlap_body, "if (other->IsType(idPlayer::Type))")
    valid_player_overlap = not cpp_bool(
        skip_condition,
        other_null=False,
        other_is_self=False,
        clip_contents=True,
    ) and cpp_bool(player_condition, other_is_player=True)
    no_player_overlap = (
        cpp_bool(skip_condition, other_null=False, other_is_self=False, clip_contents=False)
        or not cpp_bool(player_condition, other_is_player=False)
    )
    require("ClipModelsTouchingBounds" in overlap_body and "ClipContents" in overlap_body and
            valid_player_overlap and "return true" in player_body,
            "overlap detection uses actual clip contents and recognizes peer players", failures)
    require(no_player_overlap and "return false" in overlap_body,
            "non-overlapping or world-only bounds do not enable phase walk", failures)

    killbox_body = function_body(game_source, "void idGameLocal::KillBox(")
    skip_peers_condition, skip_peers_body = if_block(
        killbox_body,
        "if (hit->IsType(idPlayer::Type) && ent->IsType(idPlayer::Type) && mpGame.IsGametypeCoopBased())",
    )
    peer_pair = cpp_bool(
        skip_peers_condition,
        hit_is_player=True,
        spawn_is_player=True,
        coop_based=True,
    )
    non_coop_pair = cpp_bool(
        skip_peers_condition,
        hit_is_player=True,
        spawn_is_player=True,
        coop_based=False,
    )
    coop_nonplayer_pair = cpp_bool(
        skip_peers_condition,
        hit_is_player=False,
        spawn_is_player=True,
        coop_based=True,
    )
    require(peer_pair and "continue" in skip_peers_body and
            killbox_body.find("continue;") < killbox_body.find("hit->Damage"),
            "co-op KillBox skips peer-player telefrag damage", failures)
    require(not non_coop_pair and "hit->Damage" in killbox_body,
            "single-player and versus retain ordinary KillBox damage", failures)
    require(not coop_nonplayer_pair and "hit->Damage" in killbox_body,
            "co-op still telefrags blocking non-player entities", failures)

    move_checks = []
    for signature in ("void idPlayer::Move_Interpolated(", "void idPlayer::Move()"):
        move_body = function_body(player_source, signature)
        phase_condition, phase_body = if_block(
            move_body,
            "else if (spawnPhaseWalk && gameLocal.mpGame.IsGametypeCoopBased() && health > 0 && !spectating)",
        )
        move_checks.append((move_body, phase_condition, phase_body))
    phase_rules = all(
        "physicsObj.SetClipMask(MASK_PLAYERSOLID)" in phase_body
        and "spawnPhaseWalk = IsCollidingWithPlayer()" in phase_body
        and "physicsObj.SetClipMask(MASK_DEADSOLID)" in phase_body
        for _, _, phase_body in move_checks
    )
    respawn_shared_body = function_body(player_source, "void idPlayer::Respawn_Shared(")
    phase_assignment = re.search(r"spawnPhaseWalk\s*=\s*([^;]+);", respawn_shared_body)
    if phase_assignment is None:
        raise AssertionError("transient spawn overlap initialization not found")
    can_phase_assignment = re.search(r"const bool canPhaseWalk\s*=\s*([^;]+);", respawn_shared_body)
    if can_phase_assignment is None:
        raise AssertionError("alive co-op phase gate not found")
    can_phase_overlap = cpp_bool(
        can_phase_assignment.group(1),
        coop_based=True,
        alive=True,
        is_spectating=False,
    )
    can_phase_separated = cpp_bool(
        can_phase_assignment.group(1),
        coop_based=True,
        alive=True,
        is_spectating=False,
    )
    can_phase_dead = cpp_bool(
        can_phase_assignment.group(1),
        coop_based=True,
        alive=False,
        is_spectating=False,
    )
    overlap_init = can_phase_overlap and cpp_bool(phase_assignment.group(1), canPhaseWalk=True, player_overlap=True)
    separated_init = can_phase_separated and cpp_bool(phase_assignment.group(1), canPhaseWalk=True, player_overlap=False)
    dead_init = can_phase_dead and cpp_bool(phase_assignment.group(1), canPhaseWalk=True, player_overlap=True)
    still_overlapping = phase_rules and overlap_init and all(
        cpp_bool(condition, spawn_phase=True, coop_based=True, alive=True, is_spectating=False)
        and "spawnPhaseWalk = IsCollidingWithPlayer()" in phase_body
        for _, condition, phase_body in move_checks
    )
    # The source rechecks clip overlap every movement frame; the false result
    # clears the flag, returning the next frame to MASK_PLAYERSOLID.
    clears_when_separated = phase_rules and not separated_init and all(
        "spawnPhaseWalk = IsCollidingWithPlayer()" in phase_body
        and "physicsObj.SetClipMask(MASK_PLAYERSOLID)" in move_body
        for move_body, _, phase_body in move_checks
    )
    non_coop_uses_normal_mask = all(
        not cpp_bool(condition, spawn_phase=True, coop_based=False, alive=True, is_spectating=False)
        and "physicsObj.SetClipMask(MASK_PLAYERSOLID)" in move_body
        for move_body, condition, _ in move_checks
    )
    require(still_overlapping and clears_when_separated,
            "co-op phase walk persists only while peer clip overlap remains", failures)
    require(not dead_init,
            "dead players never receive the temporary phase-walk state", failures)
    require(non_coop_uses_normal_mask,
            "single-player and versus movement keep the normal player clip mask", failures)

    spawn_body = function_body(player_source, "void idPlayer::SpawnToPoint(")
    read_body = function_body(player_source, "void idPlayer::ReadFromSnapshot(")
    require("gameLocal.KillBox(this)" in spawn_body and "Respawn_Shared();" in spawn_body
            and spawn_body.find("gameLocal.KillBox(this)") < spawn_body.find("Respawn_Shared();")
            and "if (respawn_netEvent.Get())" in read_body and "Respawn_Shared();" in read_body
            and read_body.find("physicsObj.SnapToNextState()") < read_body.find("Respawn_Shared();"),
            "host and client respawn paths initialize overlap after position restore", failures)
    require(overlap_init and "physicsObj.SetClipMask(MASK_PLAYERSOLID)" in respawn_shared_body
            and "spawnPhaseWalk = canPhaseWalk && IsCollidingWithPlayer()" in respawn_shared_body,
            "respawn synchronization hook recomputes transient phase state on both peers", failures)

    save_body = function_body(player_source, "void idPlayer::Save(")
    restore_body = function_body(player_source, "void idPlayer::Restore(")
    require("spawnPhaseWalk" not in save_body and "usedCoopStartPoint" not in save_body
            and "spawnPhaseWalk = false" in restore_body and "usedCoopStartPoint = true" in restore_body,
            "restore resets transient spawn state without changing save binary layout", failures)


def main() -> int:
    failures: list[str] = []
    check_respawn(failures)
    check_friendly_fire(failures)
    check_item_sharing(failures)
    check_spawn_overlap(failures)
    if failures:
        print(f"\nRegression: {len(failures)} co-op gameplay acceptance check(s) failed.")
        return 1
    print("\nCo-op gameplay acceptance passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

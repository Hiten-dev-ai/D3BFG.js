#!/usr/bin/env python3
"""Focused source contract for browser co-op life configuration and display."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "engine" / "chocolate-doom3-bfg" / "neo"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f"PASS {message}")


menu = (ENGINE / "d3xp/menus/MenuScreen_Shell_WebMultiplayer.cpp").read_text(encoding="utf-8")
player = (ENGINE / "d3xp/Player.cpp").read_text(encoding="utf-8")
multiplayer = (ENGINE / "d3xp/MultiplayerGame.cpp").read_text(encoding="utf-8")
hud = (ENGINE / "d3xp/menus/MenuScreen_HUD.cpp").read_text(encoding="utf-8")
framework = (ENGINE / "framework/common_frame.cpp").read_text(encoding="utf-8")
restore = (ENGINE / "d3xp/Game_local.cpp").read_text(encoding="utf-8")
client = (ROOT / "web/src/multiplayerClient.ts").read_text(encoding="utf-8")
bridge = (ROOT / "web/src/nativeMultiplayer.ts").read_text(encoding="utf-8")
relay = (ROOT / "web/multiplayerServer.js").read_text(encoding="utf-8")

require("lastLobbyLives = 3" in menu and 'AddCycleRow("Lives per player", MP_CMD_LIVES)' in menu,
        "co-op create form defaults to three and exposes a cycle control")
require('"mpCreate|%s|%s|%s|%d|%d|%s|%d|%d"' in menu,
        "native create action passes the selected co-op lives value")
require("coopLives?: number" in client and "request.coopLives < 1 || request.coopLives > 10" in client,
        "client contract validates a bounded 1 to 10 life budget")
require("message.coopLives === undefined ? 3 : message.coopLives" in relay and
        "coopLives < 1 || coopLives > 10" in relay and "coopLives: lobby.coopLives" in relay,
        "relay defaults legacy requests to three and publishes the selected value")
require("case 'mpRoomLives': return state.lobby?.coopLives ?? 3" in bridge and
        "coopLives: Number(coopLives)" in bridge,
        "browser bridge exposes the room allotment to the native engine")
require("room.coopLives" in framework and 'SetInt("web_coop_lives"' in framework,
        "host and guest receive the same room-owned server setting")
require("dead->ConsumeCoopLife()" in multiplayer and
        'SetInt("web_coop_lives", livesRemaining)' in multiplayer,
        "authoritative campaign death consumes and persists one life")
require("GetCoopLivesRemaining() <= 0" in multiplayer and "p->ServerSpectate(false)" in multiplayer,
        "zero lives blocks co-op respawn while positive lives keep the normal path")
require("msg.WriteByte(idMath::ClampInt(0, 10, coopLivesRemaining))" in player and
        "coopLivesRemaining = msg.ReadByte()" in player,
        "remaining lives replicate in matching player snapshots")
require('SetInt("web_coop_lives", coopLivesRemaining)' in player and
        "existing persistent-player dictionary" in player and 'SetInt("web_coop_lives"' in restore,
        "life state persists across map changes and savegames without changing player save layout")
require("gameLocal.time + 6000" in hud and "fully visible for five seconds" in hud and
        "coopLivesShownUntil - 1000" in hud and
        "mpInfo->SetAlpha(alpha)" in hud,
        "top lives indicator holds five seconds then fades")
require("lives <= 1" in hud and "color.g = 32" in hud and 'LIVES %d/%d' in hud and '"OUT OF LIVES"' in hud,
        "critical life count flashes red and remains represented on the respawn display")
require("coopRespawnOriginalColor" in hud and "respawnText->color.g = 32" in hud and
        "localPlayer = gameLocal.GetLocalPlayer()" in multiplayer,
        "respawn warning flashes red while the local player's top HUD counter stays visible")
require("page = PAGE_HOME;\n        coopFlow = false;\n        pendingAction = MP_PENDING_NONE;" in menu,
        "reopening multiplayer without a room resets to the first page")
require("ASYNC_PROTOCOL_MAJOR 6" in (ENGINE / "framework/Licensee.h").read_text(encoding="utf-8") and
        "gameProtocol: 6" in client and "[undefined, 6]" in relay,
        "new player snapshot layout rejects cached older browser peers")

print("Co-op lives source contract passed; runtime and visual acceptance is still required.")

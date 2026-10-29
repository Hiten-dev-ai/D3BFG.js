#!/usr/bin/env python3
"""Guard authoritative join/leave delivery through the native chat event path."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "engine" / "chocolate-doom3-bfg" / "neo" / "d3xp"

mp_header = (ENGINE / "MultiplayerGame.h").read_text(encoding="utf-8")
mp = (ENGINE / "MultiplayerGame.cpp").read_text(encoding="utf-8")
network = (ENGINE / "Game_network.cpp").read_text(encoding="utf-8")


def function_body(source: str, signature: str) -> str:
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 1
    cursor = opening + 1
    while depth:
        if source[cursor] == "{":
            depth += 1
        elif source[cursor] == "}":
            depth -= 1
        cursor += 1
    return source[opening:cursor]


spawn = function_body(mp, "void idMultiplayerGame::SpawnPlayer(int clientNum)")

assert "MSG_LEFTGAME,\n        MSG_JOINEDGAME,\n        MSG_COUNT" in mp_header
assert "if (!common->IsClient() && common->IsMultiplayer()) {\n        PrintMessageEvent(MSG_JOINEDGAME, clientNum);" in spawn
assert "else if (!common->IsMultiplayer())" in spawn and "AddChatLine(idLocalization::GetString(\"#str_07177\")" in spawn
assert 'case MSG_JOINEDGAME:' in mp and 'GetString("#str_07177")' in mp
assert 'case MSG_LEFTGAME:' in mp and 'GetString("#str_11604")' in mp
assert "SendReliable(GAME_RELIABLE_MESSAGE_DB, outMsg, false)" in mp
assert "case GAME_RELIABLE_MESSAGE_DB:" in network and "mpGame.PrintMessageEvent(msg_evt, parm1, parm2)" in network
print("Join/leave notices use the authoritative reliable chat event; native chat styling is unchanged.")

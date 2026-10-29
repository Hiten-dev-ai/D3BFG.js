#!/usr/bin/env python3
"""Keep browser map-exit and multiplayer-load wait timings in engine traces."""

from pathlib import Path


root = Path(__file__).resolve().parents[1]
source = (root / "engine/chocolate-doom3-bfg/neo/framework/Common_load.cpp").read_text(encoding="utf-8")

assert "UnloadMap MapShutdown returned elapsed=%d ms" in source
assert "UnloadMap archive release returned elapsed=%d ms total=%d ms" in source
assert "LoadingFinished notify returned elapsed=%d ms state=%d" in source
assert "LoadingFinished wait returned elapsed=%d ms pumps=%d state=%d" in source
assert "++webLoadingWaitPumps;" in source

print("Browser map shutdown, archive cleanup, LoadingFinished notify and wait timings are present.")

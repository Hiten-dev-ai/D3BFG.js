"""Snapshot the complete engine adaptation without staging or changing source.

The engine remains a pinned submodule. This patch supports applying the complete
browser port to that clean revision; the small patches remain useful history.
"""
from pathlib import Path
import difflib
import subprocess

root = Path(__file__).resolve().parent.parent
engine = root / "engine/chocolate-doom3-bfg"


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(engine), *args])


patch = git("diff", "HEAD", "--binary", "--no-ext-diff")
for raw_path in git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0"):
    if not raw_path:
        continue
    path = raw_path.decode("utf-8")
    if not path.startswith("neo/") or Path(path).suffix not in {".cpp", ".h"}:
        raise SystemExit(f"Review untracked engine path before including it: {path}")
    source = (engine / path).read_text(encoding="utf-8").splitlines(keepends=True)
    if source and not source[-1].endswith("\n"):
        source[-1] += "\n"
    patch += f"diff --git a/{path} b/{path}\nnew file mode 100644\n".encode()
    patch += "".join(difflib.unified_diff([], source, fromfile="/dev/null", tofile=f"b/{path}")).encode()

destination = root / "patches/chocolate-doom3-bfg/browser-port-complete.patch"
destination.write_bytes(patch)
print(f"Updated {destination.name}: {len(patch):,} bytes, base {git('rev-parse', 'HEAD').decode().strip()}")

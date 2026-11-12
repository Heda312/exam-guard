"""Check how Docker Compose resolves build contexts in the Portainer stacks.

Docker Compose resolves a relative ``build.context`` against the directory that
contains the compose file. That matters for Portainer's "Repository" build
method: if the compose file lives in ``deploy/`` and uses ``context: ..``, the
build context is the repo root only as long as Portainer runs compose from that
file's directory.

This script prints the resolved paths so the risk is visible, and flags any
context that escapes the repository root.
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]

FILES = [
    ROOT / "docker-compose.yml",
    ROOT / "deploy" / "portainer-stack.yml",
    ROOT / "portainer-build-stack.yml",
]


def main() -> int:
    failures = 0
    for compose_file in FILES:
        if not compose_file.exists():
            print(f"[SKIP] {compose_file.name} not found")
            continue
        data = yaml.safe_load(compose_file.read_text(encoding="utf-8"))
        base = compose_file.parent
        rel = compose_file.relative_to(ROOT)
        print(f"\n== {rel} ==")
        for name, service in (data.get("services") or {}).items():
            build = service.get("build")
            if not build:
                print(f"  {name:4} (image only)")
                continue
            context = build.get("context", ".")
            resolved = (base / context).resolve()
            inside = resolved == ROOT or ROOT in resolved.parents
            dockerfile = build.get("dockerfile", "Dockerfile")
            dockerfile_path = resolved / dockerfile
            exists = dockerfile_path.exists()
            ok = inside and exists
            failures += 0 if ok else 1
            status = "PASS" if ok else "FAIL"
            print(f"  [{status}] {name:4} context={context!r} -> {resolved}")
            print(f"         dockerfile={dockerfile} exists={exists} inside_repo={inside}")
    print()
    if failures:
        print(f"{failures} build context(s) are problematic")
        return 1
    print("all build contexts resolve inside the repo and point at a real Dockerfile")
    return 0


if __name__ == "__main__":
    sys.exit(main())

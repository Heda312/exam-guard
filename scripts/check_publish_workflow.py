"""Sanity-check the GHCR publish workflow.

Validates the YAML shape and the important guarantees: both images are built,
both architectures are published, and the registry login uses GITHUB_TOKEN.
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "publish-images.yml"


def main() -> int:
    raw = WORKFLOW.read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    failures = 0

    def check(label: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        if not ok:
            failures += 1
        print(f"[{'PASS' if ok else 'FAIL'}] {label}{f' — {detail}' if detail else ''}")

    # `on:` is parsed as the boolean True by YAML 1.1 loaders; accept both.
    triggers = data.get("on") or data.get(True) or {}
    check("workflow has triggers", bool(triggers), str(list(triggers)))
    check("runs on push to master", "master" in str(triggers.get("push", {})))
    check("supports manual dispatch", "workflow_dispatch" in triggers)

    job = data["jobs"]["publish"]
    check("job requests packages: write", job["permissions"]["packages"] == "write")

    matrix = job["strategy"]["matrix"]["include"]
    dockerfiles = {entry["dockerfile"] for entry in matrix}
    check("builds the API Dockerfile", "Dockerfile" in dockerfiles, str(sorted(dockerfiles)))
    check("builds the web Dockerfile", "web.Dockerfile" in dockerfiles)
    check("matrix has 2 images", len(matrix) == 2, str(len(matrix)))

    steps = job["steps"]
    names = [step.get("name", "") for step in steps]
    for required in ("Checkout", "Set up Buildx", "Log in to GHCR", "Build and push"):
        check(f"step present: {required}", required in names)

    build = next(step for step in steps if step.get("name") == "Build and push")
    with_ = build["with"]
    check("pushes to the registry", with_.get("push") is True)
    check(
        "publishes amd64 + arm64",
        with_.get("platforms") == "linux/amd64,linux/arm64",
        str(with_.get("platforms")),
    )
    check("uses the matrix Dockerfile", with_.get("file") == "${{ matrix.dockerfile }}")

    login = next(step for step in steps if step.get("name") == "Log in to GHCR")
    check(
        "registry login uses GITHUB_TOKEN",
        login["with"]["password"] == "${{ secrets.GITHUB_TOKEN }}",
    )

    meta = next(step for step in steps if step.get("name") == "Derive image metadata")
    tags = meta["with"]["tags"]
    check("publishes a latest tag", "value=latest" in tags)
    check("publishes a sha tag", "type=sha" in tags)
    check("image name includes the matrix image", "${{ matrix.image }}" in meta["with"]["images"])

    print()
    if failures:
        print(f"{failures} check(s) failed")
        return 1
    print("publish workflow is valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())

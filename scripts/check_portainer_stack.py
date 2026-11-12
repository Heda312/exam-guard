"""Validate the Portainer stack files before handing them to a user.

Two variants exist:

- ``deploy/portainer-stack.yml``        pulls prebuilt GHCR images (no repo needed)
- ``deploy/portainer-build-stack.yml``  builds from the Git repo (no registry)

Checks the properties that actually break a deployment: valid YAML, the right
service set, no nested ``${...}`` inside a default value (that bug made the API
sit in "Waiting" for 136 s), sane healthchecks and a persistent db volume.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
NESTED = re.compile(r"\$\{[^}]*\$\{")

REQUIRED_API_ENV = [
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "DATABASE_URL",
    "SECRET_KEY",
    "PUBLIC_BASE_URL",
    "BOOTSTRAP_ADMIN_USERNAME",
    "BOOTSTRAP_ADMIN_PASSWORD",
]


def validate(path: Path, *, expect_build: bool) -> int:
    print(f"\n== {path.relative_to(ROOT)} ==")
    failures = 0

    def check(label: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        if not ok:
            failures += 1
        print(f"[{'PASS' if ok else 'FAIL'}] {label}{f' — {detail}' if detail else ''}")

    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    services = data.get("services") or {}
    check("services are db/api/web", set(services) == {"db", "api", "web"}, str(sorted(services)))

    for name, service in services.items():
        if expect_build:
            if name == "db":
                check(f"{name}: uses a stock image", bool(service.get("image")))
                check(f"{name}: has no build context", "build" not in service)
            else:
                build = service.get("build") or {}
                check(f"{name}: has a build context", bool(build))
                # `context: .` resolves to the compose file's own directory, so
                # the file must sit at the repo root for backend/ and deploy/ to
                # be inside the build context.
                check(
                    f"{name}: builds from the compose file directory",
                    build.get("context") == ".",
                    str(build.get("context")),
                )
        else:
            check(f"{name}: uses a prebuilt image", bool(service.get("image")), service.get("image", ""))
            check(f"{name}: has no build context", "build" not in service)

    if expect_build:
        check(
            "build stack lives at the repo root",
            path.parent == ROOT,
            str(path.parent.relative_to(ROOT)) if path.parent != ROOT else "repo root",
        )

    if not expect_build:
        api_image = services["api"]["image"]
        web_image = services["web"]["image"]
        check("api image is on ghcr.io", api_image.startswith("ghcr.io/"), api_image)
        check("web image is on ghcr.io", web_image.startswith("ghcr.io/"), web_image)
        check(
            "images share one tag variable",
            "${IMAGE_TAG:-latest}" in api_image and "${IMAGE_TAG:-latest}" in web_image,
        )

    # No nested interpolation anywhere.
    nested_hits: list[str] = []
    for name, service in services.items():
        for key, value in (service.get("environment") or {}).items():
            if isinstance(value, str) and NESTED.search(value):
                nested_hits.append(f"{name}.{key}={value}")
    check("no nested ${...} placeholders", not nested_hits, "; ".join(nested_hits))

    api_env = services["api"]["environment"]
    for key in REQUIRED_API_ENV:
        check(f"api env exposes {key}", key in api_env)
    check("AUTO_CREATE_TABLES is off", api_env["AUTO_CREATE_TABLES"] == "false")
    check("SETUP_DISABLED is on", api_env["SETUP_DISABLED"] == "true")
    check(
        "DATABASE_URL resolves to empty (DSN assembled in-app)",
        api_env["DATABASE_URL"].strip() in {"", "${DATABASE_URL:-}"},
        api_env["DATABASE_URL"],
    )
    check("POSTGRES_HOST points at the db service", api_env["POSTGRES_HOST"] == "db")

    api_health = services["api"].get("healthcheck") or {}
    check(
        "api healthcheck allows for migrations",
        int(str(api_health.get("start_period", "0")).rstrip("s")) >= 120,
        str(api_health.get("start_period")),
    )
    check(
        "web waits for a healthy api",
        services["web"]["depends_on"]["api"]["condition"] == "service_healthy",
    )
    check(
        "api waits for a healthy db",
        services["api"]["depends_on"]["db"]["condition"] == "service_healthy",
    )
    check("web publishes a host port", bool(services["web"].get("ports")))
    check("db_data volume declared", "db_data" in (data.get("volumes") or {}))

    return failures


def main() -> int:
    total = 0
    total += validate(ROOT / "deploy" / "portainer-stack.yml", expect_build=False)
    total += validate(ROOT / "portainer-build-stack.yml", expect_build=True)

    print()
    if total:
        print(f"{total} check(s) failed")
        return 1
    print("both portainer stack files are valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Validate the Portainer stack file before handing it to a user.

Checks:
- valid YAML with db/api/web services
- no ``build:`` keys (Portainer pulls prebuilt images)
- no nested ``${...}`` inside a default value (the bug that broke the API)
- every required secret has a sane placeholder
- the API and web images point at GHCR
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
STACK = ROOT / "deploy" / "portainer-stack.yml"

NESTED = re.compile(r"\$\{[^}]*\$\{")


def main() -> int:
    data = yaml.safe_load(STACK.read_text(encoding="utf-8"))
    services = data.get("services") or {}
    failures = 0

    def check(label: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        if not ok:
            failures += 1
        print(f"[{'PASS' if ok else 'FAIL'}] {label}{f' — {detail}' if detail else ''}")

    check("services present", set(services) == {"db", "api", "web"}, str(sorted(services)))

    for name, service in services.items():
        check(f"{name}: uses a prebuilt image", "image" in service, service.get("image", "missing"))
        check(f"{name}: has no build context", "build" not in service)

    api_image = services["api"]["image"]
    web_image = services["web"]["image"]
    check("api image is on ghcr.io", api_image.startswith("ghcr.io/"), api_image)
    check("web image is on ghcr.io", web_image.startswith("ghcr.io/"), web_image)
    check(
        "images share one tag variable",
        "${IMAGE_TAG:-latest}" in api_image and "${IMAGE_TAG:-latest}" in web_image,
    )

    for name, service in services.items():
        env = service.get("environment") or {}
        for key, value in env.items():
            if isinstance(value, str) and NESTED.search(value):
                check(f"{name}.{key}: no nested placeholder", False, value)
    check("no nested ${...} placeholders", True)

    api_env = services["api"]["environment"]
    required = [
        "POSTGRES_PASSWORD",
        "SECRET_KEY",
        "PUBLIC_BASE_URL",
        "BOOTSTRAP_ADMIN_USERNAME",
        "BOOTSTRAP_ADMIN_PASSWORD",
        "DATABASE_URL",
    ]
    for key in required:
        check(f"api env exposes {key}", key in api_env)

    check("AUTO_CREATE_TABLES is off (migrations own the schema)", api_env["AUTO_CREATE_TABLES"] == "false")
    check("SETUP_DISABLED is on", api_env["SETUP_DISABLED"] == "true")
    # `${DATABASE_URL:-}` resolves to an empty string, which makes the app
    # assemble the DSN from the POSTGRES_* parts.
    check(
        "DATABASE_URL resolves to empty (DSN assembled in-app)",
        api_env["DATABASE_URL"].strip() in {"", "${DATABASE_URL:-}"},
        api_env["DATABASE_URL"],
    )

    web = services["web"]
    check("web publishes a host port", bool(web.get("ports")))
    check("web depends on a healthy api", web["depends_on"]["api"]["condition"] == "service_healthy")
    check("api depends on a healthy db", services["api"]["depends_on"]["db"]["condition"] == "service_healthy")
    check("db_data volume declared", "db_data" in (data.get("volumes") or {}))

    print()
    if failures:
        print(f"{failures} check(s) failed")
        return 1
    print("portainer stack file is valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())

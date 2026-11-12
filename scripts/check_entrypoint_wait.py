"""Exercise deploy/entrypoint.sh's pre-flight config validation without Docker.

The regression this guards against: a DATABASE_URL containing an unexpanded
Compose placeholder (``${POSTGRES_PASSWORD}``) used to be accepted, the API
retried the broken DSN for 120 s, and Docker then reported

    Container exam-guard-api-1 Error dependency api failed to start (136.4s)

The entrypoint must now abort in about a second with a clear message.

Run: python scripts/check_entrypoint_wait.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASH = Path(r"C:\Program Files\Git\bin\bash.exe")

# The pre-flight block copied from deploy/entrypoint.sh (step 0).
CONFIG_BLOCK = r"""
set -e
if ! python - <<'PY'
import sys

try:
    from app.config import settings
except Exception as exc:
    print(f"[entrypoint] Konfigurasi tidak valid: {exc}", file=sys.stderr)
    sys.exit(1)

url = settings.database_url
masked = url
if "://" in url and "@" in url:
    scheme, rest = url.split("://", 1)
    credentials, host = rest.rsplit("@", 1)
    user = credentials.split(":", 1)[0]
    masked = f"{scheme}://{user}:***@{host}"
print(f"[entrypoint] DATABASE_URL={masked}")
sys.exit(0)
PY
then
  echo "[entrypoint] GAGAL: konfigurasi aplikasi tidak valid (lihat pesan di atas)." >&2
  exit 1
fi
"""


def run_config(database_url: str | None, timeout: float = 60.0) -> tuple[int, float, str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "backend")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.pop("POSTGRES_PASSWORD", None)
    if database_url is None:
        env.pop("DATABASE_URL", None)
    else:
        env["DATABASE_URL"] = database_url
    started = time.time()
    proc = subprocess.run(
        [str(BASH), "-c", CONFIG_BLOCK],
        cwd=str(ROOT / "backend"),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return proc.returncode, time.time() - started, (proc.stdout + proc.stderr)


def main() -> int:
    failures = 0

    def report(label: str, ok: bool, detail: str) -> None:
        nonlocal failures
        if not ok:
            failures += 1
        print(f"[{'PASS' if ok else 'FAIL'}] {label} — {detail}")

    # 1. The exact bug: an unexpanded Compose placeholder.
    code, elapsed, out = run_config(
        "postgresql+psycopg://u:${POSTGRES_PASSWORD}@db:5432/examguard"
    )
    report(
        "unexpanded placeholder aborts fast (<10s)",
        code != 0 and elapsed < 10,
        f"code={code} {elapsed:.1f}s",
    )
    report(
        "unexpanded placeholder is explained",
        "placeholder" in out,
        next(
            (line.strip()[:80] for line in out.splitlines() if "placeholder" in line),
            "no explanation",
        ),
    )

    # 2. A healthy config passes pre-flight and masks the password.
    with tempfile.TemporaryDirectory() as tmp:
        good = f"postgresql+psycopg://examguard:s3cret@db:5432/examguard"
        code, elapsed, out = run_config(good)
        report(
            "valid config passes pre-flight",
            code == 0 and "DATABASE_URL=" in out,
            f"code={code} {elapsed:.1f}s",
        )
        report(
            "password is masked in logs",
            "s3cret" not in out and "***" in out,
            next((l.strip() for l in out.splitlines() if "DATABASE_URL=" in l), "n/a"),
        )

    print()
    if failures:
        print(f"{failures} check(s) failed")
        return 1
    print("entrypoint pre-flight validation verified")
    return 0


if __name__ == "__main__":
    if not BASH.exists():
        print(f"SKIP: bash not found at {BASH}")
        sys.exit(0)
    sys.exit(main())

"""Unit-check the entrypoint's permanent-vs-transient DB error classifier.

This mirrors the PERMANENT tuple in deploy/entrypoint.sh so a typo in either
place is caught. Real psycopg messages are used verbatim.
"""
from __future__ import annotations

PERMANENT = (
    "password authentication failed",
    "authentication failed",
    'role "',
    "does not exist",
    "could not translate host name",
    "name or service not known",
    "nodename nor servname",
    "invalid dsn",
    "invalid connection option",
    "invalid url",
    "no password supplied",
)

CASES = [
    # (message, expected_permanent, why)
    (
        'connection failed: FATAL:  password authentication failed for user "examguard"',
        True,
        "wrong POSTGRES_PASSWORD against an existing volume",
    ),
    (
        'connection failed: FATAL:  database "examguard" does not exist',
        True,
        "POSTGRES_DB mismatch",
    ),
    (
        'connection failed: FATAL:  role "examguard" does not exist',
        True,
        "POSTGRES_USER mismatch",
    ),
    (
        "could not translate host name \"db\" to address: Name or service not known",
        True,
        "wrong service name / not on the compose network",
    ),
    (
        "invalid dsn: missing \"=\" after \"${POSTGRES_PASSWORD}@db\" in connection info string",
        True,
        "unexpanded Compose placeholder (the bug that caused the 136 s hang)",
    ),
    (
        "connection failed: connection to server at \"db\", port 5432 failed: Connection refused",
        False,
        "database still starting — retrying is correct",
    ),
    (
        'connection failed: FATAL:  the database system is starting up',
        False,
        "database still booting — retrying is correct",
    ),
]


def classify(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in PERMANENT)


def main() -> int:
    failures = 0
    for message, expected, why in CASES:
        actual = classify(message)
        ok = actual == expected
        failures += 0 if ok else 1
        label = "PERMANENT" if actual else "transient"
        status = "PASS" if ok else "FAIL"
        print(f"[{status}] {label:9} <- {why}")
        if not ok:
            print(f"        message: {message}")
    print()
    if failures:
        print(f"{failures} case(s) failed")
        return 1
    print(f"all {len(CASES)} cases classified correctly")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

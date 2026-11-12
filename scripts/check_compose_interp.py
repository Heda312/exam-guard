"""Simulate Docker Compose variable interpolation.

Compose expands `${VAR}` / `${VAR:-default}` in a single non-recursive pass: the
first `}` terminates the expression, so a nested `${...}` inside a default value
leaks literal text into the result. This script proves what the API container
actually receives.
"""


def interp(value: str, env: dict[str, str]) -> str:
    out: list[str] = []
    i = 0
    while i < len(value):
        if value.startswith("${", i):
            end = value.find("}", i)
            if end == -1:
                out.append(value[i:])
                break
            expr = value[i + 2 : end]
            if ":-" in expr:
                name, default = expr.split(":-", 1)
                out.append(env.get(name) or default)
            else:
                out.append(env.get(expr, ""))
            i = end + 1
        else:
            out.append(value[i])
            i += 1
    return "".join(out)


ENV = {"POSTGRES_PASSWORD": "secret123"}

NESTED = (
    "${DATABASE_URL:-postgresql+psycopg://${POSTGRES_USER:-examguard}:"
    "${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB:-examguard}}"
)
FLAT = (
    "postgresql+psycopg://${POSTGRES_USER:-examguard}:"
    "${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB:-examguard}"
)

print("NESTED  ->", interp(NESTED, ENV))
print()
print("FLAT    ->", interp(FLAT, ENV))

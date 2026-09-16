#!/bin/sh
set -eu

fail() {
    printf '%s\n' "$1" >&2
    exit 1
}

if [ "${APP_ENVIRONMENT:-development}" = 'production' ]; then
    PORT=${PORT:-}
else
    PORT=${PORT:-8000}
fi

case "$PORT" in
    ''|*[!0-9]*)
        fail 'Backend startup aborted: invalid PORT.'
        ;;
esac

if [ "${#PORT}" -gt 5 ] || [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
    fail 'Backend startup aborted: invalid PORT.'
fi

if ! python - <<'PY' >/dev/null 2>&1
from alembic.config import Config
from alembic.script import ScriptDirectory

from app.core.config import Settings

settings = Settings()
if settings.app_environment == "production":
    repository_heads = tuple(
        ScriptDirectory.from_config(Config("alembic.ini")).get_heads()
    )
    if repository_heads != (settings.expected_alembic_head,):
        raise SystemExit(1)
PY
then
    fail 'Backend startup aborted: configuration preflight failed.'
fi

if ! python -m alembic current --check-heads >/dev/null 2>&1; then
    fail 'Backend startup aborted: database revision check failed.'
fi

exec python -m uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "$PORT" \
    --workers 1 \
    --no-proxy-headers \
    --no-server-header

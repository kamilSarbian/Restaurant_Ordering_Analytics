# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

FROM python:3.12-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134 AS dependencies

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

COPY requirements.lock /tmp/requirements.lock
RUN python -m pip install \
        --isolated \
        --no-cache-dir \
        --only-binary=:all: \
        --require-hashes \
        --requirement /tmp/requirements.lock \
    && python -m pip check


FROM python:3.12-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134 AS runtime

ENV HOME=/tmp \
    PATH="/opt/venv/bin:${PATH}" \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN groupadd --gid 10001 app \
    && useradd \
        --uid 10001 \
        --gid 10001 \
        --no-create-home \
        --home-dir /nonexistent \
        --shell /usr/sbin/nologin \
        app

WORKDIR /opt/restaurant/backend

COPY --from=dependencies /opt/venv /opt/venv
COPY app ./app
COPY alembic/env.py ./alembic/env.py
COPY alembic/versions ./alembic/versions
COPY alembic.ini ./alembic.ini
COPY --chmod=0555 start-backend.sh /usr/local/bin/start-backend
COPY --chmod=0555 run-migrations.sh /usr/local/bin/run-migrations

RUN /bin/sh -n /usr/local/bin/start-backend \
    && /bin/sh -n /usr/local/bin/run-migrations

USER 10001:10001

EXPOSE 8000
STOPSIGNAL SIGTERM

CMD ["/usr/local/bin/start-backend"]

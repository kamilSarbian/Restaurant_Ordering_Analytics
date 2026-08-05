# Restaurant Ordering & Analytics System

## Current status

Stage 3 is complete. The repository contains a verified FastAPI and database
foundation with application settings, a process-level health endpoint,
PostgreSQL 17 local development infrastructure, synchronous SQLAlchemy 2,
Psycopg 3, Alembic, and automated health and database connection tests.

Business database models, business features, Stripe integration, frontend,
full-system containerisation, CI, and deployment have not started.

## Business problem

A small restaurant needs one coherent system for digital menu presentation,
guest ordering, payment processing, order fulfilment, and basic sales analysis.
The planned application will keep operational and analytical data consistent
without introducing infrastructure that is unnecessary for a single venue.

## Implemented foundation

- FastAPI application factory configured through `pydantic-settings`.
- `GET /health` process health endpoint with a stable JSON contract.
- Automated endpoint test using `pytest` and `TestClient`.
- Minimal Docker Compose service using PostgreSQL 17.
- Synchronous SQLAlchemy engine and session factories using Psycopg 3.
- Alembic environment with a non-destructive baseline migration.
- Live local PostgreSQL connection test using `SELECT 1`.
- Ruff, Black, and isort quality configuration.

## Technology status

- Implemented: Python 3.12, FastAPI, Pydantic 2, PostgreSQL 17, SQLAlchemy 2,
  Alembic, Psycopg 3, Docker Compose, pytest, Ruff, Black, and isort.
- Planned: React, TypeScript, Vite, Stripe Checkout, full-system containers,
  GitHub Actions, and deployment.

## Repository structure

```text
.
├── backend/
│   ├── alembic/
│   ├── app/
│   │   ├── api/
│   │   ├── core/
│   │   ├── database/
│   │   └── main.py
│   ├── tests/
│   ├── alembic.ini
│   └── pyproject.toml
├── docs/
├── frontend/      # Placeholder for a later stage
├── compose.yaml
├── AGENTS.md
└── README.md
```

## Local backend setup

Python 3.12 is required. From the repository root in PowerShell, create the
virtual environment and install the backend with development dependencies:

```powershell
$python312 = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
& $python312 -m venv backend\.venv
$venvPython = (Resolve-Path "backend\.venv\Scripts\python.exe").Path
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -e "backend[dev]"
```

The commands use the virtual environment interpreter directly and do not require
environment activation.

## Local PostgreSQL and migrations

Docker Desktop, or another Docker Engine compatible with Linux containers and
Docker Compose, is required. Local development uses the official
`postgres:17-alpine` image. PostgreSQL listens on port 5432 inside the
container and is published on Windows host port 5433. Host port 5433 was chosen
because a local PostgreSQL 18 installation already uses host port 5432.

From the repository root, copy the environment template:

```powershell
Copy-Item .env.example .env
```

Set a strong local `POSTGRES_PASSWORD` in `.env`, then set `DATABASE_URL` to a
matching Psycopg 3 URL. Keep the database name, user, password, and host port
consistent. The `.env` file is ignored by Git and must never be committed.

Start PostgreSQL and inspect its health status from the repository root:

```powershell
docker compose --env-file .env up -d postgres
docker compose --env-file .env ps postgres
```

After the service reports `healthy`, run the live connection test from the
`backend` directory:

```powershell
& .\.venv\Scripts\python.exe -m pytest `
    tests\integration\test_database_connection.py `
    -m integration
```

Run Alembic from the `backend` directory:

```powershell
& .\.venv\Scripts\python.exe -m alembic upgrade head
& .\.venv\Scripts\python.exe -m alembic current
& .\.venv\Scripts\python.exe -m alembic downgrade base
```

Return to the repository root and stop the local database without removing its
named volume:

```powershell
docker compose --env-file .env down
```

Warning: `docker compose down -v` also deletes the named PostgreSQL volume and
its local data. Do not use `-v` unless data deletion is intentional.

Stage 3 provides database infrastructure only. Business models and business
tables are not implemented yet.

## Tests and quality checks

Run these commands from the `backend` directory:

```powershell
& .\.venv\Scripts\python.exe -m pytest
& .\.venv\Scripts\python.exe -m ruff check .
& .\.venv\Scripts\python.exe -m black --check .
& .\.venv\Scripts\python.exe -m isort --check-only .
```

## Run the development server

From the `backend` directory, start Uvicorn without auto-reload:

```powershell
& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Available endpoints:

- Health: <http://127.0.0.1:8000/health>
- Swagger UI: <http://127.0.0.1:8000/docs>
- OpenAPI document: <http://127.0.0.1:8000/openapi.json>

## Project documentation

- [Project Context](docs/PROJECT_CONTEXT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Architectural Decisions](docs/DECISIONS.md)
- [Implementation Status](docs/IMPLEMENTATION_STATUS.md)

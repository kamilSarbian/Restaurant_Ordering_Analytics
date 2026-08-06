# Restaurant Ordering & Analytics System

## Current status

Stage 5 is complete. The repository contains a verified FastAPI and menu data
foundation with application settings, a process-level health endpoint,
PostgreSQL 17 local development infrastructure, synchronous SQLAlchemy 2,
Psycopg 3, Alembic, menu models, and an explicit local demonstration seed.

Public menu APIs, order and payment features, Stripe integration, frontend,
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
- Category and MenuItem models with a reversible menu schema migration.
- Explicit local-only demonstration seed with fixed UUIDs and idempotent
  PostgreSQL upserts.
- Isolated PostgreSQL integration tests for models, constraints, and migration
  upgrades, downgrades, seed idempotency, and data protection.
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
│   │   ├── seed/
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

Stage 4 adds migration `0002_create_menu_models`. It creates `categories` and
`menu_items`; it does not add seed data or a menu API.

## Menu data foundation

Category and MenuItem use application-generated UUID primary keys. Prices and
optional costs are integer minor units: `price_amount` must be positive, while
`cost_amount` may be unknown or a non-negative value. Currency is an explicit
three-letter uppercase code with `NOK` as the default.

MenuItem allergens use PostgreSQL `TEXT[]` and SQLAlchemy `MutableList`, so
in-place list changes are tracked. `is_active` controls long-term visibility,
while `is_available` independently controls temporary sellability. Category
deletion is restricted while related items exist. Functional indexes enforce
case-insensitive and trim-insensitive names using `lower(btrim(name))`.

Data-changing integration tests use only the isolated local database
`restaurant_ordering_analytics_test` on host port 5433. `TEST_DATABASE_URL` may
be set explicitly, or the tests derive it in memory from the validated
development URL by changing only the database name. The test lifecycle rejects
remote hosts, port 5432, and the development database before any destructive
operation. It upgrades an empty database, downgrades to the baseline, upgrades
again, and removes only the test database afterward.

From the `backend` directory, run the model tests with:

```powershell
& .\.venv\Scripts\python.exe -m pytest tests\integration\test_menu_models.py
```

The PostgreSQL container must be running and healthy on host port 5433. Stop it
with `docker compose --env-file .env down` after testing. Never use
`docker compose down -v` unless deleting the named database volume is
intentional.

## Local demonstration seed

Stage 5 provides a controlled dataset for local development and portfolio
demonstrations. It contains five categories and fifteen menu items with fixed
UUIDs. The public menu API does not exist yet.

Start the PostgreSQL service through Docker Compose and apply migrations before
running the seed. From the `backend` directory, with the project virtual
environment active, execute:

```powershell
python -m app.seed
```

On Windows, the command can also use the virtual environment interpreter
directly without activation:

```powershell
& .\.venv\Scripts\python.exe -m app.seed
```

The command is local-only. It accepts only the exact
`restaurant_ordering_analytics_dev` database through the PostgreSQL Psycopg
driver on `localhost` or `127.0.0.1` and host port 5433. It rejects remote,
administrative, test, and alternative database targets before creating a
database engine. It is not a production bootstrap mechanism.

Seed records use deterministic primary-key upserts. Rerunning the command
restores every canonical field owned by the fixed seed UUIDs, preserves
`created_at`, and leaves `updated_at` unchanged when no value differs. A rerun
therefore overwrites manual changes to seed-owned records and recreates a
seed-owned record that was deleted.

The seed does not use `DELETE` or `TRUNCATE`, does not claim records by name,
and does not modify unrelated categories or menu items. A normalized-name
conflict with another UUID aborts the complete transaction. Imports,
application startup, `/health`, migrations, Docker Compose startup, CI, and
deployment never run the seed automatically.

Run all seed and regression tests from the `backend` directory:

```powershell
& .\.venv\Scripts\python.exe -m pytest
```

The PostgreSQL container must be available on host port 5433 for integration
tests. Stop it afterward with `docker compose --env-file .env down`. Never use
`docker compose down -v` unless permanent removal of the local PostgreSQL
volume and its data is intentional.

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

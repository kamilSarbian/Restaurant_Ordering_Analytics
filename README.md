# Restaurant Ordering & Analytics System

## Current status

Stage 2 is complete. The repository contains a verified FastAPI foundation with
application settings, an application factory, a process-level health endpoint,
and an automated health endpoint test.

The database, business features, Stripe integration, frontend, containerisation,
CI, and deployment have not started.

## Business problem

A small restaurant needs one coherent system for digital menu presentation,
guest ordering, payment processing, order fulfilment, and basic sales analysis.
The planned application will keep operational and analytical data consistent
without introducing infrastructure that is unnecessary for a single venue.

## Implemented foundation

- FastAPI application factory configured through `pydantic-settings`.
- `GET /health` process health endpoint with a stable JSON contract.
- Automated endpoint test using `pytest` and `TestClient`.
- Ruff, Black, and isort quality configuration.

## Technology status

- Implemented: Python 3.12, FastAPI, Pydantic 2, pytest, Ruff, Black, and isort.
- Planned: PostgreSQL, SQLAlchemy 2, Alembic, React, TypeScript, Vite, Stripe
  Checkout, Docker, GitHub Actions, and deployment.

## Repository structure

```text
.
├── backend/
│   ├── app/
│   │   ├── api/
│   │   ├── core/
│   │   └── main.py
│   ├── tests/
│   └── pyproject.toml
├── docs/
├── frontend/      # Placeholder for a later stage
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

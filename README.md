# Restaurant Ordering & Analytics System

## Current status

Application implementation has not started. Only project documentation and the
initial repository structure currently exist.

## Business problem

A small restaurant needs one coherent system for digital menu presentation,
guest ordering, payment processing, order fulfilment, and basic sales analysis.
The planned application will keep operational and analytical data consistent
without introducing infrastructure that is unnecessary for a single venue.

## Project goal

The goal is to build a secure, testable portfolio application that demonstrates
backend development, relational data modelling, payment integration, frontend
development, analytics, containerisation, and deployment. All application
features remain planned and are not yet implemented.

## Planned technology stack

- Backend: Python 3.12, FastAPI, Pydantic 2, SQLAlchemy 2, and Alembic.
- Database: PostgreSQL.
- Frontend: React, TypeScript, Vite, React Router, and Recharts.
- Payments: Stripe Checkout and verified Stripe webhooks in test mode.
- Quality: pytest, Ruff, Black, and isort.
- Infrastructure: Docker, Docker Compose, GitHub Actions, and demo deployment.

## Planned repository structure

```text
.
├── backend/       # Planned backend application
├── frontend/      # Planned frontend application
├── docs/          # Project context, architecture, decisions, roadmap, and status
├── AGENTS.md      # Repository-wide working rules
└── README.md
```

The `backend` and `frontend` directories currently contain placeholders only.

## Implementation status

- Documentation: completed.
- Repository initialisation: completed after Stage 1 verification.
- Backend, frontend, database, Stripe, application tests, and deployment: not
  started.
- Next stage: waiting for explicit approval.

See [Implementation Status](docs/IMPLEMENTATION_STATUS.md) for the current
stage record.

## Project documentation

- [Project Context](docs/PROJECT_CONTEXT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Architectural Decisions](docs/DECISIONS.md)
- [Implementation Status](docs/IMPLEMENTATION_STATUS.md)

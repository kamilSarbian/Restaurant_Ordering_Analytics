# Implementation Status

- **Documentation:** completed
- **Stage 1:** completed
- **Stage 2:** completed
- **Stage 3:** completed
- **Stage 4:** completed
- **Stage 5:** completed
- **Stage 6:** completed
- **Current stage:** waiting for approval to start Stage 7
- **Backend:** FastAPI, database foundation, menu models, local seed data, and
  the read-only public menu API completed
- **Frontend:** not started
- **Database:** PostgreSQL, Alembic, menu models, and deterministic seed
  completed
- **Seed data:** completed and verified
- **Public menu API:** list, availability filter, item details, and 404 contract
  completed and verified
- **Menu write API:** not started
- **Order quoting:** not started
- **Stripe:** not started
- **Application tests:** 172 health, database, migration, model, constraint,
  seed, schema, public API, idempotency, and data-protection tests completed
- **Deployment:** not started

## Known limitations

- The backend exposes process health and read-only public menu endpoints; menu
  writes have not started.
- Authentication, order quoting, orders, payments, Stripe, and frontend work
  have not started.
- The seed is restricted to the exact local development database and is not a
  production bootstrap process.
- Full-system containerisation, continuous integration, and deployment have
  not started.

## Last verification

Stage 6 verified on 2026-08-06:

- Docker CLI 29.6.2, Docker Compose 5.3.1, and Docker Engine 29.6.2: PASS
- PostgreSQL 17 health and host-to-container mapping `5433:5432`: PASS
- Five strict public schemas and internal-field protection: 26 tests passed
- Public menu integration suite: 31 tests passed
- Visibility, `available_only`, empty results, UUID tie-breaking, and query
  count contracts 2/1/1: PASS
- List, item detail, exact 404, UUID and boolean 422, and method 405 contracts:
  PASS
- OpenAPI, `/docs`, application import, router prefix, and seed import: PASS
- Full pytest suite: 172 passed with one accepted Starlette warning
- Ruff, Black, and isort: PASS
- Alembic check reported no new upgrade operations: PASS
- Read-only development smoke: health, menu 5/15, availability filter 14,
  unavailable item detail, 404, docs, and OpenAPI: PASS
- Development counts, all seed UUIDs, business fields, `created_at`,
  `updated_at`, and unrelated-data digest remained unchanged: PASS
- Isolated test database removal and development database preservation: PASS

Stage 5 verified on 2026-08-06:

- Development database migrated additively from `0001_database_baseline` to
  `0002_create_menu_models` without changing its OID: PASS
- Exact local Psycopg driver, host, port 5433, database, and credential
  allowlist: PASS
- Empty menu tables before the first explicit seed: PASS
- Immutable dataset with 5 categories, 15 menu items, and 20 fixed UUIDs: PASS
- Local-only CLI help before Settings, Engine, connection, or runner work: PASS
- First explicit development seed: 5 categories and 15 menu items processed
- Second explicit development seed: 5 categories and 15 menu items processed
- Stable UUIDs, canonical values, `created_at`, and no-op `updated_at`: PASS
- Unrelated-record counts and deterministic digest remained unchanged: PASS
- One transaction for preflight and upsert, normalized conflict rollback,
  canonical restore, and recreation tests: PASS
- Import, FastAPI startup, health, Alembic, and Compose automatic-seed guards:
  PASS
- Full pytest suite: 115 passed with one accepted Starlette warning
- Ruff, Black, and isort: PASS
- Alembic check reported no new upgrade operations: PASS
- Seed module and FastAPI imports: PASS
- Controlled `GET /health`: HTTP 200 with exactly `{"status":"ok"}`
- Isolated test database removal and development seed preservation: PASS
- Compose shutdown without `-v`, named volume preservation, and host port 5433
  release: PASS
- Local PostgreSQL 18 listener on host port 5432 remained unchanged: PASS

Stage 4 verified on 2026-08-05:

- Docker CLI 29.6.2, Docker Compose 5.3.1, and Docker Engine 29.6.2: PASS
- Docker context `desktop-linux`, Linux engine, and Compose configuration: PASS
- PostgreSQL 17 container health, `pg_isready`, and `5433:5432` mapping: PASS
- Exact-name, local-host, Psycopg, and port guards for the test database: PASS
- Empty isolated test database creation without resetting development data: PASS
- First upgrade to `0002_create_menu_models`: PASS
- Downgrade to `0001_database_baseline` and removal of Stage 4 tables: PASS
- Second upgrade to `0002_create_menu_models`: PASS
- Exact public tables, constraints, foreign key, defaults, and four indexes: PASS
- Functional `lower(btrim(name))` and partial `is_active IS TRUE` indexes: PASS
- Alembic check reported no new upgrade operations: PASS
- Menu model integration suite: 43 passed
- MutableList append/remove persistence and `ON DELETE RESTRICT`: PASS
- Positive, negative, boundary, and normalized-uniqueness tests: PASS
- The then-current full-suite result is superseded by the Stage 5 regression
  result recorded above.
- Ruff, Black, and isort: PASS
- Model registry and FastAPI imports: PASS
- Controlled `GET /health`: HTTP 200 with exactly `{"status":"ok"}`
- Uvicorn shutdown: PASS
- Isolated test database removal and development database preservation: PASS
- Compose shutdown without `-v`, named volume preservation, and port 5433
  release: PASS
- Local PostgreSQL 18 listener on host port 5432 remained unchanged: PASS

Stage 3 foundation verification on 2026-08-05:

- Docker CLI 29.6.2, Docker Compose 5.3.1, and Docker Engine 29.6.2: PASS
- Docker context `desktop-linux` and Linux engine: PASS
- Compose configuration with the ignored local `.env`: PASS
- `postgres:17-alpine` image pull and PostgreSQL 17.10 startup: PASS
- Container health check and `pg_isready`: PASS
- Host-to-container port mapping `5433:5432`: PASS
- SQLAlchemy 2.0.51, Alembic 1.19.0, and Psycopg 3.3.4: PASS
- Real SQLAlchemy `SELECT 1` integration test: PASS
- Baseline upgrade, current, downgrade to base, and second upgrade: PASS
- Final Alembic revision `0001_database_baseline`: PASS
- Only the Alembic version table was created; no business tables: PASS
- Full pytest suite: 2 passed with one accepted Starlette warning
- Ruff checks: PASS
- Black formatting check: PASS
- isort import order check: PASS
- FastAPI application import: PASS
- Controlled Uvicorn startup and shutdown: PASS
- `GET /health` returned HTTP 200 and exactly `{"status":"ok"}`: PASS
- Compose shutdown removed the project container and network: PASS
- Named PostgreSQL volume preserved after shutdown: PASS
- Host port 5433 released after shutdown: PASS
- Existing local PostgreSQL listener on host port 5432 remained unchanged: PASS
- `git diff --check` and untracked-file whitespace checks: PASS
- Secret scan excluding the ignored local `.env`: PASS
- Canonical repository language scan: PASS
- `.env` and `backend/.venv` ignore rules: PASS
- Approved Stage 3 file scope and absence of Stage 4 files: PASS
- Git index empty, HEAD unchanged, and no remote configured: PASS

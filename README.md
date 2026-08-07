# Restaurant Ordering & Analytics System

## Current status

Stage 8 is complete. The repository contains a verified FastAPI application,
public menu and transient quote APIs, persistent guest order creation, secure
public order status retrieval, PostgreSQL 17 local development infrastructure,
synchronous SQLAlchemy 2, Psycopg 3, Alembic, and an explicit local
demonstration menu seed.

Payment models, Stripe integration, frontend, full-system containerisation,
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
- Minimal Docker Compose service using PostgreSQL 17.
- Synchronous SQLAlchemy engine and session factories using Psycopg 3.
- Alembic environment with a non-destructive baseline migration.
- Live local PostgreSQL connection test using `SELECT 1`.
- Category and MenuItem models with a reversible menu schema migration.
- Explicit local-only demonstration seed with fixed UUIDs and idempotent
  PostgreSQL upserts.
- Versioned, read-only public menu list, availability filter, and item detail
  endpoints with explicit response schemas.
- Public order quote endpoint with strict quantities, server-owned menu data,
  integer minor-unit totals, availability revalidation, and zero persistence.
- Persistent RestaurantTable, Order, OrderItem, and OrderStatusHistory models
  with migration `0003_create_order_models`.
- Transactional `POST /api/v1/orders` creation with durable snapshots,
  server-authoritative menu revalidation, shared row locks, and rollback.
- Guest order access using a public number and one-time token whose SHA-256
  hash is the only token value stored in PostgreSQL.
- Authenticated public order status retrieval without exposing internal IDs or
  token hashes.
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
```

Never run a downgrade against the development database. Migration lifecycle
tests create, downgrade, upgrade, and remove only the isolated test database.

Return to the repository root and stop the local database without removing its
named volume:

```powershell
docker compose --env-file .env down
```

Warning: `docker compose down -v` also deletes the named PostgreSQL volume and
its local data. Do not use `-v` unless data deletion is intentional.

Stage 4 adds migration `0002_create_menu_models`. Stage 8 adds the schema-only
`0003_create_order_models` migration for restaurant tables and persistent order
aggregates. Neither migration runs the seed.

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
UUIDs. Stage 6 exposes that data through the read-only public menu API.

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

## Public menu API

Stage 6 exposes two unauthenticated, read-only endpoints:

- `GET /api/v1/menu` returns active categories containing active menu items.
- `GET /api/v1/menu/items/{item_id}` returns one active item in an active
  category, or `{"detail":"Menu item not found"}` with HTTP 404.

The list uses a stable `{"categories": [...]}` envelope. By default, active
but temporarily unavailable items remain visible with `is_available=false`.
Add `available_only=true` to hide them; categories that become empty are also
omitted. Categories and their items are ordered by `display_order`, then UUID.
The detail endpoint also keeps active unavailable items visible.

An item detail response contains the public item fields and a nested `category`
object with only its `id` and `name`. For example:

```json
{
  "id": "95abd9ff-dea5-48fa-aa81-0632fb5caef7",
  "name": "Warm Apple Cake",
  "description": "Spiced apple cake with vanilla cream.",
  "image_url": null,
  "price_amount": 11900,
  "currency": "NOK",
  "allergens": ["gluten", "milk", "egg"],
  "display_order": 0,
  "is_available": false,
  "category": {
    "id": "c6396579-544d-48fc-8fdc-9d9d1383f695",
    "name": "Desserts"
  }
}
```

An active item may return HTTP 200 with `is_available=false`, which indicates
temporary unavailability. The response does not contain `cost_amount`,
timestamps, `is_active`, or a raw `category_id`. A missing item, an inactive
item, or an item in an inactive category returns HTTP 404 with
`{"detail":"Menu item not found"}`.

Prices use integer minor units, such as `12900` for `129.00 NOK`. Allergens are
JSON arrays in database order. A missing image is returned as
`"image_url": null`. Public responses never expose costs, timestamps, internal
activity fields, or raw product category identifiers. The API has no
authentication requirement and provides no menu write operations.

With Uvicorn running, example requests are:

```bash
curl http://127.0.0.1:8000/api/v1/menu
curl "http://127.0.0.1:8000/api/v1/menu?available_only=true"
curl http://127.0.0.1:8000/api/v1/menu/items/95abd9ff-dea5-48fa-aa81-0632fb5caef7
```

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/v1/menu
Invoke-RestMethod "http://127.0.0.1:8000/api/v1/menu?available_only=true"
Invoke-RestMethod http://127.0.0.1:8000/api/v1/menu/items/95abd9ff-dea5-48fa-aa81-0632fb5caef7
```

Interactive documentation is available at `/docs`, and the OpenAPI document is
available at `/openapi.json`. From `backend`, run the Stage 6 tests with:

```powershell
& .\.venv\Scripts\python.exe -m pytest tests\test_public_menu_schemas.py
& .\.venv\Scripts\python.exe -m pytest tests\integration\test_public_menu_api.py
```

## Order quoting API

Stage 7 exposes the unauthenticated
`POST /api/v1/orders/quote` endpoint. A request contains only one to fifty
unique menu item identifiers and quantities from 1 to 99:

```json
{
  "items": [
    {
      "menu_item_id": "9933957b-7f5d-47d8-84c3-ba8ad21b2d8c",
      "quantity": 2
    },
    {
      "menu_item_id": "c496b9cc-268c-4549-9e36-e8225e57561f",
      "quantity": 1
    }
  ]
}
```

Names, prices, currency, activity, and availability are read from PostgreSQL.
Client-supplied prices or currencies and duplicate identifiers are rejected
with HTTP 422. The response preserves request order and uses integer minor
units:

```json
{
  "currency": "NOK",
  "items": [
    {
      "menu_item_id": "9933957b-7f5d-47d8-84c3-ba8ad21b2d8c",
      "name": "Classic Beef Burger",
      "quantity": 2,
      "unit_price_amount": 22900,
      "line_total_amount": 45800
    },
    {
      "menu_item_id": "c496b9cc-268c-4549-9e36-e8225e57561f",
      "name": "Cloudberry Spritz",
      "quantity": 1,
      "unit_price_amount": 7900,
      "line_total_amount": 7900
    }
  ],
  "subtotal_amount": 53700,
  "total_amount": 53700
}
```

A missing, inactive, or otherwise non-public item returns HTTP 404. An active
but unavailable item and a mixed-currency request return HTTP 409 with distinct
error details. Unsupported methods return HTTP 405.

The quote is a point-in-time calculation with no identifier, timestamp,
expiry, persistence, price reservation, or availability reservation. It does
not create an Order or Payment. Order creation re-reads and revalidates all
server-owned menu data instead of trusting a previous quote.

With Uvicorn running, the approved example can be requested with:

```bash
curl -X POST http://127.0.0.1:8000/api/v1/orders/quote \
  -H "Content-Type: application/json" \
  -d '{"items":[{"menu_item_id":"9933957b-7f5d-47d8-84c3-ba8ad21b2d8c","quantity":2},{"menu_item_id":"c496b9cc-268c-4549-9e36-e8225e57561f","quantity":1}]}'
```

```powershell
$body = @{
    items = @(
        @{
            menu_item_id = "9933957b-7f5d-47d8-84c3-ba8ad21b2d8c"
            quantity = 2
        },
        @{
            menu_item_id = "c496b9cc-268c-4549-9e36-e8225e57561f"
            quantity = 1
        }
    )
} | ConvertTo-Json -Depth 3
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/v1/orders/quote -ContentType "application/json" -Body $body
```

Interactive documentation is available at `/docs`, and the OpenAPI document is
available at `/openapi.json`. From `backend`, run the Stage 7 tests with:

```powershell
& .\.venv\Scripts\python.exe -m pytest tests\test_order_quote_schemas.py
& .\.venv\Scripts\python.exe -m pytest tests\integration\test_order_quote_api.py
```

## Stage 8 order creation

`POST /api/v1/orders` creates either a `takeaway` or `dine_in` guest order and
returns HTTP 201 with a `Location` header. Requests contain 1–50 unique menu
item identifiers, quantities from 1–99, the order type, and a table number only
for dine-in orders. Clients never submit prices. Creation revalidates current
menu activity, availability, names, prices, costs, category names, and currency
inside one transaction before storing the server-authoritative snapshot.

Dine-in creation requires an existing active RestaurantTable. The
RestaurantTable provisioning and administration workflow has not been
implemented, so tables currently require a future administrative feature. The
initial fulfilment status is `created`. Order and item totals use integer minor
units, with derived totals stored as `BIGINT`.

The transaction locks a dine-in RestaurantTable first and then MenuItem and
Category rows using `FOR SHARE` in deterministic order. A validation or insert
failure rolls back the complete aggregate. Concurrent read-locking creations
may proceed, while conflicting source updates wait until creation finishes.

Each successful response contains a presentational `public_order_number` and a
one-time `order_access_token`. The raw token is returned only by creation; the
database stores only its SHA-256 hash. Public status is retrieved through
`GET /api/v1/orders/{public_order_number}` with the
`X-Order-Access-Token` header. Unknown numbers and missing or incorrect tokens
all return the same HTTP 404 response.

Order creation is limited to 10 attempts per 60 seconds for each direct
`request.client.host`. A rejected request returns HTTP 429 with `Retry-After`
and performs no SQL. The limiter is in-memory, per process, and intentionally
does not trust `X-Forwarded-For` without a future trusted-proxy configuration.

Stage 8 does not implement order-creation idempotency. Every valid POST creates
a distinct Order, so a network retry can create a duplicate order. It also
creates no Payment and does not call Stripe. Payment and Checkout idempotency
belong to Stage 9.

Example takeaway creation:

```bash
curl -i -X POST http://127.0.0.1:8000/api/v1/orders \
  -H "Content-Type: application/json" \
  -d '{"order_type":"takeaway","items":[{"menu_item_id":"9933957b-7f5d-47d8-84c3-ba8ad21b2d8c","quantity":1}]}'
```

```powershell
$createBody = @{
    order_type = "takeaway"
    items = @(
        @{
            menu_item_id = "9933957b-7f5d-47d8-84c3-ba8ad21b2d8c"
            quantity = 1
        }
    )
} | ConvertTo-Json -Depth 3
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/v1/orders `
    -ContentType "application/json" -Body $createBody
```

Use placeholders rather than a real guest credential when documenting status
access:

```bash
curl http://127.0.0.1:8000/api/v1/orders/ROA-ORDERNUMBER \
  -H "X-Order-Access-Token: ORDER_ACCESS_TOKEN"
```

```powershell
$headers = @{ "X-Order-Access-Token" = "ORDER_ACCESS_TOKEN" }
Invoke-RestMethod -Uri http://127.0.0.1:8000/api/v1/orders/ROA-ORDERNUMBER `
    -Headers $headers
```

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
- Public menu: <http://127.0.0.1:8000/api/v1/menu>
- Public menu item: `http://127.0.0.1:8000/api/v1/menu/items/{item_id}`
- Order quote: <http://127.0.0.1:8000/api/v1/orders/quote>
- Order creation: `POST http://127.0.0.1:8000/api/v1/orders`
- Public order status: `GET http://127.0.0.1:8000/api/v1/orders/{public_order_number}`
- Swagger UI: <http://127.0.0.1:8000/docs>
- OpenAPI document: <http://127.0.0.1:8000/openapi.json>

## Project documentation

- [Project Context](docs/PROJECT_CONTEXT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Architectural Decisions](docs/DECISIONS.md)
- [Implementation Status](docs/IMPLEMENTATION_STATUS.md)

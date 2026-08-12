# Restaurant Ordering & Analytics System

## Current status

Stages 1 through 15 are complete and verified. Stage 15 customer-frontend
automated validation and mandatory manual responsive QA both passed. The
repository contains a verified FastAPI application,
public menu and transient quote APIs, persistent guest order creation, secure
public order status retrieval, durable payment attempts, and idempotent Stripe
Checkout Session creation. It also provides an idempotent, signature-verified
Stripe webhook that applies provider-authoritative Payment transitions and
administrator authentication with Argon2id password hashes and short-lived JWT
access tokens. Authenticated administrator operations now cover order reads,
payment-aware fulfilment transitions, and menu category and item management.
Local development uses PostgreSQL 17, synchronous SQLAlchemy 2, Psycopg 3,
Alembic, and an explicit demonstration menu seed.

Stage 13 administrator analytics and the three Stage 14 administrator CSV
exports are complete. The guest-only React customer frontend covers menu
browsing through secure fulfilment-status polling. The Stage 16 administrator
frontend implements authentication, protected routing, order operations, menu
management, analytics, and CSV downloads. Its automated acceptance gates and
user-performed manual responsive QA at the required viewports pass.
Customer accounts are not implemented. Full-system containerisation, CI, and
deployment have not started.

## Planned unified accounts and landing direction

The accepted post-Stage-16-admin-screen direction is planned work, not current
behavior. It will be completed before Stage 17. An anonymous `guest` will remain
able to browse, order, pay, and check one order without an account. A registered
normal account will be a `customer`; public registration will always create
that role. An `admin` will retain the operational restaurant permissions, while
a securely bootstrapped `super_admin` will additionally manage promotion and
demotion between `customer` and `admin`. Ordinary administrators will not be
able to grant `super_admin`.

The planned browser route target is separate from the currently implemented
route list documented under Customer frontend:

- `/` for the concise restaurant landing page with Order as guest, Log in, and
  Create account actions;
- `/menu` for the public menu used by guests and registered users;
- `/cart` for the existing cart and order flow;
- `/login` and `/register` for unified account authentication;
- `/account` and `/account/orders/:publicOrderNumber` for the authenticated
  customer account and its own-order history;
- the existing `/orders/:publicOrderNumber/...` Checkout, return, and protected
  status routes;
- `/admin/...` for operational administration;
- `/admin/users` for `super_admin` role management only.

The target keeps an independent order-access token for every Order, including
an Order linked to a registered customer. Registration will never be required
for guest ordering.

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
- Durable `Order 1:N Payment` attempts with database-enforced integrity,
  idempotent hosted Stripe Checkout creation, and fake-provider tests.
- Durable StripeEvent receipts, raw-body signature verification, transactional
  webhook idempotency, and provider-authoritative Payment transitions.
- Persisted AdminUser identities, explicit interactive bootstrap, Argon2id
  password hashing, administrator sign-in, JWT access tokens, `/auth/me`, a
  reusable AdminBearer dependency, and sign-in rate limiting.
- Authenticated administrator order list, detail, and transactional fulfilment
  status mutation endpoints with payment-aware acceptance and cancellation.
- Authenticated administrator category and menu-item list, create, and partial
  update endpoints with soft deactivation and serialized concurrent updates.
- Four protected administrator analytics routes covering the six MVP KPIs with
  UTC filtering, Europe/Oslo presentation, and historical sales snapshots.
- Three protected administrator CSV exports for orders, full product sales,
  and qualified succeeded payments with deterministic wire contracts.
- A guest-only React customer interface for menu browsing, cart persistence,
  server quoting, order creation, idempotent Checkout, neutral return screens,
  and secure fulfilment-status polling.
- Isolated PostgreSQL integration tests for models, constraints, and migration
  upgrades, downgrades, seed idempotency, and data protection.
- Ruff, Black, and isort quality configuration.

## Technology status

- Implemented: Python 3.12, FastAPI, Pydantic 2, PostgreSQL 17, SQLAlchemy 2,
  Alembic, Psycopg 3, Stripe Python SDK, pwdlib with Argon2, PyJWT,
  email-validator, Docker Compose, pytest, Ruff, Black, isort, React,
  TypeScript, Vite, React Router, CSS Modules, native `fetch`, `sessionStorage`,
  Vitest, and React Testing Library.
- Planned: independent review of the implemented administrator frontend,
  unified accounts and role authorization, the landing and account frontend,
  full-system containers, GitHub Actions, and deployment.

## Repository structure

```text
.
├── backend/
│   ├── alembic/
│   ├── app/
│   │   ├── api/
│   │   ├── core/
│   │   ├── database/
│   │   ├── reports/
│   │   ├── seed/
│   │   └── main.py
│   ├── tests/
│   ├── alembic.ini
│   └── pyproject.toml
├── docs/
├── frontend/      # Guest customer React application
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
aggregates. Stage 9 adds the schema-only `0004_create_payment_model` migration
for durable payment attempts. Stage 10 adds the schema-only
`0005_create_stripe_event_model` migration for durable webhook receipts. Stage
11 adds schema-only migration `0006_create_admin_user_model`. It creates the
`admin_users` table but creates zero administrator accounts. None of these
migrations runs the seed or administrator bootstrap.

## Administrator authentication

Stage 11 persists a separate `AdminUser` identity with an application-generated
UUID, a normalized lowercase email, an Argon2id password hash, an activation
flag, and timestamps. There is no customer or general User authentication and
no public administrator registration.

Bootstrap passwords contain 15 through 128 Unicode code points and are
preserved exactly, including whitespace. pwdlib applies Argon2id with memory
cost 19456 KiB, time cost 2, parallelism 1, and a library-generated salt. Login
accepts password input from 1 through 128 code points because existing valid
credentials must remain usable. Passwords and hashes must never be logged.

The only administrator creation boundary is the explicit interactive command,
run from `backend` after migration `0006` has been applied:

```powershell
& .\.venv\Scripts\python.exe -m app.auth.bootstrap --email <email>
```

The CLI prompts with `getpass` for the password and confirmation, so the value
is not echoed. It has no `--password` option and does not read an administrator
password from configuration. Imports, application startup, Alembic, Docker
Compose, and the menu seed never create an administrator automatically.
Duplicate normalized emails fail without changing the existing hash,
activation state, or timestamps.

`POST /api/v1/admin/auth/login` accepts JSON containing `email` and `password`.
It returns a JWT Bearer access token after an exact normalized email lookup and
Argon2id verification. Unknown identities perform a process-local dummy
verification generated from random source material, while unknown identities,
wrong passwords, and inactive identities share one HTTP 401 response. The
separate login limiter permits five attempts per 60 seconds for each direct
peer, ignores `X-Forwarded-For`, and returns HTTP 429 with `Retry-After` before
SQL, Argon2, or token generation.

`GET /api/v1/admin/auth/me` requires the OpenAPI `AdminBearer` security scheme.
Every protected request validates the token and reloads the current AdminUser
from PostgreSQL; setting `is_active=false` therefore invalidates an otherwise
unexpired token immediately. Public health, menu, quote, guest order, public
status, and Checkout routes remain unauthenticated by AdminBearer. The Stripe
webhook remains hidden from OpenAPI.

Administrator access tokens use only HS256 with a fixed issuer, audience, token
type, canonical AdminUser UUID `sub`, `iat`, and `exp`. The default lifetime is
30 minutes and may be configured from 1 through 60 minutes. Stage 11 provides
no refresh tokens, logout, revocation list, password reset/change, or MFA.

Authentication configuration uses:

- `ADMIN_JWT_SECRET`: no default; at least 32 UTF-8 bytes;
- `ADMIN_ACCESS_TOKEN_EXPIRE_MINUTES`: integer from 1 through 60, default 30.

Keep configuration in an ignored local environment file and use HTTPS in any
deployment because Bearer tokens must not cross an unencrypted connection.
Migration `0006` intentionally creates zero administrators. An operator must
set `ADMIN_JWT_SECRET` in the ignored local environment and run the interactive
bootstrap command before using protected administrator routes. These are
manual operational setup steps, not automated test requirements.

## Administrator operational API

Stage 12 exposes authenticated order and menu operations under
`/api/v1/admin`. An administrator first signs in through
`POST /api/v1/admin/auth/login`; `GET /api/v1/admin/auth/me` returns the current
active identity. Every operational route below requires the OpenAPI
`AdminBearer` security scheme:

- `GET /api/v1/admin/orders`
- `GET /api/v1/admin/orders/{public_order_number}`
- `PATCH /api/v1/admin/orders/{public_order_number}/status`
- `GET /api/v1/admin/menu/categories`
- `POST /api/v1/admin/menu/categories`
- `PATCH /api/v1/admin/menu/categories/{category_id}`
- `GET /api/v1/admin/menu/items`
- `POST /api/v1/admin/menu/items`
- `PATCH /api/v1/admin/menu/items/{item_id}`

The fulfilment state machine permits exactly:

```text
created -> accepted
created -> cancelled
accepted -> preparing
preparing -> ready
ready -> completed
```

`completed` and `cancelled` are terminal. Acceptance requires at least one
related `Payment(status=succeeded)`. Cancellation is available only from
`created`: a succeeded payment forbids it, a pending attempt blocks it while
the attempt is active, and failed, expired, or absent payments allow it. If
both succeeded and pending historical attempts exist, the paid-order conflict
takes precedence. Cancellation does not issue a refund or call Stripe. Every
successful status change and its history row are committed atomically.

Categories and menu items use soft lifecycle changes rather than physical
deletion. Setting `Category.is_active=false` hides the category publicly but
does not rewrite child item flags. `MenuItem.is_active` controls lifecycle
visibility, while `MenuItem.is_available` independently controls temporary
availability and orderability. Prices and optional costs remain integer minor
units, and currency is an uppercase three-character code. Menu changes never
rewrite historical `OrderItem` name, category, price, or cost snapshots.

Stage 12 provides no menu DELETE route, RestaurantTable administration,
refund endpoint, StripeEvent diagnostic API, actor attribution, or generic
audit-log endpoint.

## Administrator analytics API

Stage 13 exposes exactly four routes protected by the existing `require_admin`
dependency and the OpenAPI `AdminBearer` scheme:

- `GET /api/v1/admin/analytics/overview`
- `GET /api/v1/admin/analytics/products`
- `GET /api/v1/admin/analytics/categories`
- `GET /api/v1/admin/analytics/order-types`

All require timezone-aware `start` and `end` values and use the half-open
interval `[start, end)`. Filtering compares UTC instants, while response range
metadata is normalized to `Europe/Oslo`. Optional `currency` is exactly three
uppercase ASCII letters. Product and category routes additionally accept a
per-currency `limit` from 1 through 100, defaulting to 50. There are no public
analytics routes.

The six KPIs are collected revenue, succeeded paid-order count, average order
value, product quantity and value, category quantity and value, and dine-in
versus takeaway paid-order count and collected revenue. Financial KPIs use
`Payment.amount` only for `Payment(status=succeeded)` records with a matching
`transitioned` `checkout.session.completed` or
`checkout.session.async_payment_succeeded` receipt. The earliest matching
`StripeEvent.stripe_created_at` is the authoritative success time. Paid-order
count uses distinct `Payment.order_id`; AOV is calculated per currency in
integer minor units with `ROUND_HALF_UP`. `Order.total_amount` is not collected
revenue.

Currencies are never combined and no FX conversion occurs. An empty unfiltered
overview returns `currencies=[]`; an explicit empty currency returns one zero
overview row. Empty breakdowns return `items=[]`.

Product analytics groups historical `OrderItem.menu_item_id`, `name_snapshot`,
quantity, `line_total_amount`, and `Order.currency`. Categories use
`category_name_snapshot` because no historical Category UUID is stored.
Current MenuItem or Category rows are not joined. Catalog edits therefore do
not rewrite history, renamed product snapshots may form separate groups for one
menu item UUID, and renamed historical categories remain separate groups.
Stage 13 includes no margin, cost, time-series, status, cancellation,
fulfilment-duration, CSV, or frontend analytics functionality.

## Administrator CSV export API

Stage 14 exposes exactly three synchronous, buffered CSV routes protected by
the existing `require_admin` dependency and OpenAPI `AdminBearer` scheme:

- `GET /api/v1/admin/exports/orders.csv`
- `GET /api/v1/admin/exports/product-sales.csv`
- `GET /api/v1/admin/exports/payments.csv`

There is no public or fourth export route, streaming or background export,
XLSX/PDF output, or generated file on disk. The customer frontend is the
separate Stage 15 application and does not alter these export contracts.
Each request returns one complete in-memory response. This is appropriate for
the current single-restaurant MVP scale and never silently truncates results;
streaming or background processing is deferred until measured scale justifies
it.

Every successful response uses `Content-Type: text/csv; charset=utf-8` and an
attachment `Content-Disposition` with a deterministic ASCII filename. Content
is UTF-8-SIG with exactly one UTF-8 BOM, a comma delimiter, double-quote
quotechar, minimal quoting, and CRLF line terminators. An empty result is HTTP
200 with only the BOM and header row ending in CRLF; it contains no synthetic
data row. UTF-8-SIG supports Windows and Excel interoperability while
preserving international text, including Norwegian and Polish characters.
Filename forms are
`orders_<startUTC>_<endUTC>_<currency/all>_<status/all>_<order-type/all>.csv`,
`product-sales_<startUTC>_<endUTC>_<currency/all>.csv`, and
`payments_<startUTC>_<endUTC>_<currency/all>.csv`, where each UTC token uses
`YYYYMMDDTHHMMSSZ`. Equivalent instants therefore produce identical filename
tokens, regardless of the input offset.

All exports require timezone-aware `start` and `end`, enforce `start < end`,
and use the half-open interval `[start, end)`. Optional `currency` is exactly
three uppercase ASCII letters. Unknown parameters are rejected, and there are
no `limit`, `offset`, `filename`, or `format` parameters. Orders additionally
accept optional `status` and `order_type`; product-sales and payments do not.
Filtering compares actual UTC instants. Range and datetime cells are ISO 8601
values carrying the applicable `Europe/Oslo` offset.

The three datasets intentionally use different time sources. `orders.csv`
selects by `Order.created_at`. `product-sales.csv` and `payments.csv` select by
the authoritative Payment success time: the earliest successful StripeEvent
whose processing result is `transitioned` for a succeeded Payment.

`orders.csv` contains these columns in order:

```text
range_start,range_end,timezone,public_order_number,created_at,updated_at,order_status,order_type,table_number,currency,subtotal_amount,total_amount
```

Rows are ordered by `Order.created_at ASC` and then internal Order ID as a
stable tie-breaker. The internal ID is not exported, and no Payment or Stripe
field is present. Subtotal and total are integer minor-unit amounts.

`product-sales.csv` contains these columns in order:

```text
range_start,range_end,timezone,menu_item_id,item_name,currency,quantity_sold,sales_amount
```

It is the full historical export with no top-N cutoff, unlike the Stage 13 JSON
product endpoint. It groups by `OrderItem.menu_item_id`, historical
`name_snapshot`, and `Order.currency`, and sums quantity and
`OrderItem.line_total_amount`. It does not join current MenuItem or Category
rows, so current catalog edits cannot rewrite history. Per-row currency comes
from Order; an explicit currency filter requires both the qualified Payment
and Order currency to match.

`payments.csv` contains these columns in order:

```text
range_start,range_end,timezone,public_order_number,payment_status,success_at,currency,amount
```

It returns one row per qualified succeeded Payment. Currency and integer
minor-unit amount come from Payment, while `success_at` is the earliest
qualifying transitioned success receipt. Non-success attempts are excluded,
and duplicate receipts do not duplicate rows. The export contains no Payment
ID, Stripe ID, Checkout URL, event data, idempotency key, guest credential,
administrator identity, cost, or personal data.

During CSV serialization, text that could be interpreted as a spreadsheet
formula is prefixed with an apostrophe. This covers `=`, `+`, `-`, and `@`,
including dangerous leading whitespace and control forms. Existing safe
apostrophes are not doubled, and NUL characters are removed from exported text.
This focused formula-injection safeguard is not a complete spreadsheet security
model. It runs only after database aggregation and changes neither persisted
values nor grouping identities.

## Administrator frontend

Stage 16 implements the current administrator interface under the dedicated
`/admin` route tree:

- `/admin/login`;
- `/admin`;
- `/admin/orders`;
- `/admin/orders/:publicOrderNumber`;
- `/admin/menu`;
- `/admin/analytics`;
- `/admin/exports`;
- `/admin/*` for the protected administrator-local not-found screen.

`/admin/users` is not implemented. Unified authentication, customer accounts,
the landing page, and role management remain the separate planned work described
above.

### Administrator session

Sign-in calls the administrator login endpoint, keeps the opaque access token in
the versioned `restaurant-ordering:admin-auth:v1` `sessionStorage` record, and
then requires `/api/v1/admin/auth/me` validation before protected UI renders. If
browser storage is unavailable, the successful current-tab login can continue
from memory. The browser never uses `localStorage` for this session and never
places the token in a URL, rendered DOM, or log.

HTTP 401 clears the session. Login HTTP 429 honors the server `Retry-After`
cooldown, while a temporary `/me` network or HTTP 503 failure preserves the
stored token and blocks protected content behind an explicit validation retry.
There is no backend logout endpoint; Logout clears only the frontend session.
Administrator Bearer credentials are attached only to canonical
`/api/v1/admin/...` requests.

### Administrator orders

The orders list supports `status` and `order_type` filters, offset pagination,
and manual Refresh. Detail renders immutable item snapshots, ordered status
history, and bounded Payment summaries without provider event data, Checkout
URLs, Session IDs, idempotency keys, or guest credentials.

The UI offers only the backend transition graph:

```text
created -> accepted | cancelled
accepted -> preparing
preparing -> ready
ready -> completed
```

`completed` and `cancelled` are terminal. Each action requires inline
confirmation. The client sends one PATCH, never applies an optimistic status or
fabricated history entry, and refetches authoritative detail after success. A
successful PATCH followed by a failed GET is reported separately. Network,
timeout, uncertain 5xx, and unresolved conflict outcomes require a successful
manual Refresh before another mutation attempt.

### Administrator menu

Categories and items use only the existing authenticated GET, POST, and PATCH
routes; there is no DELETE. List views use offset pagination and manual Refresh.
Forms support independent active and available item flags, category reassignment
including inactive categories returned by the backend, integer minor-unit price
and optional cost values, `[A-Z]{3}` currency, one allergen per line, and
clearing optional description, image, or cost fields.

PATCH sends changed fields only. The UI does not update optimistically, and an
ambiguous mutation result must be resolved by Refresh before resubmission.
Changes affect future orders only. Historical order snapshots and analytics do
not change.

### Administrator analytics

The dashboard calls the protected overview, products, categories, and
order-types endpoints. Date-only inputs use `Europe/Oslo`; the client converts
the inclusive selected end date to the next local midnight and sends explicit
aware ISO values for the half-open `[start, end)` backend range. The default is
the last seven Oslo calendar days including today. Currency is optional and a
shared breakdown limit is sent only to products and categories.

The UI presents collected revenue, distinct succeeded paid orders, AOV,
historical product and category quantity/value, and dine-in versus takeaway
count/revenue. Currencies remain separate and no FX conversion occurs. It makes
no cost, margin, profit, or time-series claim. Four requests run in parallel;
each section retains an independent loading, result, and partial-failure state,
with explicit Apply and Refresh actions and no polling or automatic retry.

### Administrator CSV downloads

The exports screen deliberately requests exactly `orders.csv`,
`product-sales.csv`, or `payments.csv` through the authenticated administrator
Blob transport. It never navigates directly to a protected URL. Orders accept
the common Oslo date/currency filters plus status and order type; the other two
accept only the common filters. Orders use the `Order.created_at` range, while
product-sales and payments use the earliest qualified successful-Payment time.

The shared JSON/Blob transport keeps Bearer credentials inside the administrator
namespace and gives Blob downloads a 30-second timeout. Successful responses
must have a compatible `text/csv` media type. CSV bytes remain backend-owned:
the browser does not parse, decode, inspect, or reserialize them, and a valid
header-only CSV still downloads. A conservative ASCII `.csv` allowlist handles
the quoted `Content-Disposition` filename with fixed report-specific fallbacks.
Each temporary object URL and link is removed after one click, including failure
cleanup; no Blob or object URL is persisted.

The administrator UI has automated responsive and accessibility coverage and
mobile-first CSS for login, navigation, orders, detail actions, menu, analytics,
and exports. User-performed manual acceptance passed at 375x812, 768x1024, and
1280x800, covering every administrator screen plus keyboard and focus behavior.

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
creates no Payment and does not call Stripe. The separate Stage 9 Checkout
endpoint owns Payment and Checkout idempotency.

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

## Payment / Stripe Checkout

Stage 9 persists each hosted Checkout attempt as a `Payment` related to one
durable `Order`. Attempts have the statuses `pending`, `succeeded`, `failed`,
and `expired`. Stage 9 creates `pending` attempts and may mark a definitively
rejected creation as `failed`. Stage 10 implements provider-confirmed
`succeeded`, `failed`, and `expired` transitions through the verified webhook
described below.

Create or replay a Checkout Session with:

```text
POST /api/v1/orders/{public_order_number}/checkout-session
X-Order-Access-Token: ORDER_ACCESS_TOKEN
Idempotency-Key: 00000000-0000-4000-8000-000000000000
```

The endpoint has no request body. It authenticates the guest with the public
order number and access token, then uses only the durable `Order.total_amount`
and `Order.currency`. Stripe receives one hosted Checkout line item in
`mode=payment`. A new attempt returns HTTP 201; replay of the same completed
operation returns HTTP 200. The public response contains only the public order
number, Payment attempt status, sensitive hosted Checkout URL, and expiration
time.
It does not expose internal IDs, Stripe Session IDs, idempotency keys, guest
credentials, or a payment summary through the public Order status endpoint.

`Idempotency-Key` is required and must be a canonical lowercase, hyphenated
UUIDv4. The pair of Order and request key identifies one `Payment`. Its stable
Stripe key is `checkout-session:{payment_uuid}`, so a retry after an ambiguous
provider outcome reuses the same remote operation. A pending attempt without a
stored session may be retried for less than 23 hours. At or after the
conservative 23-hour cutoff, or when stored provider data conflicts, the
attempt remains `pending` and requires reconciliation; the application does
not auto-expire it from the local clock.

Checkout uses two short database transactions. Each locks `Order` before
related `Payment` rows in deterministic order. The first transaction validates
state and persists or identifies the attempt, the Stripe call runs with no
database transaction or lock held, and the second transaction rechecks state
before storing the result. A different key conflicts with an active pending
attempt, while concurrent same-key requests converge on the same Payment and
Stripe key.

The app-scoped checkout limiter allows 10 attempts per 60 seconds for each
direct peer host and returns HTTP 429 with `Retry-After` before any SQL when
denied. The endpoint uses these stable error responses:

- HTTP 404: `{"detail":"Order not found"}` for unknown orders or guest access
  failures;
- HTTP 409: `{"detail":"Order is not payable"}`,
  `{"detail":"Active payment attempt exists"}`,
  `{"detail":"Order is already paid"}`, or
  `{"detail":"Payment attempt expired"}`;
- HTTP 422: `{"detail":"Invalid Idempotency-Key"}`;
- HTTP 429: `{"detail":"Too many checkout requests"}`;
- HTTP 502: `{"detail":"Payment provider unavailable"}` for definitive
  provider rejection;
- HTTP 503: `{"detail":"Payment service unavailable"}`,
  `{"detail":"Payment session outcome is unknown"}`, or
  `{"detail":"Payment session requires reconciliation"}`.

The Checkout URL is sensitive and must not be logged. Automated tests inject a
fake Stripe client and make no network request, so they require no real Stripe
secret. Real Stripe test-mode use requires these values in the local ignored
`.env` file:

- `STRIPE_SECRET_KEY`
- `STRIPE_SUCCESS_URL`
- `STRIPE_CANCEL_URL`

The redirect URLs may contain the single
`{public_order_number}` placeholder. Use only local test-mode credentials and
approved redirect destinations; no real values belong in repository files.

## Stripe Webhook

Stage 10 adds the provider-facing `POST /api/v1/stripe/webhook` endpoint. It is
intentionally hidden from OpenAPI, accepts the exact raw request body, requires
the `Stripe-Signature` header, and verifies signatures with the official Stripe
Python SDK. `STRIPE_WEBHOOK_SECRET` is optional for general application startup
but required to serve the webhook. The default signature tolerance is 300
seconds.

The following validly signed Checkout events are processed:

- `checkout.session.completed`;
- `checkout.session.async_payment_succeeded`;
- `checkout.session.async_payment_failed`;
- `checkout.session.expired`.

A validly signed event outside this set is acknowledged with HTTP 200 without a
database receipt. In-scope deliveries use the unique Stripe event ID for
durable idempotency. Known payments are correlated using the Payment ID, Order
ID, public order number, Checkout Session ID, amount, currency, and
`mode=payment`. The service locks Order before deterministically ordered Payment
rows and stores the StripeEvent receipt atomically with any Payment transition.

Provider facts drive the state machine:

- completed and paid transitions a pending Payment to `succeeded`;
- completed and unpaid keeps it `pending` while awaiting asynchronous payment;
- asynchronous success transitions it to `succeeded`;
- asynchronous failure transitions it to `failed`;
- an expired unpaid session transitions it to `expired`.

The first terminal state wins. A contradictory later event cannot regress or
replace it and instead creates a `reconciliation_required` receipt. Missing or
inconsistent business correlation also creates a durable reconciliation receipt
and returns HTTP 200. An invalid signature or payload returns HTTP 400, missing
webhook configuration returns HTTP 503, and a database failure before commit
returns HTTP 500 so Stripe can retry.

Webhook processing performs no Stripe retrieval or other external network
request and stores no raw payload, signature, Checkout URL, or metadata JSON.
It does not add a public `payment_summary` or a cancellation endpoint.
Automated tests are fully offline and use injected verifiers or clearly
synthetic local signatures. A Stripe CLI smoke test remains optional and
manual; it is not required for automated validation or a commit.

## Customer frontend

Stage 15 established the guest-only customer application in `frontend/`. It uses
React, TypeScript, Vite, React Router, CSS Modules, native `fetch`,
`sessionStorage`, Vitest, and React Testing Library. That Stage 15 scope has no
customer account, sign-in, profile, or administrator interface. Stage 16 has
since added the separate administrator frontend described above without
changing the completed guest flow.

The Stage 15 route baseline at its completion was exactly:

- `/` for the public menu and client-side category/availability filters;
- `/cart` for the cart, server quote, and guest order form;
- `/orders/:publicOrderNumber/checkout` for hosted Checkout initiation;
- `/orders/:publicOrderNumber/payment-return` for the neutral success return;
- `/orders/:publicOrderNumber/checkout-cancelled` for the neutral cancel return;
- `/orders/:publicOrderNumber/status` for protected fulfilment status;
- `*` for the not-found screen.

The intended guest journey is:

1. Load `GET /api/v1/menu` without an `available_only` query parameter.
2. Filter the returned categories and availability locally; unavailable items
   remain visible by default and backend category/item ordering is preserved.
3. Add products to the cart. Duplicate additions merge into one line.
4. Change quantities within 1 through 99 and at most 50 unique products.
5. Request a server-authoritative quote after a 400 ms debounce.
6. Choose takeaway or dine-in and provide a positive table number for dine-in.
7. Obtain a fresh quote immediately before the non-idempotent order POST.
8. Create the guest order once and retain its one-time access token only in the
   current browser session or transient memory.
9. Start or replay one idempotent Checkout attempt and continue in the same tab
   to the validated hosted HTTPS Checkout URL.
10. Treat both Stripe return routes as navigation outcomes only, never as
    confirmation of payment.
11. Read and poll the protected public Order fulfilment status.

### Browser trust and cart contract

The browser stores only menu-item identifiers and quantities for the cart.
Names, prices, availability, currency, totals, and all order or payment states
remain server-authoritative. The versioned cart key is
`restaurant-ordering:cart:v1`; malformed, wrong-version, duplicate, or
out-of-range stored data is discarded. The app uses `sessionStorage`, never
`localStorage`, and keeps usable in-memory state when browser storage is
unavailable where the flow supports it.

Menu images are rendered only from validated HTTP(S) URLs and fall back to a
local placeholder when missing, unsafe, or broken. Allergen text repeats the
backend-provided list as advisory information; it is not a medical or
cross-contamination guarantee.

Quote requests send only identifiers and quantities. The app debounces normal
cart changes by 400 ms, aborts stale work, ignores stale responses, and renders
only validated server line totals and totals. A quote is informational: order
creation requests a fresh quote and still relies on the backend to revalidate
current menu data.

Order creation has no idempotency contract. The submit guard prevents an
ordinary duplicate click, and the client never automatically retries a network
failure or timeout because the first request may have created an Order. An
explicit retry remains available with a duplicate-order warning. The returned
`order_access_token` is available only once, is stored under
`restaurant-ordering:order-access:v1:<PUBLIC_ORDER_NUMBER>` for the current
session with an in-memory fallback, and is never placed in a URL, rendered in
the DOM, or logged.

### Checkout and Stripe returns

Checkout calls:

```text
POST /api/v1/orders/{public_order_number}/checkout-session
X-Order-Access-Token: ORDER_ACCESS_TOKEN
Idempotency-Key: CANONICAL_LOWERCASE_UUID_V4
```

The attempt key is generated with `crypto.randomUUID()` and stored under
`restaurant-ordering:checkout-attempt:v1:<PUBLIC_ORDER_NUMBER>`. Network and
timeout failures, HTTP 429 and 503, and redirect failures preserve the same
attempt. A new key is generated only after the customer explicitly starts a
new attempt following definitive HTTP 502 provider rejection. There is no
automatic Checkout retry, Stripe.js integration, card form, Checkout URL
persistence, or guest token in Checkout storage. A validated Checkout URL is
opened in the same tab.

The payment-return page says only that the customer returned from Stripe and
must check order progress. It does not claim that payment succeeded. The
checkout-cancelled page likewise does not infer Payment state or cancel the
Order. Both lead to the protected status screen when this browser session still
has the guest token.

### Fulfilment status polling

Status retrieval calls
`GET /api/v1/orders/{public_order_number}` with only the
`X-Order-Access-Token` header. The UI presents the six fulfilment states as
`Order received`, `Accepted`, `Preparing`, `Ready`, `Completed`, and
`Cancelled`; it does not display or infer a Payment status.

Polling starts immediately, allows one request in flight, and schedules the
next request only after the current one settles. Normal polling uses 8 seconds.
Transient failures retry after 8, 16, then at most 30 seconds. Polling pauses
while the document is hidden or the browser is offline, resumes immediately
when both visible and online, and stops at `completed`, `cancelled`, a
privacy-preserving HTTP 404, or an invalid response contract. AbortController
cleanup and the current effect generation prevent stale results from replacing
newer state. WebSockets and server-sent events are not used.

### Visual, responsive, and accessibility direction

The customer UI uses a warm restaurant palette, readable type scale, prominent
server totals, clear availability states, focus-visible controls, semantic
headings and forms, textual status cues, and controls sized for touch. CSS
Modules contain mobile-first responsive rules for menu grids, cart lines,
forms, Checkout, return screens, and the order timeline. Data-driven screens
provide applicable loading, empty, error, and success states. Automated
component and build checks pass. Manual acceptance also passed at 375x812,
768x1024, and 1280x800, including keyboard navigation, visible focus, touch
targets, text wrapping, and protection against color-only status meaning.

### Local frontend setup

From the repository root:

```powershell
cd frontend
npm install
npm run dev
```

Vite serves the UI at <http://localhost:5173>. In local development its `/api`
proxy targets `http://127.0.0.1:8000`. `VITE_API_BASE_URL` is intentionally
empty for same-origin paths through that proxy; a deployment may set a public
HTTP(S) API base URL without a trailing slash. The application does not add or
depend on local FastAPI CORS middleware.

Frontend verification commands are:

```powershell
npm run test:run
npm run lint
npm run format:check
npm run build
```

`npm run format` writes formatting changes and should be used deliberately.

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
- Stripe Checkout: `POST http://127.0.0.1:8000/api/v1/orders/{public_order_number}/checkout-session`
- Stripe webhook: `POST http://127.0.0.1:8000/api/v1/stripe/webhook` (provider-facing and hidden from OpenAPI)
- Swagger UI: <http://127.0.0.1:8000/docs>
- OpenAPI document: <http://127.0.0.1:8000/openapi.json>

## Project documentation

- [Project Context](docs/PROJECT_CONTEXT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Architectural Decisions](docs/DECISIONS.md)
- [Implementation Status](docs/IMPLEMENTATION_STATUS.md)

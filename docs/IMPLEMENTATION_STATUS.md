# Implementation Status

- **Documentation:** completed
- **Stage 1:** completed
- **Stage 2:** completed
- **Stage 3:** completed
- **Stage 4:** completed
- **Stage 5:** completed
- **Stage 6:** completed
- **Stage 7:** completed
- **Stage 8:** completed
- **Stage 9:** completed
- **Stage 10:** completed
- **Stage 11:** completed
- **Stage 12:** completed
- **Stage 13:** completed
- **Stage 14:** completed
- **Stage 15:** completed
- **Current stage:** waiting for approval to start Stage 16 — Administrator Frontend
- **Backend:** FastAPI, database foundation, menu models, local seed data,
  public menu, transient quoting, persistent order creation, and secure public
  order status, Payment persistence, Stripe Checkout, and verified Stripe
  webhook processing, administrator authentication, and administrator order
  and menu operational APIs, administrator analytics, and administrator CSV
  reports completed
- **Frontend:** guest menu, client filters, session cart, server quote, guest
  order creation, idempotent Checkout, neutral Stripe returns, and protected
  fulfilment-status polling completed and verified through automated validation
  and manual responsive acceptance
- **Database:** PostgreSQL, Alembic, menu, order, Payment, StripeEvent, and
  AdminUser models, migration `0006_create_admin_user_model`, and deterministic
  menu seed completed; the development AdminUser count is one
- **Seed data:** completed and verified
- **Public menu API:** list, availability filter, item details, and 404 contract
  completed and verified
- **Menu write API:** administrator category and item list, create, partial
  update, activity, availability, and reassignment completed and verified
- **Order quoting:** completed and verified
- **Order creation:** completed and verified
- **Public order status:** completed and verified
- **RestaurantTable foundation:** completed; provisioning and administration
  workflow not started
- **Payment persistence:** completed and verified
- **Stripe Checkout:** completed and verified using the official SDK boundary
  and fake-provider automated tests
- **Checkout idempotency:** completed and verified
- **D-016 Payment-aware cancellation verification:** completed at the domain
  and integration level
- **D-017 Order -> Payment locking and provider transaction boundary:**
  completed and verified
- **StripeEvent persistence:** completed and verified
- **Stripe webhook signature verification and idempotency:** completed and
  verified
- **Provider-authoritative Payment transitions:** completed and verified
- **Webhook/Checkout Phase 3 race:** completed and verified
- **AdminUser persistence:** completed and verified
- **Argon2id password hashing:** completed and verified through pwdlib
- **Administrator JWT:** completed and verified with fixed HS256 contracts
- **Administrator login and `/auth/me`:** completed and verified
- **Reusable AdminBearer dependency:** completed and verified
- **Administrator login limiter:** completed and verified at 5 attempts per 60
  seconds for each direct peer
- **Administrator bootstrap CLI:** completed and verified; no development
  administrator was created by migration or automated tests
- **Administrator order API:** list, filters, pagination, detail, safe Payment
  summaries, and immutable snapshots completed and verified
- **Administrator order transitions:** exact fulfilment graph, payment-aware
  acceptance and cancellation, atomic history, and concurrency completed
- **Administrator menu API:** six protected list/create/PATCH operations, soft
  deactivation, normalized uniqueness, and row-lock concurrency completed
- **Administrator analytics:** four protected routes implementing the six
  roadmap KPIs from qualified succeeded payments, historical product/category
  snapshots, and order-type breakdowns, with currency separation, half-open
  UTC queries, Europe/Oslo range metadata, and one SELECT per endpoint; no
  migration required
- **Administrator CSV export:** exactly three protected buffered routes for
  operational orders, full historical product sales, and qualified succeeded
  payments; deterministic UTF-8-SIG, BOM, CSV dialect, filename, query,
  time-source, formula-safety, and exposure contracts completed and verified;
  one report SELECT per route and no migration required
- **Application tests:** 1379 backend health, database, migration, model, constraint,
  seed, schema, public API, quoting, order creation, payment, security,
  rate-limit, rollback, and concurrency tests plus 263 frontend tests completed
- **Deployment:** not started

## Known limitations

- The backend exposes health, public menu and quote endpoints, persistent guest
  ordering and payment flows, secure public status, authenticated administrator
  order and menu operations, administrator analytics, and three protected CSV
  exports. The guest customer frontend is completed and verified.
- Administrator authentication has no refresh, logout, revocation, password
  reset/change, or MFA. Its limiter is per process and resets on restart.
- Migration `0006` creates no administrator. Manual setup requires an operator
  to configure a local JWT secret and run the interactive bootstrap command;
  neither action is part of tests.
- RestaurantTable provisioning and administration have not started, so Stage 8
  only provides the persistence and validation foundation.
- Order creation has no idempotency key; a network retry can create a duplicate
  Order. Its fixed-window limiter is per process and resets on restart.
- D-016 is enforced by the implemented administrator cancellation transition,
  and D-017 is verified with PostgreSQL concurrency tests across cancellation,
  Checkout, and webhook flows.
- Stage 10 verifies and durably deduplicates webhook events and applies
  provider-authoritative terminal Payment outcomes. Public Order status still
  exposes no `payment_summary`, and Stage 12 exposes no StripeEvent diagnostic
  API.
- Stage 13 provides no RestaurantTable administration, menu DELETE, refund,
  actor attribution, generic audit log, cost or margin analytics, time series,
  or frontend analytics. Stage 14 CSV exports are synchronous and buffered in
  memory; streaming and background exports are deferred until measured scale
  justifies them.
- A real Stripe CLI smoke remains optional and manual; automated tests use
  injected adapters or synthetic local signatures and perform no Stripe calls.
- The seed is restricted to the exact local development database and is not a
  production bootstrap process.
- Customer accounts and the administrator frontend are not implemented.
  Full-system containerisation, continuous integration, and deployment have not
  started.

## Last verification

Stage 15 completed and verified on 2026-08-12:

- Exactly seven route entries, including the not-found wildcard, with no
  administrator, account, or dead placeholder route: PASS
- Public menu retrieval without `available_only`, local category and
  availability filters, backend ordering, unavailable-item visibility, safe
  image handling, and cautious allergen wording: PASS
- Identifier-and-quantity cart, 1–99 quantity range, 50 unique-item limit,
  duplicate merge, versioned `sessionStorage`, corrupted-data discard, no
  `localStorage`, 400 ms quote debounce, stale cancellation, and server totals:
  PASS
- Fresh quote before non-idempotent order creation, duplicate submit guard, no
  ambiguous automatic retry, explicit duplicate warning, and one-time guest
  token confinement: PASS
- Canonical UUIDv4 Checkout idempotency, same-key ambiguous retry, new key only
  after explicit post-502 action, same-tab hosted redirect, and neutral return
  semantics: PASS
- Protected fulfilment polling with six statuses, immediate request, one request
  in flight, 8-second cadence, 8/16/30-second backoff, hidden/offline pause,
  resume, terminal stop, privacy-preserving 404, and no Payment status: PASS
- Frontend full suite: 263 passed; ESLint, Prettier check, TypeScript/Vite build,
  npm production audit, and npm full audit: PASS
- Source and repository scans found no real secret, credential, guest-token
  value, persisted Checkout URL, real Stripe identifier, runtime
  `localStorage` use, generated report, or forbidden frontend artifact: PASS
- User-performed manual responsive acceptance at 375x812, 768x1024, and
  1280x800, covering the customer flow from public menu through secure order
  status: PASS
- Responsive product cards, cart and quantity controls, server quote states and
  totals, order-type/table validation, order and Checkout CTA states, neutral
  return screens, status timeline, long-text wrapping, and absence of material
  horizontal overflow: PASS
- Keyboard navigation, visible focus, usable controls and touch targets, no
  payment-success claim on return pages, and no color-only status semantics:
  PASS
- Stage 16 Administrator Frontend: not started

Stage 14 verified on 2026-08-11:

- Exactly three AdminBearer CSV routes for orders, full product sales, and
  qualified succeeded payments, with no public or fourth export route: PASS
- Strict aware ranges, half-open UTC filtering, source-specific order creation
  or Payment success time, uppercase currency, exact filters, and unknown-query
  rejection: PASS
- Exact headers, deterministic ordering and filenames, integer minor-unit
  amounts, Europe/Oslo ISO 8601 offsets, and empty header-only responses: PASS
- UTF-8-SIG, one BOM, comma delimiter, minimal double-quote quoting, CRLF,
  Unicode, formula neutralization, apostrophe preservation, and NUL removal:
  PASS
- Historical product grouping, full CSV without JSON top-N, immutable
  snapshots, qualified-Payment deduplication, and mixed-currency protection:
  PASS
- One set-based report SELECT per route, zero DML, no provider calls, no N+1,
  no generated file, and non-blocking EXPLAIN plans: PASS
- CSV utility 29, CSV integration 92, and administrator auth/OpenAPI 16 tests
  passed
- Stage 13 regression: analytics schemas 59 and analytics API 78 tests passed
- Stage 12 regression: admin orders 63, admin menu 18, and admin order
  concurrency 5 tests passed
- Full pytest suite: 1379 passed with one accepted Starlette warning
- Ruff, Black, isort, OpenAPI, and Alembic drift checks: PASS
- Alembic remains at `0006_create_admin_user_model`; Stage 14 requires no model,
  index, migration, or persistence change: PASS
- Development menu remains 5/15; RestaurantTable, Order, OrderItem,
  OrderStatusHistory, Payment, and StripeEvent counts remain zero; the one
  existing development administrator remains unchanged: PASS
- Isolated test database removal, named-volume preservation, local PostgreSQL
  18 preservation, and port cleanup: PASS

Stage 13 verified on 2026-08-11:

- Four AdminBearer analytics routes and exactly six roadmap KPIs: PASS
- Qualified succeeded-Payment source, earliest transitioned successful
  StripeEvent time, distinct paid orders, and per-currency `ROUND_HALF_UP` AOV:
  PASS
- Historical product/category snapshots, order-type breakdown, per-currency
  top-N, deterministic ordering, mixed-currency protection, and empty-result
  contracts: PASS
- Half-open UTC filtering, equivalent instants, Europe/Oslo response metadata,
  spring and autumn DST boundaries, and naive-datetime rejection: PASS
- One set-based SELECT per endpoint, zero DML, no provider calls, no N+1, SQL
  window ranking, and no current catalog joins: PASS
- Full pytest suite: 1258 passed with one accepted Starlette warning
- Ruff, Black, isort, OpenAPI, and Alembic drift checks: PASS
- Alembic remains at `0006_create_admin_user_model`; Stage 13 requires no model,
  index, or migration change: PASS
- Development menu remains 5/15; RestaurantTable, Order, OrderItem,
  OrderStatusHistory, Payment, and StripeEvent counts remain zero; the one
  existing development administrator remains unchanged: PASS
- Isolated test database removal, named-volume preservation, local PostgreSQL
  18 preservation, and port cleanup: PASS

Stage 12 verified on 2026-08-11:

- Administrator order list, filters, deterministic pagination, detail,
  immutable snapshots, safe Payment summaries, and bounded SQL: PASS
- Exact fulfilment graph, succeeded-payment acceptance, D-016 cancellation,
  D-017 lock order, atomic history, and concurrent transitions: PASS
- Six administrator menu routes, strict schemas, normalized uniqueness,
  row-locked PATCH operations, soft deactivation, independent activity and
  availability, public-menu and quote regression, and snapshot immutability:
  PASS
- Admin order schemas 10, order statuses 48, admin menu schemas 56, admin order
  API 63, admin order concurrency 5, payment cancellation 11, Checkout
  concurrency 11, webhook concurrency 13, admin menu API 18, and admin auth API
  16 tests passed
- Full pytest suite: 1121 passed with one accepted Starlette warning
- Ruff, Black, isort, OpenAPI, and Alembic drift checks: PASS
- Alembic remains at `0006_create_admin_user_model`; Stage 12 requires no model
  or migration change: PASS
- Development menu remains 5/15; RestaurantTable, Order, OrderItem,
  OrderStatusHistory, Payment, and StripeEvent counts remain zero; the one
  existing development administrator remains unchanged: PASS
- Isolated test database removal, named-volume preservation, local PostgreSQL
  18 preservation, and port cleanup: PASS
- No table administration, DELETE menu route, refund, StripeEvent API, generic
  audit log, Stage 13 implementation, secret, or Git history operation: PASS

Stage 11 verified on 2026-08-09:

- Independent AdminUser, Argon2id, JWT, login, Bearer, limiter, bootstrap,
  OpenAPI, exposure, and concurrency audit: PASS
- Administrator passwords 20, schemas 19, tokens 55, models 14, migration 3,
  auth API 16, bootstrap 23, and rate-limit 22 tests passed
- Full pytest suite: 925 passed with one accepted Starlette warning
- Ruff, Black, isort, OpenAPI, and Alembic drift checks: PASS
- Isolated `0005_create_stripe_event_model` to
  `0006_create_admin_user_model` upgrade, downgrade, second upgrade, model
  parity, and no-drift lifecycle: PASS
- Development database migrated additively from `0005` to `0006` without
  changing OID 16384 or any seed UUID, business value, or timestamp: PASS
- Development menu remains 5/15; RestaurantTable, Order, OrderItem,
  OrderStatusHistory, Payment, StripeEvent, and AdminUser counts remain zero:
  PASS
- Read-only health, menu, availability, approved quote 53700, docs, OpenAPI,
  and bootstrap-help smoke: PASS
- No public registration, automatic administrator, real JWT secret, bootstrap
  execution, development seed, Stage 12 endpoint, or Git history operation:
  PASS

Stage 10 verified on 2026-08-08:

- Independent StripeEvent, signature, service, HTTP, state-machine, exposure,
  idempotency, and concurrency audit: PASS
- StripeEvent models 37, migration 3, webhook adapter 32, webhook API 44, and
  webhook concurrency 12 tests passed
- Full pytest suite: 757 passed with one accepted Starlette warning
- Ruff, Black, isort, OpenAPI, and Alembic drift checks: PASS
- Isolated `0004_create_payment_model` to `0005_create_stripe_event_model`
  upgrade, downgrade, second upgrade, model parity, and no-drift lifecycle: PASS
- Development database migrated additively from `0004` to `0005` without
  changing OID 16384 or any seed UUID, business value, or timestamp: PASS
- Development menu remains 5/15; RestaurantTable, Order, OrderItem,
  OrderStatusHistory, Payment, and StripeEvent counts remain zero: PASS
- Read-only health, menu, availability, approved quote 53700, docs, and OpenAPI
  smoke: PASS
- D-016 and D-017 remain verified; webhook/Checkout and webhook/cancellation
  races complete without deadlocks: PASS
- No public payment summary, cancellation endpoint, real Stripe request, seed,
  or demonstration financial data: PASS


Stage 9 verified on 2026-08-07:

- Independent Payment model, migration, Stripe adapter, checkout protocol,
  exposure, and concurrency audit: PASS
- PostgreSQL 17 health and host-to-container mapping `5433:5432`: PASS
- `0003_create_order_models` to `0004_create_payment_model` upgrade, downgrade,
  second-upgrade lifecycle on the isolated test database: PASS
- Payment statuses/policy 9, Checkout schemas 28, Stripe adapter 33, rate
  limiter 16, Payment models 33, Payment migration 3, Payment cancellation 10,
  Checkout API 31, and Checkout concurrency 10 tests passed
- Public Menu 33, Order Quote 45, Order Creation 26, Order Status 14, Seed 25,
  Order Models 81, and Order Migration 3 regression tests passed
- Full pytest suite: 628 passed with one accepted Starlette warning
- Ruff, Black, isort, OpenAPI, and Alembic drift checks: PASS
- Development database migrated additively from `0003_create_order_models` to
  `0004_create_payment_model` without changing its OID: PASS
- All 20 seed UUIDs, business values, `created_at`, `updated_at`, unrelated-data
  digest, and menu counts 5/15 remained unchanged: PASS
- RestaurantTable, Order, OrderItem, OrderStatusHistory, and Payment development
  tables remain empty: PASS
- Payment constraints, unique constraints, partial pending/succeeded indexes,
  and deterministic history index in development: PASS
- Read-only development smoke for health, menu 5/15, availability 14, approved
  quote 53700, docs, and OpenAPI Checkout route: PASS
- No webhook route, no real Stripe request, no seed, and no demonstration Order
  or Payment: PASS
- Isolated test database removal, named-volume preservation, local PostgreSQL 18
  preservation, and port cleanup: PASS

Stage 8 verified on 2026-08-07:

- Independent model, migration, transaction, access, locking, rate-limit, and
  public-contract audit: PASS
- PostgreSQL 17 health and host-to-container mapping `5433:5432`: PASS
- `0003_create_order_models` upgrade/downgrade/second-upgrade lifecycle on the
  isolated test database: PASS
- Status/cancellation 8, creation schemas 61, access security 7, rate limiter
  14, order models 81, migration 3, status API 14, creation API 26, and
  concurrency 4 tests passed
- Public Menu 33, Order Quote 45, Seed 25, and Menu Models 66 regression tests
  passed
- Full pytest suite: 469 passed with one accepted Starlette warning
- Ruff, Black, isort, FastAPI import, router prefix, and metadata: PASS
- Alembic check reported no new upgrade operations: PASS
- Development database migrated additively from `0002_create_menu_models` to
  `0003_create_order_models` without changing its OID: PASS
- All 20 seed UUIDs, business values, `created_at`, `updated_at`, unrelated-data
  digest, and menu counts 5/15 remained unchanged: PASS
- Read-only development smoke for health, menu 5/15, availability 14, approved
  quote 53700, docs, and OpenAPI: PASS
- RestaurantTable, Order, OrderItem, and OrderStatusHistory development tables
  exist and remain empty: PASS
- Isolated test database removal, named-volume preservation, and local
  PostgreSQL 18 preservation: PASS

Stage 7 verified on 2026-08-06:

- Docker CLI 29.6.2, Docker Compose 5.3.1, and Docker Engine 29.6.2: PASS
- PostgreSQL 17 health and host-to-container mapping `5433:5432`: PASS
- Selective strict request validation and strict response schemas: 32 tests
  passed
- Order quote PostgreSQL integration suite: 45 tests passed
- One SELECT, zero DML, request-order preservation, and no partial quote: PASS
- Active item, active category, availability, missing, mixed-currency, and
  error-precedence contracts: PASS
- Server-authoritative names and prices, integer totals, price snapshot A/B,
  availability change, and non-seed item support: PASS
- HTTP 200, 404, both 409 variants, 422, 405, OpenAPI, and `/docs`: PASS
- Full pytest suite: 251 passed with one accepted Starlette warning
- Ruff, Black, and isort: PASS
- Alembic check reported no new upgrade operations: PASS
- FastAPI application, quote router, and seed imports: PASS
- Read-only development smoke: health, approved quote, unavailable, missing,
  validation, method rejection, docs, and OpenAPI: PASS
- Development counts, all seed UUIDs, business fields, `created_at`,
  `updated_at`, revision, and unrelated-data digest remained unchanged: PASS
- Isolated test database removal and development database preservation: PASS

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

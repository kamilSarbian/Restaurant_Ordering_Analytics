# Restaurant Ordering & Analytics System

## Current status

Stages 1 through 15 are complete and verified. Stage 16 now provides one
integrated React application for guests, registered customers, administrators,
and super-administrators. Its public landing, menu, cart, unified login and
registration, mixed-auth ordering, personal account, operational administrator,
analytics, CSV export, and super-administrator User-governance screens are
implemented. Automated validation passes, and the developer/user completed the
required local-browser responsive and keyboard QA after the final Stage 16F
fixes.

Stage 16F is PRE-COMMIT READY after C1 documentation and cumulative validation;
Stage 16F-C2 independent review and final commit are next.

The FastAPI backend provides public menu and quote APIs, anonymous or owned
Order creation, owner-or-capability status and idempotent Stripe Checkout,
signature-verified webhook processing, unified registered identities,
database-authoritative role checks, read-only personal Order history, and
administrator operations. Local development uses PostgreSQL 17, synchronous
SQLAlchemy 2, Psycopg 3, Alembic, and an explicit demonstration menu seed. Code
and the development database are both at migration
`0008_add_order_ownership`. Full-system containerisation, CI, and deployment
have not started; Stage 16G and Stage 17 remain future work.

## Unified identity, Order ownership, and account backend

Stage 16D implements one `User` backend for all registered identities with the
mutually exclusive roles `customer`, `admin`, and `super_admin`. An anonymous
`guest` remains outside the User model and role enum and can still browse,
order, pay, and check one order without an account. Public registration always
creates `customer` and rejects role, activation, and unknown privilege fields.
An `admin` retains operational restaurant permissions, while a securely
bootstrapped `super_admin` can promote `customer` to `admin` or demote `admin`
to `customer`. The ordinary role API cannot create or modify a `super_admin`.

The implemented canonical backend routes are:

- `POST /api/v1/auth/register`;
- `POST /api/v1/auth/login`;
- `GET /api/v1/auth/me`;
- `GET /api/v1/admin/users` for `super_admin` only;
- `PATCH /api/v1/admin/users/{user_id}/role` for `super_admin` only.

Canonical tokens use the strict `user_access` type and user audience. They do
not contain a role authority claim: every protected request reloads the current
User role and `is_active` from PostgreSQL. The frontend uses the canonical
`/api/v1/auth/login` and `/api/v1/auth/me` contracts for every role. The backend
`/api/v1/admin/auth/login` and `/api/v1/admin/auth/me` aliases remain
compatibility contracts, but current frontend source does not call them. The
login alias accepts only a current `admin` or `super_admin` and issues
`user_access`; older strict `admin_access` tokens remain validation-only
compatibility. Operational administrator routes allow a current `admin` or
`super_admin`; a customer receives 403.

Stage 16E extends this identity backend with nullable Order ownership while
preserving the anonymous capability flow. `Order.customer_user_id` is a
nullable UUID foreign key to `users.id`, uses `ON DELETE SET NULL`, and has no
Python or server default. Migration `0008_add_order_ownership`, whose parent is
`0007_unify_user_auth_roles`, adds the column and the non-unique
`ix_orders_customer_user_created_at_id` index on
`(customer_user_id, created_at, id)`. Historical Orders remain unowned; there
is no fake guest User, guest role, ownership backfill, or retroactive claim.

The implemented account routes are read-only and accept strict canonical
`user_access` only:

- `GET /api/v1/account/orders`;
- `GET /api/v1/account/orders/{public_order_number}`.

Every active role uses personal scope only. The list filters its page and total
by owner in SQL, defaults to `limit=50` and `offset=0`, accepts limits from 1
through 100, and orders by `created_at DESC, id DESC`. Its exact item fields are
`public_order_number`, `status`, `order_type`, `total_amount`, `currency`,
`created_at`, and `updated_at`. Detail also applies the owner predicate in SQL
and returns the existing safe `OrderStatusResponse`. Another User's Order, an
unowned Order, and an unknown number all return the same 404. A guest capability
cannot bypass account ownership, administrator roles receive no global account
bypass, and account responses expose no ownership identity, PII, Payment, or
Stripe data. No account mutation endpoint exists.

The implemented browser routes are:

- `/` for the restaurant landing page;
- `/menu` for the public menu used by guests and registered users;
- `/cart` for the existing cart and order flow;
- `/login` and `/register` for unified authentication;
- `/account` and `/account/orders/:publicOrderNumber` for the authenticated
  personal Order list and detail;
- `/orders/:publicOrderNumber/checkout`, `payment-return`,
  `checkout-cancelled`, and `status` for the customer Order flow;
- `/admin`, `/admin/orders`, `/admin/orders/:publicOrderNumber`, `/admin/menu`,
  `/admin/analytics`, and `/admin/exports` for operational administration;
- `/admin/users` for super-administrator User governance;
- `/admin/login` as a compatibility redirect to unified `/login` with a safe
  administrator continuation.

Every Order already keeps an independent guest capability, including an Order
linked to a registered User. Registration is not required for guest ordering.

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
- Nullable registered-User Order ownership through migration 0008, with
  anonymous guest Orders preserved and deterministic personal-history queries.
- Owner-or-capability public Order status and Checkout access without exposing
  ownership, internal IDs, or token hashes.
- Strict canonical read-only personal Order list and detail endpoints with
  owner predicates enforced in SQL.
- Durable `Order 1:N Payment` attempts with database-enforced integrity,
  idempotent hosted Stripe Checkout creation, and fake-provider tests.
- Durable StripeEvent receipts, raw-body signature verification, transactional
  webhook idempotency, and provider-authoritative Payment transitions.
- Unified User identities with constrained customer, admin, and super-admin
  roles; canonical registration/login/me; Argon2id password hashing; strict JWT
  families; database-authoritative authorization; explicit first-super-admin
  bootstrap; role management; and shared sign-in rate limiting.
- Authenticated administrator order list, detail, and transactional fulfilment
  status mutation endpoints with payment-aware acceptance and cancellation.
- Authenticated administrator category and menu-item list, create, and partial
  update endpoints with soft deactivation and serialized concurrent updates.
- Four protected administrator analytics routes covering the six MVP KPIs with
  UTC filtering, Europe/Oslo presentation, and historical sales snapshots.
- Three protected administrator CSV exports for orders, full product sales,
  and qualified succeeded payments with deterministic wire contracts.
- One React application with a landing page, unified authentication, guest and
  authenticated ordering, personal Order history, administrator operations,
  analytics and exports, and super-administrator User governance.
- Isolated PostgreSQL integration tests for models, constraints, and migration
  upgrades, downgrades, seed idempotency, and data protection.
- Ruff, Black, and isort quality configuration.

## Technology status

- Implemented: Python 3.12, FastAPI, Pydantic 2, PostgreSQL 17, SQLAlchemy 2,
  Alembic, Psycopg 3, Stripe Python SDK, pwdlib with Argon2, PyJWT,
  email-validator, Docker Compose, pytest, Ruff, Black, isort, React,
  TypeScript, Vite, React Router, CSS Modules, native `fetch`, `sessionStorage`,
  Vitest, and React Testing Library.
- Planned: Stage 16G, Stage 17, full-system containers, GitHub Actions, and
  deployment.

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
├── frontend/      # Unified customer, account, and administrator React application
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
11 adds schema-only migration `0006_create_admin_user_model`. Stage 16D adds
tested migration `0007_unify_user_auth_roles`, which renames `admin_users` to
`users`, adds the constrained non-null role without a server default, and
preserves zero or one historical administrator. One historical row becomes
`super_admin` while preserving its identity, email, password hash, active state,
and timestamps; more than one makes the migration fail atomically. Its
downgrade is guarded so registered customer rows cannot be deleted. None of these
migrations runs the seed or administrator bootstrap.

Stage 16E adds `0008_add_order_ownership`, a schema-only child of 0007. It adds
nullable `orders.customer_user_id`, its `users.id` foreign key with
`ON DELETE SET NULL`, and the composite personal-history index without changing
historical rows.

Repository code, Alembic, and the current development database are at
`0008_add_order_ownership`. During Stage 16F manual-QA environment preparation,
the development database was backed up outside the repository and upgraded
additively through `0006_create_admin_user_model` ->
`0007_unify_user_auth_roles` -> `0008_add_order_ownership`. The historical
administrator was preserved as an
active `super_admin`; `users` exists, `admin_users` no longer exists, and the
Order ownership foreign key and index were verified. The Docker project
database remains published on host port 5433, while the host PostgreSQL service
on port 5432 was left untouched. Never run a downgrade against the development
database or expose backup contents, credentials, or database URLs in project
documentation.

## Unified authentication and administrator compatibility

Stage 16D evolves the Stage 11 identity into one `User` with an
application-generated UUID, normalized lowercase email, Argon2id password hash,
exact role, activation flag, and timestamps. `AdminUser` is now only a temporary
Python import alias for `User`, not a second mapped table. Public registration
creates only a customer; there is no public administrator registration.

Bootstrap passwords contain 15 through 128 Unicode code points and are
preserved exactly, including whitespace. pwdlib applies Argon2id with memory
cost 19456 KiB, time cost 2, parallelism 1, and a library-generated salt. Login
accepts password input from 1 through 128 code points because existing valid
credentials must remain usable. Passwords and hashes must never be logged.

The only first-super-admin creation boundary is the explicit interactive
command, run from `backend` after the required migrations have been explicitly
applied:

```powershell
& .\.venv\Scripts\python.exe -m app.auth.bootstrap --email <email>
```

The CLI prompts with `getpass` for the password and confirmation, so the value
is not echoed. It has no `--password` option and does not read an administrator
password from configuration. Imports, application startup, Alembic, Docker
Compose, and the menu seed never create a privileged identity automatically.
The bootstrap takes a deterministic PostgreSQL transaction advisory lock,
checks for any active or inactive `super_admin`, and creates the first one only.
Existing customer or admin rows do not block it. Concurrent attempts therefore
create exactly one `super_admin`.

Canonical register and login accept exact validated email/password bodies.
Registration passwords contain 15 through 128 code points; login input permits
1 through 128. Duplicate registration returns 409. The canonical and legacy
login aliases share one five-attempt-per-60-second direct-peer limiter, while
registration has a separate limiter. Unknown identities perform process-local
dummy verification, and credential failures do not reveal identity state.

`get_current_user` accepts canonical `user_access` for any active User.
`require_admin` accepts strict canonical `user_access` or temporary legacy
`admin_access`, reloads the current User, and permits `admin` or `super_admin`.
`require_super_admin` permits only `super_admin`. Missing, invalid, inactive, or
missing identities return 401; an authenticated insufficient role returns 403.
Role changes affect an existing token immediately because PostgreSQL state is
authoritative.

Tokens use only HS256 and contain `sub`, `type`, `iat`, `exp`, `iss`, and `aud`.
Canonical `user_access` and legacy `admin_access` have strict distinct
audiences. Production login routes issue only `user_access`; `admin_access` is
validation-only compatibility. No token carries email, active state, or role
authority. There are no refresh tokens, logout, revocation list, password
reset/change, or MFA.

Authentication configuration uses:

- `AUTH_JWT_SECRET`: canonical, no default, at least 32 UTF-8 bytes;
- `AUTH_ACCESS_TOKEN_EXPIRE_MINUTES`: canonical integer from 1 through 60,
  default 30;
- `ADMIN_JWT_SECRET` and `ADMIN_ACCESS_TOKEN_EXPIRE_MINUTES`: temporary input
  aliases for existing local environments.

Canonical-only and legacy-only configuration work, and equal dual values are
allowed. Conflicting canonical and legacy values fail safely without displaying
the secret. New configuration should use `AUTH_*`.

Keep configuration in an ignored local environment file and use HTTPS in any
deployment because Bearer tokens must not cross an unencrypted connection.
An operator must configure an ignored local authentication secret and run the
interactive bootstrap when migration 0007 produces no initial super-admin.
These are manual operational setup steps, not automated test requirements.

### Canonical frontend session and navigation

One application-wide `AuthContext` owns the browser session for customers,
administrators, and super-administrators. Its explicit phases are
`checking-session`, `authenticated`, `unauthenticated`, and
`temporarily-unavailable`. The opaque canonical `user_access` token is stored in
the versioned `restaurant-ordering:auth:v1` `sessionStorage` record, with a
current-tab memory fallback when storage is unavailable. The app never uses
`localStorage`. The old `restaurant-ordering:admin-auth:v1` record is read only
as a one-time migration candidate and is cleared after validation or rejection.

Every restored, logged-in, registered, or role-refreshed session calls
`GET /api/v1/auth/me`. That database-authoritative response supplies `role` and
`is_active`; the frontend treats the JWT as opaque and never decodes it for
authorization. Request generations and AbortController cleanup prevent stale
validation from replacing a newer session. Protected requests capture the
current token and session generation, so a 401 invalidates only that exact
session. Administrator 403 handling refreshes `/api/v1/auth/me` and lets the
role guards apply current database state.

`/login` and `/register` are the unified entry points. The default successful
destination is `/account`. A strict role-aware `next` allowlist accepts only
known local public, Order, account, and permitted administrator paths; it
rejects external or protocol-relative destinations, backslashes, traversal,
query/hash injection, unsupported paths, and authentication loops. No token or
Order capability is placed in a URL or React Router state. `/admin/login` is a
compatibility redirect only.

## Administrator operational API

Stage 12 exposes authenticated order and menu operations under
`/api/v1/admin`. The current frontend signs in through canonical
`POST /api/v1/auth/login` and validates through `GET /api/v1/auth/me`; the old
administrator auth endpoints remain backend compatibility aliases only. Every
operational route below requires the OpenAPI `AdminBearer` security scheme:

- `GET /api/v1/admin/orders`
- `GET /api/v1/admin/orders/{public_order_number}`
- `PATCH /api/v1/admin/orders/{public_order_number}/status`
- `GET /api/v1/admin/menu/categories`
- `POST /api/v1/admin/menu/categories`
- `PATCH /api/v1/admin/menu/categories/{category_id}`
- `GET /api/v1/admin/menu/items`
- `POST /api/v1/admin/menu/items`
- `PATCH /api/v1/admin/menu/items/{item_id}`

Current `admin` and `super_admin` roles may use these operational routes; a
customer receives 403. User governance is separately restricted to
`super_admin`:

- `GET /api/v1/admin/users` returns deterministic `limit`/`offset` pages with
  safe identity fields only;
- `PATCH /api/v1/admin/users/{user_id}/role` permits only
  `customer -> admin` and `admin -> customer`.

Role PATCH locks the target User row with `FOR UPDATE`. A missing target returns
404, a same-role transition or any `super_admin` target returns 409, and a
`super_admin` payload fails schema validation with 422. There is no active-state
mutation, deletion, or ordinary super-admin assignment endpoint.

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

- `/admin/login`, which redirects to unified `/login?next=%2Fadmin`;
- `/admin`;
- `/admin/orders`;
- `/admin/orders/:publicOrderNumber`;
- `/admin/menu`;
- `/admin/analytics`;
- `/admin/exports`;
- `/admin/users`, restricted to `super_admin`;
- `/admin/*` for the protected administrator-local not-found screen.

The operational route guard permits `admin` and `super_admin`; a customer is
sent to `/account`. The User-governance guard permits only `super_admin`; an
`admin` is sent to `/admin` and a customer to `/account`. Backend authorization
remains authoritative for every request.

### Administrator session

Administrators use the shared canonical `AuthContext`, `/login`,
`restaurant-ordering:auth:v1` session record, and `/api/v1/auth/me` validation
described above. There is no active administrator-auth silo. A network or HTTP
503 validation failure preserves the current session behind an explicit retry
state; frontend Logout clears it because the backend has no logout endpoint.
`adminApi` attaches the captured canonical Bearer only to allowlisted
`/api/v1/admin/...` requests. Personal-account and mixed-Order transports use
their own explicit allowlists and may use the same canonical session for any
authenticated role. An operational 401 invalidates only the captured current
session, while a 403 refreshes the database-authoritative User before the role
guard chooses a safe destination.

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

### Super-administrator User governance

`/admin/users` lists deterministic pages of safe User fields and offers only
the explicit inverse transitions `customer -> admin` and `admin -> customer`.
Rows whose role is `super_admin` are read-only. The UI cannot assign or demote a
`super_admin`, delete a User, reset a password, or change active state.

Every role action requires confirmation and is serialized to one PATCH. The UI
does not update optimistically: after success it reloads the authoritative
current page. A network, timeout, 503, or invalid-response outcome may have
changed server state, so the page locks role actions and pagination until an
explicit reconciliation GET succeeds. A mutation 401 uses generation-safe
current-session invalidation; a 403 refreshes `/api/v1/auth/me` before the role
guard applies the customer, administrator, or super-administrator fallback.

The administrator UI has automated responsive and accessibility coverage and
mobile-first CSS for navigation, orders, detail actions, menu, analytics,
exports, and User governance. User-performed manual acceptance passed at
375x812, 768x1024, and 1280x800, covering every administrator screen plus
keyboard and focus behavior.

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

`POST /api/v1/orders` creates either a `takeaway` or `dine_in` Order and returns
HTTP 201 with a `Location` header. Requests contain 1–50 unique menu
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

Without `Authorization`, creation follows the guest path and stores NULL
ownership. With a valid canonical `user_access`, it assigns the current active
User in the initial aggregate transaction; `customer`, `admin`, and
`super_admin` can all create personally owned Orders. The request schema has no
client-supplied owner field and the response does not expose ownership. A
present invalid, malformed, inactive, missing-User, or legacy `admin_access`
Bearer is rejected with HTTP 401 when authentication is resolved and is never
downgraded to guest creation.

Every successful response still contains a presentational
`public_order_number` and one-time `order_access_token`, whether the Order is
owned or anonymous. The raw capability is returned only by creation; the
database stores only its SHA-256 hash. Public status through
`GET /api/v1/orders/{public_order_number}` allows either the matching canonical
owner or a caller presenting the valid `X-Order-Access-Token`. An owner needs no
guest token, while the capability remains independently valid for an anonymous
or authenticated non-owner caller. A non-owner without it receives the same
HTTP 404 as an unknown Order; there is no public ownership 403. A present
invalid Bearer returns 401 before capability fallback when authentication is
resolved, and legacy `admin_access` is rejected by this canonical flow.

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

The endpoint has no request body. It permits the matching canonical owner or a
caller with the independent guest capability, then uses only the durable
`Order.total_amount` and `Order.currency`. Its authentication boundary matches
public status: a present invalid Bearer never falls back to a valid capability,
and a non-owner without the capability receives 404 rather than an ownership
403. Stripe receives one hosted Checkout line item in
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

Checkout preserves the D-016/D-017 state machine and short `Order -> Payment`
locking protocol. After request/idempotency validation and rate limiting, an
optional canonical identity is resolved. The first transaction locks the
Order, applies owner-or-capability access before querying or mutating Payment,
then persists or identifies the attempt. Denied access therefore creates no
Payment, provider call, or persisted idempotency effect. The Stripe call runs
with no database transaction or lock held, and short post-provider transactions
again lock `Order -> Payment` before storing or reconciling the result. A
different key conflicts with an active pending attempt, while concurrent
same-key requests converge on the same Payment and Stripe key.

The app-scoped checkout limiter allows 10 attempts per 60 seconds for each
direct peer host and returns HTTP 429 with `Retry-After` before any SQL when
denied. The endpoint uses these stable error responses:

- HTTP 401: `{"detail":"Invalid authentication credentials"}` for present
  invalid canonical authentication;
- HTTP 404: `{"detail":"Order not found"}` for unknown orders or denied
  owner-or-capability access;
- HTTP 409: `{"detail":"Order is not payable"}`,
  `{"detail":"Active payment attempt exists"}`,
  `{"detail":"Order is already paid"}`, or
  `{"detail":"Payment attempt expired"}`;
- HTTP 422: `{"detail":"Invalid Idempotency-Key"}`;
- HTTP 429: `{"detail":"Too many checkout requests"}`;
- HTTP 502: `{"detail":"Payment provider unavailable"}` for definitive
  provider rejection;
- HTTP 503: `{"detail":"Authentication service unavailable"}`,
  `{"detail":"Payment service unavailable"}`,
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

Stage 15 established the guest ordering application in `frontend/`. Stage 16F
evolves that tested flow into one React, TypeScript, Vite, and React Router
application without making registration mandatory. The current public and
account route tree is:

- `/` for the landing page;
- `/menu` for the public menu and client-side filters;
- `/cart` for cart, quote, and guest or authenticated Order creation;
- `/login` and `/register` for canonical authentication;
- `/account` and `/account/orders/:publicOrderNumber` for protected personal
  history and detail;
- `/orders/:publicOrderNumber/checkout` for hosted Checkout initiation;
- `/orders/:publicOrderNumber/payment-return` and
  `/orders/:publicOrderNumber/checkout-cancelled` for neutral Stripe returns;
- `/orders/:publicOrderNumber/status` for owner-or-capability fulfilment status;
- `*` for the public not-found screen.

For historical context, the Stage 15 baseline used `/` for the menu and had no
landing, login, registration, or account routes. Stage 16F moves that existing
menu to `/menu` and adds the new routes above; the cart and public Order URLs
remain compatible.

The frontend credential matrix is explicit:

- menu and quote use no credential;
- guest creation uses no Bearer token;
- authenticated creation uses canonical Bearer authentication and persists
  backend ownership;
- guest status uses the independent Order capability;
- authenticated status uses Bearer plus the capability when present, and an
  owner remains authorized without it;
- guest Checkout uses the capability plus `Idempotency-Key`;
- authenticated Checkout uses Bearer, the capability when present, and
  `Idempotency-Key`;
- the navigation to hosted Stripe carries no application authentication header.

The customer journey is:

1. Load `GET /api/v1/menu` without an `available_only` query parameter.
2. Filter the returned categories and availability locally; unavailable items
   remain visible by default and backend category/item ordering is preserved.
3. Add products to the cart. Duplicate additions merge into one line.
4. Change quantities within 1 through 99 and at most 50 unique products.
5. Request a server-authoritative quote after a 400 ms debounce.
6. Choose takeaway or dine-in and provide a positive table number for dine-in.
7. Obtain a fresh quote immediately before the non-idempotent order POST.
8. Create the Order once, anonymously or with the exact captured canonical
   session, and retain its one-time capability only in the current browser
   session or transient memory.
9. Start or replay one idempotent Checkout attempt and continue in the same tab
   to the validated hosted HTTPS Checkout URL.
10. Treat both Stripe return routes as navigation outcomes only, never as
    confirmation of payment.
11. Read and poll fulfilment status with owner-or-capability authorization.

Order creation, Checkout, status, and return screens wait while authentication
is checking or temporarily unavailable; they never silently downgrade that
state to anonymous access. A 401 from an authenticated request invalidates only
the captured current session and is never retried anonymously.

### Browser trust and cart contract

The browser stores only menu-item identifiers and quantities for the cart.
Names, prices, availability, currency, totals, roles, and all Order or Payment
states remain server-authoritative. Current-session persistence uses
`restaurant-ordering:auth:v1`, `restaurant-ordering:cart:v1`, per-Order
capability records, and per-Order Checkout-attempt records. Malformed,
wrong-version, duplicate, or out-of-range data is discarded. The app uses
`sessionStorage`, never `localStorage`, and keeps usable in-memory state when
browser storage is unavailable where the flow supports it. The legacy
administrator session key is accepted only for one-time migration or cleanup.

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
explicit retry remains available with a duplicate-order warning. An
unauthenticated request creates an unowned Order; an authenticated request sends
the captured canonical Bearer token so the backend writes ownership in the
initial transaction. Both responses still return the independent
`order_access_token` once. It is stored under
`restaurant-ordering:order-access:v1:<PUBLIC_ORDER_NUMBER>` for the current
session with an in-memory fallback, and is never placed in a URL, rendered in
the DOM, or logged.

### Checkout and Stripe returns

Checkout calls:

```text
POST /api/v1/orders/{public_order_number}/checkout-session
Authorization: Bearer USER_ACCESS              # authenticated session only
X-Order-Access-Token: ORDER_ACCESS_TOKEN        # when available; required for guest
Idempotency-Key: CANONICAL_LOWERCASE_UUID_V4
```

An anonymous request must provide the capability. An authenticated request
provides Bearer and also supplies the capability when this browser has it; the
matching owner works without the capability. A present invalid Bearer is a 401
and never falls back to anonymous capability-only retry.

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
Order. Both lead to the protected status screen when the current authenticated
owner or this browser's capability can authorize it.

### Fulfilment status polling

Status retrieval calls `GET /api/v1/orders/{public_order_number}`. A guest sends
the `X-Order-Access-Token` capability. An authenticated caller sends canonical
Bearer and also sends the capability when available; the persisted owner works
without it. The UI presents the six fulfilment states as `Order received`,
`Accepted`, `Preparing`, `Ready`, `Completed`, and `Cancelled`; it does not
display or infer a Payment status.

Polling starts immediately, allows one request in flight, and schedules the
next request only after the current one settles. Normal polling uses 8 seconds.
Transient failures retry after 8, 16, then at most 30 seconds. Polling pauses
while the document is hidden or the browser is offline, resumes immediately
when both visible and online, and stops at `completed`, `cancelled`, a
privacy-preserving HTTP 404, or an invalid response contract. AbortController
cleanup and the current effect generation prevent stale results from replacing
newer state. WebSockets and server-sent events are not used.

### Personal account

`/account` consumes `GET /api/v1/account/orders` with default `limit=50` and
`offset=0`, displays loading, empty, error, responsive table/card, and paginated
states, and links only to `/account/orders/:publicOrderNumber`. Detail consumes
the matching personal endpoint and reuses the same safe
`OrderStatusSummary` presentation as public status without starting polling.
Customer, administrator, and super-administrator roles all receive only their
own Orders; no administrator bypass exists.

Account transport accepts strict canonical Bearer only. A guest capability has
no account authority. Responses contain no owner ID, customer PII, Payment,
Stripe, cost, or margin data, and unknown, unowned, or cross-user detail shares
one generic 404. A current-session 401 uses generation-safe invalidation; a 503
or network failure keeps the session and offers an explicit retry.

### Visual, responsive, and accessibility direction

The customer UI uses a warm restaurant palette, readable type scale, prominent
server totals, clear availability states, focus-visible controls, semantic
headings and forms, textual status cues, and controls sized for touch. CSS
Modules contain mobile-first responsive rules for menu grids, cart lines,
forms, Checkout, return screens, account pages, and the Order timeline.
Data-driven screens provide applicable loading, empty, error, and success
states. Automated component and build checks pass. The automated browser
environment was unavailable, so the developer/user completed the required
manual local-browser QA. Final verification after Stage 16F FIX2 passed at
375x812, 768x1024, and 1280x800, including keyboard navigation, visible focus,
touch targets, long-email wrapping, home navigation from login/registration,
and protection against color-only status meaning. No manual QA blocker remains.

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
- User registration: `POST http://127.0.0.1:8000/api/v1/auth/register`
- User login: `POST http://127.0.0.1:8000/api/v1/auth/login`
- Current User: `GET http://127.0.0.1:8000/api/v1/auth/me`
- Personal Order history: `GET http://127.0.0.1:8000/api/v1/account/orders`
- Personal Order detail: `GET http://127.0.0.1:8000/api/v1/account/orders/{public_order_number}`
- Administrator user list: `GET http://127.0.0.1:8000/api/v1/admin/users`
- Administrator role change: `PATCH http://127.0.0.1:8000/api/v1/admin/users/{user_id}/role`
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

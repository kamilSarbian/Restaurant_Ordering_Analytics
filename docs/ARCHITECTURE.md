# Nordic Hearth System Architecture

## 1. Architectural Goals

The architecture must ensure financial data correctness, secure Stripe
integration, clear separation of responsibilities, and ease of demonstration.
The system remains simple enough for one person to develop and explain during a
job interview.

## 2. Selected Stack

### Backend

- Python 3.12 as the target version;
- FastAPI;
- Pydantic 2;
- SQLAlchemy 2;
- Alembic;
- PostgreSQL 17;
- pytest;
- Ruff, Black, and isort in accordance with repository rules.

### Frontend

- React 19;
- TypeScript 6;
- Vite 8;
- React Router 7;
- React Context for the cart and canonical application authentication session;
- CSS Modules and shared CSS design tokens;
- native `fetch`, `sessionStorage`, Vitest, and React Testing Library.

The customer, account, and administrator route trees share one canonical
authentication Context. Feature-local rendering and native HTML/CSS remain
sufficient; Zustand and Recharts were not required.

### Integrations and Infrastructure

- Stripe Checkout and Stripe webhooks in test mode;
- Docker and Docker Compose;
- GitHub Actions;
- a prepared Render target with an Nginx frontend web service, private backend
  service from an immutable GHCR digest, isolated migrator, and managed
  PostgreSQL 17.

The Stage 20 Blueprint and manual release workflow are repository configuration
only. Neither has been executed, no production resource or public URL exists,
and provisioning remains Stage 22 work.

## 3. Architecture Style: Modular Monolith

The backend is one application deployed as a single process, but the code is
divided by business capability. Modules communicate within the process and use
a shared PostgreSQL database. Module boundaries prevent accidental mixing of
responsibilities but do not create network boundaries between microservices.

Each module may contain only the elements it needs:

- SQLAlchemy models;
- Pydantic schemas;
- FastAPI routers;
- business logic;
- queries or data-access operations;
- tests.

A separate layer will not be created merely to pass through a single call.
Domain logic remains independent of FastAPI, Stripe, and interface-rendering
details where doing so improves testability.

## 4. Main Backend Modules

| Module              | Responsibility                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `core`              | configuration, security, shared errors, and cross-cutting concerns                           |
| `database`          | engine, sessions, model base, and migration integration                                      |
| `auth`              | unified User persistence, bootstrap, registration, sign-in, JWT, and role authorization      |
| `categories`        | categories and their order in the menu                                                       |
| `menu`              | menu items, prices, allergens, activity, and availability                                    |
| `restaurant_tables` | tables and dine-in order validation                                                          |
| `orders`            | quoting, orders, snapshots, public access, `order_status`, and its history                   |
| `payments`          | `Payment` attempts, Stripe sessions, `payment_status`, webhook verification, and idempotency |
| `analytics`         | KPI definitions and dashboard aggregations                                                   |
| `reports`           | filtered CSV exports                                                                         |

## 5. Flow Between Components

### 5.1. Menu Retrieval

React calls public FastAPI endpoints. The categories and menu modules read
active records from PostgreSQL. Active but unavailable items remain visible by
default, while an optional availability filter hides them. FastAPI returns
explicit public response schemas without administrative data.

### 5.2. Order and Payment

React submits only product identifiers, quantities, and order-type data.
FastAPI validates the data in PostgreSQL, calculates amounts, and stores the
order and snapshots without creating a `Payment` and without communicating with
Stripe. The response contains the `public_order_number` and, once, the raw
`order_access_token`.

A separate Checkout endpoint requires the `public_order_number` and
`Idempotency-Key`, and authorizes either the matching canonical owner or the
independent `X-Order-Access-Token` capability. It creates a
`Payment(status=pending)` for the amount stored on `Order`, then creates a
Stripe session. The same order and key pair cannot create another attempt or
session. Stage 9 implements this Checkout boundary, Stage 10 implements the
verified webhook boundary, and Stage 16E adds owner-or-capability access without
changing the financial state machine.

The Stripe call does not occur inside a database transaction. A short
transaction first locks `Order`, checks `Payment`, and stores the new attempt
and idempotency data. Stripe is called after the transaction commits. The
session identifier or failure outcome is stored in another short transaction,
again following the `Order -> Payment` order.

### 5.3. Authentication, Administration, and Analytics

The first-super-admin bootstrap flow is `CLI -> email normalization -> password
confirmation and policy validation -> Argon2id hashing -> short database
transaction -> transaction advisory lock -> existing-super-admin check -> User
insert -> commit`. Password and confirmation are read through `getpass`; no
password CLI argument, automatic account, or token is created. Normalization,
password validation, and hashing are application work performed before the
database critical section. The short transaction-level advisory lock serializes
only the race-sensitive check and insert. Customer and admin rows do not block
the first super-admin, while any active or inactive super-admin does. Concurrent
attempts therefore insert exactly one first super-admin.

Canonical registration creates only a customer. Canonical login uses exact User
lookup plus real or dummy Argon2 verification and issues only `user_access`.

The protected-request flow is `strict JWT validation -> current active User
SELECT -> database role check -> endpoint`. `get_current_user` accepts canonical
tokens, `require_admin` permits current `admin` or `super_admin`, and
`require_super_admin` permits only `super_admin`. Every request checks current
database state, so deactivation or a role change takes effect immediately.
Public routes are not globally protected. Operational orders, menu, analytics,
and reports use `require_admin`; role management uses `require_super_admin`.
React presents results but does not define permissions or KPI rules.

### 5.4. Independent Status Lifecycles

Each payment attempt has its own `payment_status`: `pending`, `succeeded`,
`failed`, or `expired`. Transitions are one-way and lead only from `pending` to
one of the terminal states. Retrying payment creates a new attempt record; it
does not change a completed record to `pending`.

The relationship is `Order 1:N Payment`. At most one `pending` attempt and at
most one `succeeded` attempt may exist for an order. A new attempt is allowed
only when neither status exists. PostgreSQL protects the constraints with two
partial unique indexes, while application logic handles conflicts between
concurrent requests. The source of payment confirmation is a related
`Payment(status=succeeded)` record, not an auxiliary value on `Order`.

Order fulfilment uses a separate `order_status`: `created`, `accepted`,
`preparing`, `ready`, `completed`, or `cancelled`. The allowed transition graph
is:

```mermaid
stateDiagram-v2
    [*] --> created
    created --> accepted: Payment(status=succeeded) exists
    created --> cancelled: no Payment(status in [pending, succeeded])
    accepted --> preparing
    preparing --> ready
    ready --> completed
```

There are no backward transitions. `paid` and `pending_payment` are not part of
`order_status`. An `Order` may transition to `cancelled` only when no `Payment`
has status `pending` or `succeeded`. `failed`, `expired`, and the absence of
attempts do not block cancellation. An active `pending` attempt produces a
domain conflict with the provisional name `active_payment_attempt`; the
customer or administrator waits for the attempt to finish.

Checking `Payment` attempts and writing `order_status = cancelled` must be part
of one transactional operation. The logic reads state from the database and
does not trust status values submitted by the frontend. This prevents a race in
which an active Checkout Session ends with a later success webhook.

After successful payment, the order cannot be cancelled in the MVP; the
`accepted -> cancelled` transition does not exist. `order_status = cancelled`
does not change `payment_status`. The MVP does not automatically expire Stripe
sessions during cancellation and does not cancel an order with an active
session. Every `order_status` change is audited in the history. A future
`refund_status` will be a third, independent lifecycle and will allow later
design of paid-order cancellation.

### 5.5. Concurrency Control for Financial Operations

Order cancellation, creation of a new `Payment`, and Stripe webhook handling
serialize critical changes by locking the relevant `Order` record. Each flow:

1. starts a short transaction;
2. locks `Order`, for example with `SELECT ... FOR UPDATE`;
3. reads or locks related `Payment` records in a stable order;
4. checks invariants and idempotency;
5. stores the change;
6. commits the transaction.

The only allowed lock order is `Order -> Payment`. No flow may lock `Payment`
first and then wait for `Order`. Locking and state retrieval happen on the
backend; the frontend does not provide authoritative payment or order state.

Partial unique indexes for one `pending` and one `succeeded` payment per
`Order` remain a mandatory second line of protection. An index conflict is
handled explicitly and cannot result in a second attempt.

A transaction does not include waiting for Stripe. Checkout uses a stable
idempotency key and at least two short database phases: preparing the attempt
before the call and storing the result after the call. Every phase that changes
`Order` or `Payment` again follows `Order -> Payment` and rechecks the
invariants because state may have changed during the external operation.

Checkout same-key requests reuse one durable attempt and the stable Stripe key
`checkout-session:{payment_uuid}`. Concurrent requests with a different key
observe the existing pending attempt and fail without creating another one.
An incomplete pending attempt is eligible for provider replay for less than 23
hours. At or after that conservative cutoff, or after conflicting provider
state is observed, it remains pending for reconciliation; local time alone
never changes it to `expired`. Definitive provider rejection may mark the
attempt `failed`, while an ambiguous result stays `pending`.

### 5.6. Public Order Access

`Order` has a presentational `public_order_number` and a separate
`order_access_token` with at least 256 bits of randomness. The raw token is
returned only when the order is created. The database stores only its SHA-256
hash, and verification compares the calculated hash in constant time.

Public status retrieval requires the number and authorizes either a current
canonical User whose ID matches the persisted owner or a caller presenting the
valid `X-Order-Access-Token`. The capability stays independently valid for an
owned Order. An unknown number or denied owner/capability check produces the
same generic 404, never an ownership-revealing public 403. A present invalid
Bearer returns 401 before capability fallback. The response contains only the
public number,
`status`, order type, optional table-number snapshot, currency, public
historical item lines, totals, and creation and update timestamps. Stage 9 does
not add `payment_summary` even though Payment persistence now exists.

### 5.7. MVP Analytics

The implemented `backend/app/analytics/` package contains `router.py`,
`service.py`, `schemas.py`, and `__init__.py`. The router owns query validation,
the existing `require_admin` dependency, and the HTTP boundary only. Strict
Pydantic schemas require aware timestamps, expose integer minor-unit values,
and keep currencies separate. The service owns the shared qualified-payment
source and set-based PostgreSQL aggregation; it performs no DML, provider call,
or current-catalog join.

The shared source includes only `Payment(status=succeeded)` rows with a matching
StripeEvent for the same Payment, a transition-capable successful event type,
and `processing_result=transitioned`. Its authoritative success time is
`MIN(StripeEvent.stripe_created_at)`. A succeeded Payment without such a
receipt is excluded from time-bounded analytics; there is no fallback to
`Payment.updated_at`.

The six metrics are collected revenue, succeeded paid-order count, average
order value, product sales, category sales, and dine-in versus takeaway.
Revenue sums qualified `Payment.amount`, order count uses distinct
`Payment.order_id`, and average order value is rounded `ROUND_HALF_UP` per
currency in integer minor units. Product and category breakdowns aggregate
historical `OrderItem` snapshots; categories group by the historical name
because no historical Category UUID exists. Catalog mutations cannot rewrite
these results.

All four endpoints require aware `start` and `end`, filter the half-open
`[start, end)` interval as UTC instants, and return range metadata normalized
to `Europe/Oslo`. An optional strict uppercase three-letter currency filter is
supported. Currencies are never combined and no FX conversion is performed.

Overview and order-type endpoints each execute one set-based aggregate SELECT.
Product and category endpoints execute one set-based aggregate SELECT with
per-currency ranking through PostgreSQL window functions. Thus every endpoint
performs one analytics SELECT after authentication, with no N+1 queries,
Python full-table grouping, Pandas, DML, or Stripe network access.

The Stage 13 performance audit used EXPLAIN on isolated PostgreSQL and observed
the expected aggregates, joins, and window operations. Sequential scans on the
tiny test relations are not blocking. Existing indexes are sufficient for the
MVP single-restaurant scale, so no analytics persistence, materialized view,
new index, or migration was introduced by Stage 13. Migration 0007 was added
later by Stage 16D for unified identities. Index tuning is deferred until a
measured production-scale need exists.

Refunds are outside the MVP, so collected revenue is not automatically reduced
by refunds. Refund-adjusted revenue and other extended KPIs remain later work.

### 5.8. Implemented CSV Reports

The implemented `backend/app/reports/` package contains `__init__.py`,
`schemas.py`, `csv_utils.py`, `service.py`, and `router.py`. Schemas define
strict aware-range, uppercase-currency, order-status, and order-type query
contracts and reject unknown parameters. CSV utilities own UTF-8-SIG encoding,
the single BOM, comma/minimal-quoting/CRLF dialect, formula safety, NUL removal,
deterministic filenames, and Europe/Oslo datetime formatting. The service owns
set-based data retrieval and CSV row mapping. The router owns the canonical
`UserBearer` boundary and the CSV HTTP response headers.

The reports service reuses the analytics service's qualified
succeeded-Payment source. Product aggregation is also shared: Stage 13 JSON
applies a per-currency top-N rank, while product-sales CSV invokes the same
aggregation without a cutoff. Success-event qualification is therefore not
duplicated, and reports do not call analytics endpoints over HTTP.

The query boundary is one report SELECT after administrator authentication for
each dataset:

- `orders.csv` performs one Order SELECT over the half-open
  `Order.created_at` range and orders by creation time and internal ID;
- `product-sales.csv` performs one set-based aggregate SELECT over the shared
  qualified-Payment source and historical OrderItem snapshots;
- `payments.csv` performs one set-based qualified-Payment SELECT joined to
  Order only for the public order number.

All three paths perform zero DML, make no provider call, avoid N+1 queries, and
create no local CSV file. The response is generated completely in memory. This
has no silent truncation and is acceptable for the current single-restaurant
MVP scale; streaming and background exports remain deferred until measured
volume justifies them.

The Stage 14B-3 performance audit ran EXPLAIN for all three statements on
isolated PostgreSQL. The plans had no blocking issue, existing indexes were
sufficient for current scale, and sequential scans on tiny relations were not
a concern. Stage 14 introduced no index or migration; migration 0007 was added
later by Stage 16D. Future indexing, streaming, or background processing remains
measurement-driven rather than an unverified enterprise-scale claim.

### 5.9. Menu, Order, and Administrator Data Model

```mermaid
erDiagram
    CATEGORIES ||--o{ MENU_ITEMS : contains
    RESTAURANT_TABLES o|--o{ ORDERS : serves
    USERS o|--o{ ORDERS : optionally_owns
    ORDERS ||--|{ ORDER_ITEMS : contains
    MENU_ITEMS ||--o{ ORDER_ITEMS : snapshots
    ORDERS ||--|{ ORDER_STATUS_HISTORY : records
    ORDERS ||--o{ PAYMENTS : attempts
    PAYMENTS o|--o{ STRIPE_EVENTS : correlates

    USERS {
        uuid id PK
        varchar email UK
        text password_hash
        varchar role
        boolean is_active
        timestamptz created_at
        timestamptz updated_at
    }

    CATEGORIES {
        uuid id PK
        varchar name
        text description
        int display_order
        boolean is_active
        timestamptz created_at
        timestamptz updated_at
    }

    MENU_ITEMS {
        uuid id PK
        uuid category_id FK
        varchar name
        text description
        varchar image_url
        int price_amount
        int cost_amount
        varchar currency
        text_array allergens
        int display_order
        boolean is_active
        boolean is_available
        timestamptz created_at
        timestamptz updated_at
    }

    RESTAURANT_TABLES {
        uuid id PK
        int number UK
        boolean is_active
        timestamptz created_at
        timestamptz updated_at
    }

    ORDERS {
        uuid id PK
        varchar public_order_number UK
        varchar order_access_token_hash UK
        uuid customer_user_id FK
        varchar order_type
        uuid table_id FK
        int table_number_snapshot
        varchar status
        varchar currency
        bigint subtotal_amount
        bigint total_amount
        timestamptz created_at
        timestamptz updated_at
    }

    ORDER_ITEMS {
        uuid id PK
        uuid order_id FK
        uuid menu_item_id FK
        int position
        varchar category_name_snapshot
        varchar name_snapshot
        int quantity
        int unit_price_amount
        int unit_cost_amount
        int tax_rate_bps_snapshot
        bigint discount_amount_snapshot
        bigint line_total_amount
    }

    ORDER_STATUS_HISTORY {
        uuid id PK
        uuid order_id FK
        int sequence
        varchar previous_status
        varchar new_status
        timestamptz changed_at
    }

    PAYMENTS {
        uuid id PK
        uuid order_id FK
        varchar status
        bigint amount
        varchar currency
        uuid request_idempotency_key UK
        varchar stripe_idempotency_key UK
        varchar stripe_checkout_session_id UK
        text stripe_checkout_url
        timestamptz stripe_checkout_expires_at
        timestamptz created_at
        timestamptz updated_at
    }

    STRIPE_EVENTS {
        uuid id PK
        varchar stripe_event_id UK
        varchar event_type
        boolean livemode
        timestamptz stripe_created_at
        varchar stripe_checkout_session_id
        uuid payment_id FK
        varchar processing_result
        timestamptz created_at
    }
```

Category and MenuItem identifiers are UUIDs generated by the application.
`cost_amount` is nullable because an unknown cost differs from a known zero
cost. `text_array` in the diagram represents PostgreSQL `TEXT[]`, tracked by
SQLAlchemy `MutableList`. All monetary values use integer minor units.

The relationship uses `ON DELETE RESTRICT`, `passive_deletes="all"`, and no ORM
delete cascade. Names remain stored as provided, while functional indexes apply
`lower(btrim(name))` to enforce case-insensitive and trim-insensitive
uniqueness. `is_active` controls long-term visibility; MenuItem
`is_available` independently represents temporary sellability, so an active
item may remain visible while unavailable.

Stage 8 adds RestaurantTable, Order, OrderItem, and OrderStatusHistory. A
takeaway order has no table relationship or table snapshot. A dine-in order
references one RestaurantTable and stores its number independently as a
historical snapshot. Table and Order-aggregate foreign keys use
`ON DELETE RESTRICT`, and ORM aggregate relationships use no delete or
delete-orphan cascade. Stage 16E's ownership foreign key is the deliberate
exception: nullable `orders.customer_user_id` references `users.id` with
`ON DELETE SET NULL`, so a future User deletion can preserve the complete Order
history. No User-delete API currently exists, and there is intentionally no
User-to-Order ORM ownership relationship.

Migration `0008_add_order_ownership`, whose parent is
`0007_unify_user_auth_roles`, adds ownership with no default, data rewrite, or
backfill. Historical Orders remain NULL and there is no fake guest User, guest
role, or retroactive claim. The one non-unique
`ix_orders_customer_user_created_at_id` index covers
`(customer_user_id, created_at, id)`. It supports owner filtering and backward
index traversal for deterministic `created_at DESC, id DESC` account history;
there is no redundant `customer_user_id`-only index.

OrderItem deliberately denormalizes category name, item name, quantity, unit
price, nullable unit cost, tax-rate placeholder, discount placeholder, and line
total. The Order stores currency, subtotal, and total. Derived totals use
`BIGINT`; Stage 8 stores no tax calculation and no discount calculation.
Historical snapshots are not changed by later MenuItem, Category, or
RestaurantTable updates.

Stage 9 adds `Payment` as one persisted Checkout attempt in the
`Order 1:N Payment` relationship. The Order foreign key uses
`ON DELETE RESTRICT`; the ORM has `passive_deletes="all"` and no delete or
delete-orphan cascade. `UNIQUE(order_id, request_idempotency_key)` scopes
request replay to one Order, while Stripe idempotency keys and non-null Checkout
Session IDs are globally unique. Partial unique indexes enforce at most one
`pending` and one `succeeded` attempt per Order. The non-unique
`(order_id, created_at, id)` index gives deterministic payment history access.
Checkout fields are either all null or all populated, amount is positive, and
currency is exactly three uppercase ASCII letters.

Stage 10 adds StripeEvent as a durable receipt for one in-scope provider event.
The globally unique `stripe_event_id` makes redelivery idempotent across process
restarts. `payment_id` is nullable so an authentic event with unknown or
malformed correlation can still be retained for reconciliation; when present,
its Payment foreign key uses `ON DELETE RESTRICT`. Check constraints limit event
types and processing results and reject blank event and Checkout Session IDs.
The `(payment_id, stripe_created_at, id)` and
`(stripe_checkout_session_id, stripe_created_at, id)` indexes support ordered
history access.

Stage 11 originally adds `admin_users`; Stage 16D migration 0007 evolves it into
the unified `users` table. A User has an application-generated UUID, unique
normalized lowercase email, nonblank Argon2id hash, active flag, aware
timestamps, and exactly one constrained role: `customer`, `admin`, or
`super_admin`. The role is a `VARCHAR`, is non-null, has a database `CHECK`, and
has no server default. There is no Role table, join table, token version, reset,
MFA, plaintext password, or relationship to guest orders. The temporary
`AdminUser` Python import alias used during the identity migration was removed
by Stage 16G; runtime code uses `User` only.

### 5.10. Local Demonstration Seed

The seed has an immutable, typed data layer containing fixed UUIDs and a
transactional runner that performs normalized-name preflight checks followed by
conditional PostgreSQL primary-key upserts. One transaction contains every
preflight and write. Seed ownership is limited to the approved fixed UUIDs;
unrelated records are never deleted, replaced, or claimed by name.

The explicit `python -m app.seed` CLI is a local-only integration boundary. It
validates the exact development database allowlist before creating an Engine.
Imports have no side effects, and the seed has no application startup,
migration, Docker Compose, CI, deployment, or other automatic hook. Conditional
`IS DISTINCT FROM` updates restore canonical values while preserving
`created_at` and avoiding an `updated_at` change for a no-op rerun.

### 5.11. Implemented Public Menu API

The FastAPI application is created through an injectable app factory. Its
lifespan creates one synchronous SQLAlchemy Engine and session factory for a
normal application run, stores the factory in application state, and disposes
the owned Engine at shutdown. Tests may inject a session factory whose Engine
lifecycle remains owned by the fixtures. Importing the application does not
connect, query, migrate, or seed.

A request dependency creates and closes one synchronous Session without an
automatic commit. The public menu router is mounted at `/api/v1/menu` and uses
five strict Pydantic response schemas. The schemas are populated explicitly;
ORM entities are not serialized, so `cost_amount`, timestamps, internal
activity state, and raw product category identifiers cannot leak into the
contract.

The read-only query layer uses two column-level SELECT statements for a
non-empty menu: one for active categories and one for active items. If no
active category exists, only the category SELECT runs. Item details use one
column-level SELECT with a Category join. This avoids lazy loading and N+1
access while keeping database work independent of FastAPI.

The default list and detail view include active but unavailable items with
`is_available=false`; `available_only=true` removes unavailable items from the
list. Inactive categories, their items, inactive items, and categories without
visible items are omitted. Categories and items are ordered by
`display_order`, then UUID. This read path does not change the Stage 4 ERD.

### 5.12. Implemented Order Quoting

The `orders` package retains a separate public quote use case with request and
response schemas, a FastAPI-independent quoting layer, and the
`/api/v1/orders/quote` route. Quote remains transient even though the package
now also contains persistent Stage 8 order models and creation logic.

The request accepts only unique menu item identifiers and quantities. The
quoting layer executes one explicit column-level SELECT joining `MenuItem` and
`Category`, then validates item activity, category activity, and availability
in request order. Mixed currency is checked only after all item-level
validation succeeds. The response preserves request order.

All price calculations use Python integers and minor units. Names, unit prices,
and currency come from the database. The quote is a transient point-in-time
snapshot with no identifier, timestamp, expiry, persistence, or reservation.
The operation executes zero writes and does not alter the Stage 4 ERD.

The router maps missing and non-public items to 404, unavailable items to 409,
mixed currencies to a distinct 409 detail, and request validation to the
standard 422 response. Order creation ignores previous quote responses,
re-reads all authoritative menu state, and creates durable snapshots only when
an Order is persisted.

### 5.13. Implemented Order Creation and Public Status

`create_order()` owns one short synchronous `Session.begin()` transaction. It
revalidates server-authoritative MenuItem and Category activity, availability,
names, prices, costs, and currency. Requests contain only order type, optional
table number, identifiers, and quantities. The transaction writes one Order,
ordered OrderItem snapshots, and the initial `created` history entry, then
builds the public response after commit. Any validation or persistence failure
rolls back the complete aggregate.

Dine-in creation locks and validates RestaurantTable with `FOR SHARE` before
locking MenuItem and Category rows. Menu rows are locked in deterministic
MenuItem UUID order. Takeaway performs one locked SELECT; dine-in performs the
table SELECT followed by the menu/category SELECT. Shared locks permit
concurrent independent creations while blocking conflicting source updates or
deletes until the creation transaction ends.

Optional canonical authentication is resolved after the creation limiter. An
absent Authorization header enters the guest path without requiring the auth
service or a User query. A valid `user_access` reloads the current active User;
any present malformed, invalid, legacy, inactive, or missing-User credential
returns 401 rather than falling back to guest. Auth configuration or User-query
failure returns a safe 503.

The trusted `customer_user_id` or NULL is written in the initial Order
constructor inside the same aggregate transaction, not through a follow-up
UPDATE. The public request cannot supply an owner, and current public/account
routes cannot mutate or claim ownership. The creation response contains the
one-time raw guest capability and a presentational public number for every
Order; only the SHA-256 capability hash is persisted. Public status reads the
Order and item snapshots through explicit column-level queries, applies the
role-independent owner-or-constant-time-capability decision before reading
items, executes no writes, and exposes no owner, internal Order UUID,
OrderItem ID, cost, token hash, Payment, or Stripe field.

The app-scoped fixed-window limiter allows 10 creation attempts per 60 seconds
for each direct `request.client.host`. It is thread-safe, per process, resets on
restart, has an injectable monotonic clock, and returns a positive
`Retry-After`. Forwarded headers are intentionally ignored until a trusted
proxy configuration exists. Stage 8 has no creation idempotency: each valid
POST creates a distinct Order.

The pure cancellation policy allows only an Order in `created` without a
blocking payment to be cancelled. Stage 9 verifies D-016 against persisted
Payment rows and verifies the D-017 `Order -> Payment` lock protocol through
PostgreSQL integration and concurrency tests. The administrative cancellation
command itself remains part of the later operational API stage.

### 5.14. Implemented Stripe Checkout

The `payments` module separates persistence, pure status policy, strict public
schemas, the Stripe adapter, orchestration, and the FastAPI transport. The
official Stripe Python SDK is constrained to `stripe>=15.4.0,<16`. An
app-scoped `StripeClient` holds its own secret instead of mutating a global SDK
key, and automated tests inject a narrow fake client that performs no network
request.

`POST /api/v1/orders/{public_order_number}/checkout-session` has no request
body. It requires a canonical lowercase hyphenated UUIDv4 `Idempotency-Key` and
authorizes the matching canonical owner or a valid independent
`X-Order-Access-Token`. The server owns amount and currency and creates one
hosted `mode=payment` line item. Safe metadata contains only internal Order and
Payment identifiers and the public order number; it contains no guest token.
Redirect templates accept an absolute HTTP(S) URL with at most the approved
`{public_order_number}` placeholder.

The exact transport and financial ordering is request/idempotency validation,
rate limiting, optional canonical User resolution, a short transaction,
`Order SELECT ... FOR UPDATE`, owner-or-capability authorization, and only then
the existing Payment query/lock/mutation. User resolution uses a separate short
session and takes no User lock, so it introduces no `User -> Order` lock edge.
Denied access performs no Payment query or mutation, provider call, or persisted
idempotency work. Phase 1 then rejects a non-`created` fulfilment state or
returns, selects, or creates the durable attempt. The Stripe call occurs only
after commit, with no database transaction or row lock. Short post-provider
transactions again lock `Order -> Payment`, recheck invariants, and store or
reconcile the result without overwriting conflicting state.

The endpoint returns 201 for a newly persisted attempt and 200 for an
idempotent replay. Stable errors cover authentication 401, access 404, state
409, invalid-key 422,
rate-limit 429 with `Retry-After`, definitive-provider 502, and local,
ambiguous, or reconciliation 503 outcomes. The independent app-scoped checkout
limiter permits 10 attempts per 60 seconds per direct peer host before any SQL.
Checkout URLs are sensitive and must not be logged. The public response exposes
no internal IDs, Stripe Session ID, idempotency key, guest credential, or token
hash.

Stage 9 creates `pending` and may persist `failed`. Stage 10 now verifies
webhooks and owns provider-confirmed `succeeded`, `failed`, and `expired`
transitions. If a webhook succeeds after the provider call but before Checkout
Phase 3, Phase 3 may fill the complete all-null provider session tuple for that
exact already-succeeded Payment without regressing its status. The same fill is
forbidden after `failed` or `expired`.

### 5.15. Implemented Stripe Webhook

`POST /api/v1/stripe/webhook` is a provider-facing asynchronous route hidden
from OpenAPI. It reads `request.body()` exactly once and passes the unchanged
bytes and `Stripe-Signature` header to `StripeWebhookVerifier`. The adapter uses
the official Stripe SDK with a 300-second default tolerance and returns either
minimal immutable Checkout facts or an ignored out-of-scope event. It performs
no provider network request.

For an in-scope event, the webhook service parses internal metadata and starts a
short transaction. A known correlation locks Order first, then all related
Payments with `FOR UPDATE` ordered by `created_at, id`. It rechecks event-ID
idempotency, validates Payment ID, Order ID, public number, Checkout Session ID,
mode, amount, and currency, then inserts the StripeEvent receipt atomically with
any Payment transition. Unknown correlation uses a short PostgreSQL
`INSERT ... ON CONFLICT DO NOTHING` transaction and stores a nullable-Payment
reconciliation receipt without inventing a Payment.

Completed paid and asynchronous-success events may transition pending to
`succeeded`; asynchronous failure may transition it to `failed`; an unpaid
expired session may transition it to `expired`. Completed unpaid remains
pending with `awaiting_async_payment`. The first terminal result wins, so later
contradictory events are durably receipted as `reconciliation_required` without
changing Payment. Signed out-of-scope events are acknowledged without a
receipt, while sequential and concurrent duplicates converge on one receipt.

The shared `Order -> Payment` lock order is also used by Checkout and the future
cancellation transaction. PostgreSQL concurrency tests cover duplicate races,
opposing terminal events, webhook-before-Checkout-Phase-3, and webhook versus
future cancellation without deadlocks.

### 5.16. Implemented Unified Authentication and Role Authorization

pwdlib uses Argon2id with memory cost 19456 KiB, time cost 2, parallelism 1,
and a library-generated salt. Bootstrap accepts 15 through 128 Unicode code
points without trimming or composition rules. Login accepts 1 through 128 code
points and performs one process-local, lazily generated dummy verification when
the normalized identity is absent. No static dummy credential or hash exists.

The token service uses only HS256 and requires at least 32 UTF-8 bytes of key
material. Tokens contain exactly `sub`, `type`, `iat`, `exp`, `iss`, and `aud`;
the subject is a canonical User UUID. `user_access` is the only runtime token
family, and `UserBearer` is the only OpenAPI bearer security scheme. No token
contains role authority. The default lifetime is 30 minutes and configuration
permits 1 through 60 minutes. There is no refresh, revocation, backend logout,
password reset/change, or MFA.

`POST /api/v1/auth/register`, `POST /api/v1/auth/login`, and
`GET /api/v1/auth/me` are the canonical contracts. Registration always creates
an active customer and rejects privilege fields. The former
`POST /api/v1/admin/auth/login` and `GET /api/v1/admin/auth/me` compatibility
routes are intentionally not mounted and return 404. Canonical login uses an
app-scoped fixed-window limiter allowing five attempts per 60 seconds for each
direct peer. Registration has a separate limiter. Both ignore
`X-Forwarded-For`.

Every protected auth request reloads the current User, role, and active state
from PostgreSQL. Missing, malformed, expired, or otherwise invalid tokens and
missing or inactive identities share a Bearer-challenged 401; an authenticated
identity with an insufficient role returns 403. The auth service is optional at
general startup when no JWT secret is configured, but protected auth operations
then return 503. The Stripe webhook remains hidden.

Runtime authentication configuration uses only `AUTH_JWT_SECRET` and
`AUTH_ACCESS_TOKEN_EXPIRE_MINUTES`; no legacy authentication configuration alias
is read.

### 5.17. Implemented Administrator Operational API

Stage 12 keeps HTTP, validation, and database responsibilities separated. The
orders module uses `admin_router.py`, `admin_schemas.py`, and
`admin_service.py`; the menu module uses the corresponding `admin_*` files.
Routers apply `require_admin` and map stable HTTP errors. Services contain no
FastAPI or JWT logic and return strict detached response schemas.

Administrator order reads use one count and one deterministic page query for
the list, while detail reads the Order, immutable OrderItem snapshots, ordered
history, and ordered Payment summaries without N+1 loading. The summary omits
StripeEvent data, Checkout URLs, Session IDs, idempotency keys, and guest access
material.

Status mutation starts a short transaction and locks the Order with
`FOR UPDATE`. The transition graph is checked before payment reads.
Payment-sensitive acceptance and cancellation then lock related Payments in
`created_at, id` order, preserving the shared `Order -> Payment` protocol.
Acceptance requires a succeeded attempt. Cancellation preserves D-016: pending
and succeeded attempts block it, while failed, expired, or absent attempts do
not. The Order status update and exactly one history insert commit atomically;
the Order lock serializes the next history sequence. No Stripe provider call is
made while these locks are held, and Stage 12 adds no actor field.

Administrator menu lists use one count and one deterministic page query and
include inactive resources. Create and PATCH operations use short transactions;
PATCH locks its target row with `FOR UPDATE`. PostgreSQL normalized unique
indexes remain the final arbiter for global category names and category-scoped
menu-item names. Known uniqueness violations alone become 409 conflicts.
Category and item changes are soft: there is no DELETE, item activity and
availability remain independent, category deactivation does not rewrite child
flags, and historical OrderItem snapshots remain unchanged. The separate public
menu router stays unauthenticated and retains its existing visibility rules.

Stage 12 changes no SQLAlchemy model and requires no migration after
`0006_create_admin_user_model`. RestaurantTable administration, refunds,
StripeEvent diagnostics, a generic audit log, and analytics remain outside this
operational API.

### 5.18. Implemented Administrator Frontend Runtime

The administrator frontend is grouped around explicit trust and feature
boundaries:

```text
frontend/src/
|-- api/adminApi.ts
|-- components/admin/
|-- features/auth/
|-- features/admin-orders/
|-- features/admin-menu/
|-- features/admin-analytics/
|-- features/admin-exports/
|-- features/admin-users/
`-- routes/adminRoutes.tsx
```

`adminApi.ts` owns one canonical `/api/v1/admin/...` validator, Bearer-header
creation, timeout/abort classification, and shared execution for JSON and Blob
responses. Feature modules use native `fetch` only through this transport and
strict feature-local parsers or request builders. There is no global Bearer
interceptor. `adminApi` cannot attach Bearer outside its administrator
allowlist; account and mixed-Order transports use separate explicit allowlists
and may receive the same canonical session for any authenticated role.

The application-wide `AuthContext` keeps the current opaque canonical token in
memory and uses the exact versioned `restaurant-ordering:auth:v1`
`sessionStorage` record containing only `version` and `accessToken`. A storage
failure leaves a newly authenticated current-tab session usable in memory. The
legacy `restaurant-ordering:admin-auth:v1` record is a one-time migration or
cleanup input, not a second live session. Canonical `/api/v1/auth/me` validation
must succeed before `AdminShell` renders; a current-session 401 clears that
session, while network or 503 validation failure preserves it behind explicit
retry. The app never uses `localStorage`, and no token enters a URL, Router
state, DOM node, or log. Frontend logout clears this state because the backend
has no logout endpoint.

Order list/detail views remain read-only except for explicit detail actions
derived from the current status. Mutation requires inline confirmation and
allows one PATCH in flight. The client performs no optimistic update and creates
no history or Payment representation. Success is followed by authoritative GET
refetch. PATCH success followed by GET failure is distinguished from a failed
PATCH; network, timeout, uncertain server failure, and unresolved 409 outcomes
activate a refresh gate before another action.

Menu administration uses GET/POST/PATCH only. PATCH bodies contain changed
fields only, and no optimistic mutation is applied. An ambiguous result requires
Refresh before resubmission. Administrator forms are NOK-only at fixed scale
two and accept exact major-unit decimal strings; string/BigInt conversion
preserves the API's integer minor-unit contract without floating-point parsing
or silent rounding. Inactive categories returned by the backend remain
operationally selectable for item reassignment, and catalog changes never
rewrite historical OrderItem snapshots.

The shared reporting date helper accepts only date values, computes
Europe/Oslo local midnight with an explicit offset, and converts the selected
inclusive end date to the next local midnight for an aware half-open
`[start, end)` query. It is DST-tested and independent of the host local time
zone; `datetime-local` is not used. Analytics starts four requests in parallel
under one generation AbortController, ignores stale generations, preserves
section-level partial results, and performs no polling or automatic retry.
Draft filters remain distinct from the last successfully applied filters. A
failed Apply preserves both the previous valid data and its applied context.
Currency groups remain isolated and are never combined or converted.

CSV exports use GET-only `adminRequestBlob`, sharing the JSON transport's path
and Bearer boundary with a 30-second timeout. The export layer validates a
case-insensitive `text/csv` media type but leaves Blob bytes unparsed. The
download helper accepts only a short quoted ASCII `.csv` filename or uses a
fixed report fallback, clicks one temporary link, and always removes the link
and revokes the object URL. No Blob or object URL is persisted.

`/admin/users` is a separately guarded `super_admin` route over safe paginated
GET and ordinary-role PATCH contracts. Customer rows expose Promote to admin;
admin rows expose Demote to customer; super-admin rows are read-only. Every
action requires confirmation, allows one PATCH in flight, performs no optimistic
update, and is followed by an authoritative list GET. An ambiguous mutation
outcome establishes a generation barrier, aborts or ignores any older list
request, and locks mutation and pagination until an explicit reconciliation GET
succeeds. A captured-session 401 is generation-safe; 403 refreshes canonical
`/auth/me` state before role guards choose `/account`, `/admin`, or continued
super-administrator access.

### 5.19. Implemented Customer Frontend Runtime

Stage 15 established the guest Order flow. Stage 16F preserves it while adding
`landing`, canonical `auth`, and personal `account` features to the same React
and TypeScript application. The customer feature directories are `landing`,
`auth`, `menu`, `cart`, `checkout`, `order-status`, and `account`; administrator
features share the same authentication provider. `src/api` owns transport and
strict runtime response validation, `src/components` owns genuinely shared
shell and notice components, `src/routes` owns the unified route table, and
`src/styles` owns global tokens and base rules.

The browser is not a pricing or lifecycle authority. It sends item identifiers,
quantities, order type, and an optional dine-in table number; FastAPI supplies
menu facts, validates the current quote and order, owns all money, and owns
Order and Payment state. The public guest credential is returned once by order
creation and sent only in `X-Order-Access-Token`. It is never part of a URL,
rendered DOM, or log.

Browser persistence is limited to `sessionStorage` with these exact versioned
keys:

- `restaurant-ordering:auth:v1`;
- `restaurant-ordering:cart:v1`;
- `restaurant-ordering:order-access:v1:<PUBLIC_ORDER_NUMBER>`;
- `restaurant-ordering:checkout-attempt:v1:<PUBLIC_ORDER_NUMBER>`.

The auth record contains only version and the opaque `user_access`; the legacy
administrator-auth key is accepted only as a one-time migration candidate. The
cart record contains only menu-item identifiers and quantities. The Order
access record contains the independent capability for the current session. The
Checkout record contains the public order number and canonical UUIDv4
idempotency key, but no capability, Checkout URL, Stripe identifier, or Payment
identifier. The app never uses `localStorage`. Malformed persisted records are
discarded; storage failures such as `SecurityError` leave the current in-memory
flow usable where an in-memory value already exists.

The API layer accepts only paths below `/api/` and classifies failures as
`http`, `network`, `timeout`, `aborted`, or `invalid-response`. Feature layers
map those transport facts to safe customer messages; raw backend details are
not rendered. Quote changes use a 400 ms debounce plus AbortController cleanup.
Order creation is never automatically retried after an ambiguous outcome.
Checkout preserves its idempotency key for network, timeout, 429, 503, and
redirect failures and replaces it only through explicit customer action after
a definitive 502.

Menu and quote requests remain anonymous. Order creation captures the current
authentication generation: an unauthenticated request sends no Bearer, while
an authenticated request sends canonical Bearer and becomes owned in the
backend transaction. Both keep the independently returned capability. Checkout
and status send Bearer for an authenticated session plus the capability when it
is available; ownership works without capability, and capability remains valid
for a guest or non-owner. Checking or temporarily unavailable authentication
blocks these actions rather than silently selecting guest mode. An
authenticated 401 invalidates only the captured session and is never retried
anonymously. Stripe redirect navigation carries no application auth header.

Owner-or-capability fulfilment polling performs one request at a time. It requests immediately,
schedules the next normal request 8 seconds after settlement, and uses bounded
8, 16, and 30 second delays after transient failures. It pauses when the page
is hidden or offline, resumes immediately only when visible and online, and
stops for `completed`, `cancelled`, privacy-preserving 404, or an invalid
response contract. AbortController cleanup and the active effect generation
prevent stale updates. Stage 15 uses no WebSocket or server-sent event channel.

During local development the network path is `Browser -> Vite :5173 -> /api
proxy -> FastAPI 127.0.0.1:8000`. The default `VITE_API_BASE_URL` is empty, so
requests remain same-origin through the Vite proxy and no local CORS middleware
is required. Cross-origin production policy is deferred to deployment.

### 5.20. Unified Identity, Order Ownership, and Account Privacy Boundary

Stage 16D implements one minimal registered identity:

```text
User
- id: UUID
- email: normalized unique email
- password_hash: Argon2id hash
- role: customer | admin | super_admin
- is_active: boolean
- created_at: aware UTC timestamp
- updated_at: aware UTC timestamp
```

`role` is a Python `StrEnum` represented by a non-null `VARCHAR` column, with no
server default and with a database `CHECK` constraint. It is one mutually
exclusive role, so there is no Role table, role join table, or multi-role RBAC
layer. An anonymous `guest` is neither a User nor a role. Public registration
creates only `customer`; no request field can select `admin` or `super_admin`.

JWT access tokens identify a User. PostgreSQL is authoritative for current role
and `is_active` on every protected request. Implemented dependencies are:

- `get_current_user` accepts canonical `user_access` only for any active User;
- `require_admin` accepts canonical `user_access`, reloads the User, and permits
  `admin` or `super_admin`;
- `require_super_admin` uses the same current-User authority and permits only
  `super_admin` for role management;
- no Bearer requirement for anonymous guest ordering.

An invalid, missing, inactive, or deleted identity returns 401; a valid identity
with insufficient role returns 403 on role-protected administrator routes.
Stage 16E public Order routes instead use optional canonical authentication:

- a completely absent Authorization header selects the guest path before auth
  service or User database lookup;
- a present valid canonical `user_access` resolves the current active User;
- a present malformed, invalid, noncanonical, inactive, or missing-User
  credential returns 401 with no silent guest fallback;
- auth configuration or User lookup failure returns a safe 503;
- creation and Checkout run their existing rate limiters before optional User
  resolution.

The implemented browser transports preserve explicit trust boundaries:

- `publicApi` sends no Bearer token;
- `authenticatedApi` sends Bearer only to an explicit account-route allowlist;
- `customerApi` sends optional Bearer only for mixed-auth Order creation,
  status, and Checkout contracts;
- `adminApi` may send Bearer only to `/api/v1/admin/...`;
- no global interceptor may attach the account token to arbitrary requests.

Guest Checkout and public status continue to use `X-Order-Access-Token`; a
canonical account token does not replace this per-Order capability. Ownership
and capability are independent. Public status and Checkout permit access only
when `current_user_id` matches the non-NULL persisted `customer_user_id` or the
guest capability verifies in constant time. An owner can omit or mistype the
capability; an anonymous or authenticated non-owner can still use a valid
capability. A non-owner without it receives the same 404 as an unknown Order,
never an ownership-revealing public 403. There is no role-based public bypass.

The ownership extension is nullable
`Order.customer_user_id -> User.id` with `ON DELETE SET NULL`, no default,
backfill, or ORM relationship. Anonymous Orders store NULL; creation writes a
trusted current User ID, when any, in the initial aggregate transaction. Every
Order still gets an independent raw-once capability whose hash is persisted.
No client field, public response, or current route can set, mutate, or
retroactively claim ownership. A future User deletion may null ownership while
preserving the Order; no User-delete API currently exists.

Migration `0007_unify_user_auth_roles` renames and evolves `admin_users` into
`users`, preserving UUID, normalized email, password hash, active state, and
timestamps. It adds the constrained role column and maps exactly one historical
administrator to `super_admin`. Zero rows are valid for later bootstrap; more
than one makes the migration fail atomically. Downgrade is guarded against
discarding customer data. Migration validation uses only the disposable exact
test database on the project PostgreSQL listener at 5433; it does not mutate the
development database or host PostgreSQL at 5432.
Migration `0008_add_order_ownership` is the schema-only child of 0007 and adds
the nullable foreign key plus the composite owner-history index. Repository,
Alembic, and the development database are now at 0008. The development upgrade
ran additively through `0006 -> 0007 -> 0008` after an external backup; it
preserved the historical administrator as an active `super_admin`, replaced
`admin_users` with `users`, and verified the ownership foreign key and index.
The project PostgreSQL remains exposed on host port 5433 to container port 5432;
the separate host PostgreSQL service on port 5432 was untouched.

Public registration always creates `customer`. The super-admin-only list API
returns safe User fields and deterministic pagination. Its role PATCH locks the
target row and allows only `customer <-> admin`; it cannot assign or modify a
`super_admin`, mutate active state, or delete a User. Stage 16F implements the
shared authentication, personal account, and `/admin/users` frontend without
expanding those backend permissions.
Because every protected request reloads the User, a successful role change
affects authorization immediately even when the client reuses the same token.

The account boundary exposes exactly two strict canonical read-only routes:
`GET /api/v1/account/orders` and
`GET /api/v1/account/orders/{public_order_number}`. Every active role has
personal scope only. Both the count and page SELECT apply the current User owner
predicate; the page orders by `created_at DESC, id DESC` with default
`limit=50`, maximum 100, and default `offset=0`. Detail combines
`public_order_number` and `customer_user_id` in the same SQL predicate rather
than fetching broadly and filtering in Python. Cross-user, unowned, and unknown
details share one 404, and a guest capability is irrelevant to account
authorization.

The account list uses a dedicated seven-field safe DTO. Account detail reuses
the same query-free `OrderStatusResponse` builder as public status after the
caller has already authorized and projected the row. The builder serializes
only approved snapshots; it performs no authentication, authorization, or
database work and exposes no owner, PII, capability, Payment, or Stripe data.
Existing administrator Order DTOs remain unchanged and likewise do not expose
ownership.

### 5.21. Implemented Stage 16F Authentication and Route Architecture

One application-wide `AuthContext` represents exactly four phases:
`checking-session`, `authenticated`, `unauthenticated`, and
`temporarily-unavailable`. It stores opaque canonical `user_access` in
`restaurant-ordering:auth:v1` `sessionStorage` with a memory fallback, never in
`localStorage`. A legacy `restaurant-ordering:admin-auth:v1` record is read only
as a one-time migration candidate and is removed after validation or rejection.
`GET /api/v1/auth/me` is the authority for the current role and `is_active`; the
frontend never parses JWT claims for authorization.

Validation, login, registration, refresh, and logout use request generations
and AbortController cancellation so an older result cannot replace a newer
session. Each protected operation captures both token and session generation.
A 401 clears credentials only when that captured session is still current. An
administrator 403 refreshes `/api/v1/auth/me` without first discarding the
session, allowing current database role state to drive the route guard.

The route and guard matrix is:

| Boundary          | Routes                                                                                        | Allowed identity                                  |
| ----------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| public            | `/`, `/menu`, `/cart`, `/login`, `/register`, `/orders/:publicOrderNumber/...`, `*`           | anonymous or authenticated as the feature permits |
| account           | `/account`, `/account/orders/:publicOrderNumber`                                              | every authenticated role, personal scope only     |
| operational admin | `/admin`, `/admin/orders...`, `/admin/menu`, `/admin/analytics`, `/admin/exports`, `/admin/*` | `admin` or `super_admin`                          |
| User governance   | `/admin/users`                                                                                | `super_admin` only                                |
| compatibility     | `/admin/login`                                                                                | redirect to `/login?next=%2Fadmin`                |

An unauthenticated protected-route visit goes to unified `/login` with a safe
continuation. Customers rejected from administrator routes go to `/account`; an
administrator rejected from `/admin/users` goes to `/admin`. The default after
login or registration is `/account`. The `next` parser accepts only explicitly
known same-origin routes and valid public Order numbers. It rejects external or
protocol-relative URLs, backslashes, traversal, control characters, query or
fragment injection, unsupported destinations, and auth loops. Credentials and
capabilities never enter a URL or Router state.

The customer credential matrix is:

| Operation       | Guest                           | Authenticated User                                  |
| --------------- | ------------------------------- | --------------------------------------------------- |
| menu and quote  | no credential                   | no credential                                       |
| Order creation  | no credential                   | Bearer                                              |
| public status   | capability                      | Bearer plus optional capability                     |
| Checkout        | capability plus idempotency key | Bearer plus optional capability and idempotency key |
| Stripe redirect | no application header           | no application header                               |

The account list and detail use strict canonical Bearer and never accept the
guest capability. List pagination and detail authorization are owner-scoped in
SQL. Both customer screens use safe DTOs; detail shares the query-free
`OrderStatusSummary` renderer with public status and performs no polling.
Generic 404 protects unknown, unowned, and cross-user Orders, while 503 keeps
the canonical session available for retry.

Stage 16F automated acceptance passed. The automated browser environment was
unavailable, so the developer/user performed the required local-browser QA and
confirmed the final build after FIX2 at 375x812, 768x1024, and 1280x800. The
responsive fixes include long-email wrapping on the authenticated landing and
User-role confirmation surfaces and direct Back to home navigation from login
and registration. No manual QA blocker remains.

### 5.22. Integrated Acceptance Isolation

Destructive role, Order, account, and authorization acceptance runs only against
the temporary `restaurant_ordering_analytics_stage16g` database on the project
PostgreSQL listener at host port 5433. An exact local-host, port, and
database-name allowlist is checked before creation. The database OID captured
after creation must match immediately before cleanup; a mismatch aborts cleanup.

Acceptance identities are synthetic and disposable, and payment acceptance uses
an injected fake provider rather than a real Stripe charge. The harness is
ephemeral and untracked. The development database is limited to read-only
before-and-after fingerprint checks and receives no disposable acceptance data.
After successful acceptance the isolated database is removed. Host PostgreSQL
on port 5432 and the project named volume remain untouched.

### 5.23. Implemented Stage 17 Container Runtime and Readiness Boundary

The Stage 17 local Compose application has exactly four services: `postgres`,
the one-shot `migrate` job, `backend`, and `frontend`. Its request path is:

```text
Browser -> frontend Nginx :8080 -> backend :8000 -> PostgreSQL :5432
```

The `app` network contains only frontend and backend traffic. The `data`
network connects PostgreSQL, migrate, and backend. Frontend is the sole
application ingress and publishes container port 8080 on
`127.0.0.1:5173`; backend and migrate publish no host port. PostgreSQL is
available to local tools only through the loopback binding
`127.0.0.1:${POSTGRES_HOST_PORT:-5433}` to container port 5432. The persistent
`postgres_data` volume is preserved across ordinary Compose restarts and
shutdowns.

Nginx serves the static React application and forwards same-origin `/api`
requests to the private backend without changing the request URI. `/health`
and `/ready` are also routed to the backend, while frontend owns the distinct
`/healthz` endpoint; none of these operational paths can fall through to the
SPA. Incoming forwarded-header chains are overwritten at Nginx, Uvicorn does
not trust proxy headers, and the application has no wildcard CORS policy. A
future public proxy trust policy remains a deployment concern.

Startup is explicit and ordered. PostgreSQL must first become healthy. The
non-restarting migrate service then runs only `alembic upgrade head` and must
complete successfully. Backend independently performs the read-only
`alembic current --check-heads` guard before it replaces the shell with one
Uvicorn worker. Its health check calls `/ready`; only a healthy backend permits
frontend startup. `/health` remains process liveness and performs no database
operation, whereas `/ready` executes `SELECT 1` and returns a safe 503 when the
database session or probe is unavailable. Frontend health is the Nginx-owned
`/healthz` response.

The backend and migration image runs as fixed user and group `10001:10001`, and
the frontend runtime runs as `101:101`. Migrate, backend, and frontend use a
read-only root filesystem, a size-limited `/tmp` tmpfs with
`nosuid,nodev,noexec`, all Linux capabilities dropped, and
`no-new-privileges`. Runtime secrets are supplied through the environment and
are not embedded in either image. Compose startup performs no seed, account
bootstrap, reset, downgrade, or implicit schema mutation outside the explicit
migration job.

The current database role and loopback bindings are accepted only for the local
Stage 17 environment. This architecture is not a claim of public deployment.
HTTPS, externally managed secrets, a least-privilege production database role,
and an explicit trusted-proxy boundary remain required work for a later public
deployment stage.

#### Stage 17 Isolated Docker Acceptance

Final acceptance used the unique Compose project
`roa-stage17-accept-7975ee`, a separate synthetic environment, alternate
loopback ports `127.0.0.1:15173` for frontend and `127.0.0.1:15433` for
PostgreSQL, and its own PostgreSQL volume. The real `.env` was untouched, and
the development database was not used for disposable acceptance data; its
fingerprint was unchanged after the run.

Two explicit migration executions and the dependency-managed startup migration
all ended at Alembic head `0008_add_order_ownership`. Canonical registration,
login, and `/auth/me` passed; removed legacy administrator-auth routes returned
404; the forwarded-header spoof check passed; and persisted data survived an
application restart. Image, runtime-hardening, secret, and log audits also
passed without recording synthetic credentials, tokens, or database URLs.

Browser automation was unavailable, so no browser E2E result is claimed.
Programmatic SPA deep-link and API smoke checks passed through the frontend
ingress. Acceptance containers and networks were removed with Compose `down`
without `-v`; the intentionally retained volume is
`roa-stage17-accept-7975ee-postgres-data`.

### 5.24. Implemented Stage 18 Isolated Browser E2E

Stage 18 uses Playwright Test 1.62.1 with Chromium as the sole browser-E2E
framework. The complete suite runs with one worker and zero retries. Trace,
video, HAR, and `storageState` capture are disabled, while screenshots are
created only on failure. No Axe, Cypress, second browser-E2E framework, or real
Stripe integration is part of this acceptance boundary. The required proof is
the real Playwright-controlled Chromium run; the in-app browser was unavailable
and no result from it is claimed.

Every browser-E2E run creates a unique Compose project with its own PostgreSQL
database and named volume. All identities and credentials are synthetic. The
real `.env`, the development database, and its persistent volume are outside
the disposable test-data boundary and remain untouched. Acceptance cleanup
removes the run's containers and networks but does not delete retained volumes
without separate explicit approval. The current environment therefore retains
seven detached Stage 17/18 acceptance volumes intentionally, with no acceptance
containers or networks still running.

The isolated backend process enables the test-only `backend/e2e_harness.py`.
Its fake payment provider gives the browser only an opaque Checkout handle. A
process-local server registry keeps the authoritative payment and internal-ID
facts. Fake completion derives the status and webhook payload server-side and
accepts no amount, status, internal identifier, Order capability, or webhook
secret from the browser. The synthetic secret also remains server-side. Fake
completion creates a signed synthetic event and sends it through the real Stripe
webhook endpoint, so the real endpoint plus the normal correlation,
idempotency, and Payment transition path remain under test without any real
Stripe traffic. The harness is not mounted in the production application and
creates no production E2E backdoor.

Final Stage 18 acceptance used two fresh isolated runs, and both complete suites
passed 8/8. Together they cover landing, authentication, account ownership and
privacy, guest ordering, fake Checkout and the signed webhook, payment and
administrator lifecycle/RBAC, responsive layouts, keyboard navigation, and
focus behavior. Both runs had zero unexpected console, page, or network
failures. Successful cleanup left no Playwright browser artifacts.

The accompanying acceptance evidence records 1654/1654 backend tests,
890/890 frontend tests, zero vulnerabilities in both production-only and full
npm audits, Alembic head `0008_add_order_ownership`, and 8/8 migration
round-trip/no-drift checks. Before-and-after checks also confirmed an unchanged
development-database fingerprint, unchanged host and development Docker state,
and a byte-identical real `.env`.

### 5.25. Implemented Stage 19 Deterministic Continuous Integration

Stage 19 adds one GitHub Actions workflow on `ubuntu-24.04`. It runs for every
`pull_request`, every push to `main`, and explicit `workflow_dispatch`. The
workflow has top-level `permissions: contents: read` and concurrency grouped by
workflow plus pull request or ref, with `cancel-in-progress: true`. Every
third-party action reference is pinned to a full immutable commit SHA, and
checkout does not persist credentials.

The workflow exposes this fixed job graph:

```text
Backend ----\
Migrations ---+--> Browser E2E
Frontend ----/
```

`Backend`, `Migrations`, and `Frontend` are independent jobs. Backend installs
the full Python CI environment from the hash-locked
`backend/requirements-ci.lock` file and runs Ruff, Black, isort, and pytest
against a synthetic PostgreSQL service. Migrations installs the hash-locked
runtime set, validates the exact database target and single Alembic graph,
upgrades to head, verifies the current head, and checks drift against a separate
synthetic PostgreSQL service. Frontend uses `npm ci`, type-checks the browser
E2E sources, and runs ESLint, Prettier, Vitest, the production build, and both
dependency audits.

`Browser E2E` has explicit `needs` edges to all three independent jobs and can
start only after all succeed. Its runner installs Chromium and invokes the
tracked fail-closed shell orchestrator. The orchestrator creates a unique
Compose project, loopback frontend port, PostgreSQL volume, and runner-temporary
configuration from run-scoped synthetic PostgreSQL, authentication, webhook,
and identity values. It disables implicit Compose environment files, requires
the real `.env` files to be absent, keeps the Stripe API key empty, uses the
test-only fake payment boundary, and makes no real Stripe request. Runtime logs
are audited before cleanup, Playwright output is removed, and no CI artifact is
uploaded.

The workflow requires no GitHub Secrets. It deliberately uses `pull_request`,
not `pull_request_target`, and no workflow step references repository or
environment secrets; fork pull requests therefore execute only with the
read-only token boundary and synthetic CI values. The real `.env`, development
database, host PostgreSQL, and retained development volumes are not CI inputs
or acceptance targets.

Live GitHub acceptance proved the dependency graph with a complete
GREEN -> RED -> GREEN sequence. GREEN #1 and GREEN #2 each completed all four
jobs and passed Playwright 8/8. In the controlled RED run, the intentional
Frontend test failure left Backend and Migrations successful and caused Browser
E2E to be skipped without executing a step. Count-only log and artifact audits
found no real secret, credentialed DSN, JWT, Order capability, webhook secret,
real Stripe endpoint, private key, or uploaded artifact. The temporary pull
request, branch, and worktree were removed without merge, and `main` remained
at its pre-acceptance commit.

Hosted Chromium also detected two real responsive product defects. The `/menu`
card grid is now constrained with `grid-template-columns: minmax(0, 1fr)`, and
the `/admin/users` card definition list resets the user-agent offset with
`.cardDetails dd { margin: 0; }`. The Playwright material-overflow assertion
remains strict; production CSS was corrected instead of exempting either
failure.

After acceptance, classic branch protection was configured on `main` with the
exact required checks `Backend`, `Migrations`, `Frontend`, and `Browser E2E`,
and with strict status checks enabled. Force pushes and deletion are disabled.
Administrator enforcement is intentionally disabled at this stage, and no
repository ruleset adds another policy. This CI and branch-protection boundary
did not constitute public deployment. Stage 20 has since completed the
repository-side production readiness contracts; Stage 22 still must provision
HTTPS ingress, managed secrets, and least-privilege application and migration
roles before any public release.

### 5.26. Implemented Stage 20 Production Deployment Readiness

Production settings fail closed around the explicit production environment,
debug mode, trusted hosts and proxy mode, same-origin HTTPS URLs, Stripe test
mode, release identity, and expected Alembic head. The backend and Nginx images
use portable entry points and runtime environment templating rather than
provider-specific build-time values.

Production schema change and application startup have separate authority. The
backend consumes only `DATABASE_URL` and performs a read-only head check. The
isolated runner consumes only `MIGRATION_DATABASE_URL`, requires the
`roa_migrator` login and `roa_owner` owner roles, applies `SET LOCAL ROLE`
inside the caller-owned transaction, uses a PostgreSQL advisory lock, and
verifies the expected head before commit.

The manual release contract binds an exact current-`main` SHA to successful
required checks and an immutable GHCR digest. The Render Blueprint describes a
target Nginx frontend, private image-backed backend, isolated no-op migrator
resource, and managed PostgreSQL 17 database with automatic deployment
disabled. The release controller intentionally stops before any Render mutation
until the live migrator artifact identity can be proved safely. The workflow
has not been dispatched, no cloud resource has been provisioned or changed, and
no production deployment or public URL is claimed; those actions belong to
Stage 22.

### 5.27. Implemented Stage 21 Frontend Architecture

The unified React application now presents the Nordic Hearth identity through
shared branding, design tokens, Button, Notice, StatusBadge, AppShell, and
AdminShell primitives. Customer, account, and administrator feature modules
retain their existing API, authorization, ownership, and state-machine
boundaries.

Seventeen non-landing feature page routes use React `lazy` and `Suspense` at
the route boundary. The landing route, authentication and role guards remain
eager, one application-wide provider state remains mounted, and navigation
retains focus management. Landing and
menu imagery use local responsive WebP source sets with explicit `sizes` and
original-image fallbacks; no external image delivery service is required.

Payment return and cancellation routes remain neutral and cannot infer a
Payment outcome. Administrator menu forms use the NOK-only, fixed-scale-two
major-unit contract while APIs retain exact integer minor units. No-hard-delete,
separate active and available states, separated analytics currencies, and
distinct draft and applied filter contexts remain unchanged.

Final Stage 21 acceptance passed 1,073 frontend tests and 23/23 synthetic
production-preview Chromium scenarios across responsive, keyboard, focus,
forced-colors, reduced-motion, network, and route-loading behavior. No
JavaScript chunk exceeds 500 kB. This is local pre-deployment evidence, not a
claim of a live service.

## 6. Architecture Diagram

```mermaid
flowchart LR
    Guest[Guest] --> UI[Unified React application]
    User[Registered User] --> UI
    Admin[Administrator] --> UI
    SuperAdmin[Super Administrator] --> UI

    UI -->|HTTPS / JSON; optional capability or Bearer| API[FastAPI modular monolith]

    subgraph Backend[FastAPI]
        API --> Auth[auth]
        API --> Catalog[categories + menu]
        API --> Tables[restaurant_tables]
        API --> Orders[orders]
        API --> Payments[payments]
        API --> Analytics[analytics + reports]
        Core[core + database] --- Auth
        Core --- Catalog
        Core --- Tables
        Core --- Orders
        Core --- Payments
        Core --- Analytics
    end

    Catalog --> DB[(PostgreSQL)]
    Tables --> DB
    Orders --> DB
    Auth --> DB
    Analytics --> DB
    Payments --> DB

    Payments -->|create Checkout Session| Stripe[Stripe Checkout]
    UI -->|header-free redirect| Stripe
    Stripe -->|signed webhook| Payments
```

## 7. Planned Backend Structure

The structure is a direction, not an instruction to create every file at once.
Each stage adds only the elements it needs.

```text
backend/
├── alembic/
│   └── versions/
├── app/
│   ├── auth/
│   ├── categories/
│   ├── menu/
│   ├── restaurant_tables/
│   ├── orders/
│   ├── payments/
│   ├── analytics/
│   ├── reports/
│   ├── core/
│   ├── database/
│   └── main.py
├── tests/
│   ├── unit/
│   ├── integration/
│   └── api/
├── alembic.ini
└── pyproject.toml
```

Files such as `models.py`, `schemas.py`, `router.py`, and `service.py` are
allowed within a module, but they are created only when the module actually
needs the relevant responsibility.

## 8. Implemented Stage 16F Unified Frontend Structure

```text
frontend/
├── src/
│   ├── api/
│   ├── components/
│   ├── features/
│   │   ├── landing/
│   │   ├── auth/
│   │   ├── menu/
│   │   ├── cart/
│   │   ├── checkout/
│   │   ├── order-status/
│   │   ├── account/
│   │   ├── admin-orders/
│   │   ├── admin-menu/
│   │   ├── admin-analytics/
│   │   ├── admin-exports/
│   │   └── admin-users/
│   ├── routes/
│   ├── styles/
│   ├── test/
│   └── main.tsx
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

Code is grouped primarily by feature. Shared components are placed in
`components` only when they are genuinely shared. One `AuthProvider` wraps the
public, account, and administrator route trees. The historical Stage 15 guest
features remain in place, while Stage 16F adds landing, shared authentication,
personal account, and super-administrator governance without a second app root
or auth silo. User-performed manual responsive acceptance passed at the required
mobile, tablet, and desktop viewports.

## 9. Trust Boundaries and Data Integrity

- The browser is untrusted: prices, roles, and status transitions are verified
  by the backend.
- Stripe is an external integration: every webhook requires signature
  verification, and the event identifier has a unique constraint.
- Critical order, payment, and history writes are transactional.
- Cancellation, `Payment` creation, and the webhook lock `Order` first and then
  `Payment`; no lock is held during a Stripe call.
- Administrator menu PATCH operations lock the target Category or MenuItem row;
  database uniqueness remains authoritative for concurrent writes.
- The database enforces foreign keys, uniqueness, and valid constraints
  independently of Pydantic validation.
- Partial unique indexes limit `Payment` attempts with status `pending` and
  `succeeded` to one each per `Order`.
- UUIDs are internal primary keys; public access to order status requires the
  `public_order_number` and either matching canonical ownership or a capability
  whose raw value is not stored.
- Canonical role and activation authority comes from PostgreSQL through
  `/api/v1/auth/me`, never from frontend JWT decoding.
- Account reads require strict canonical Bearer and an owner predicate; an Order
  capability provides no account authority or administrator bypass.
- Customer and auth state use current-session storage only. No Bearer token,
  Order capability, or Checkout URL is placed in a URL, Router state,
  `localStorage`, rendered DOM, or application log.
- Secrets do not enter the repository, the frontend image, or logs.

## 10. API Scope

The public scope includes a health check, categories, menu, quoting, order
creation, Checkout Session creation, restricted status retrieval, and the
implemented provider-facing Stripe webhook. `POST /api/v1/orders` does not
create a payment. Order creation, public status, and Checkout advertise
`UserBearer OR anonymous`; an absent Bearer uses the guest path, while a valid
canonical User may own or access its Order. Status and Checkout also accept the
independent `X-Order-Access-Token`. Checkout still requires `Idempotency-Key`;
the path parameter is the returned public number, not an internal UUID.
`POST /api/v1/orders/quote` has no security requirement.
`POST /api/v1/stripe/webhook` requires a valid Stripe signature and is
intentionally absent from OpenAPI.

The implemented unified identity scope includes `POST /api/v1/auth/register`,
`POST /api/v1/auth/login`, and `GET /api/v1/auth/me`. The former backend
administrator login and me aliases are not mounted and intentionally return 404.
The administrator scope includes order list and detail, fulfilment status
changes, category and menu-item management, four protected analytics endpoints
for the six basic KPIs, exactly three protected CSV exports, and super-admin-only
`GET /api/v1/admin/users` and `PATCH /api/v1/admin/users/{user_id}/role`. All
operational contracts use database-backed unified User role checks and canonical
`UserBearer`.

The account scope contains exactly strict-`UserBearer`
`GET /api/v1/account/orders` and
`GET /api/v1/account/orders/{public_order_number}`. It has no anonymous or
alternate bearer scheme, ownership claim, mutation, or guest-capability bypass.
No other Stage 16E route is introduced.

Exact contracts, response codes, and the access policy will be defined in the
stages that implement the relevant features. The context document is not yet a
frozen OpenAPI specification.

## 11. Matters Resolved Before the Data Model

- O-002 separates storing `Order` from creating `Payment` and a Stripe Checkout
  Session and defines retry idempotency.
- O-003 defines a separate access token, storage of only its hash, and a minimal
  public status contract.
- O-001 together with D-012, D-013, and D-016 defines independent status
  lifecycles, cancellation rules, and `Order 1:N Payment` invariants.
- D-017 defines the shared serialization point, the `Order -> Payment` lock
  order, and the transaction boundary relative to Stripe.

# Restaurant Ordering & Analytics System — Project Context

## 1. Business Problem

A small restaurant needs one system that combines digital menu management,
order placement and payment, ongoing staff operations, and basic sales
analysis. Without a shared source of data, information about menu availability,
payments, order fulfilment, and sales performance can easily become
inconsistent.

The project simulates such a system at a scale appropriate for a single
restaurant. It is intended to be a complete, demonstrable portfolio
application, not an enterprise-class system.

## 2. Project Goal

The goal is to build a secure web application that:

- allows an anonymous guest to place a dine-in or takeaway order;
- provides optional registered customer authentication and personal Order
  history without making registration a purchase requirement;
- always prices the order on the backend;
- supports test payments through Stripe Checkout;
- allows staff to manage the menu and order fulfilment;
- preserves a reliable sales history;
- provides basic KPIs, reports, and CSV exports;
- can run locally through Docker Compose and be deployed as a demo.

Stages 1 through 17 are complete, verified, and committed. Stage 17's backend
and frontend images, four-service Compose runtime, readiness/startup gates, and
isolated container acceptance all passed. Stage 18-1 Playwright tooling, Stage
18-2 isolated authentication/account E2E, Stage 18-3 guest/payment/
administrator E2E, Stage 18-4 responsive/accessibility/runtime E2E, and Stage
18-5 final acceptance are complete. Stage 18 is implementation- and
acceptance-complete but remains uncommitted during C1 documentation and
pre-commit validation. Stage 18-C2 independent review and final commit and
Stage 19 CI have not started.

## 3. Users

### 3.1. Anonymous Restaurant Guest

The implemented guest is anonymous and does not need to create an account. The
guest can:

1. browse and filter the menu by category;
2. view a product's description, price, image, allergens, and availability;
3. manage product quantities in the cart;
4. choose a dine-in or takeaway order;
5. provide a table number for a dine-in order;
6. receive a quote calculated by the backend;
7. pay through Stripe Checkout in test mode;
8. receive a public order number and check the order status.

### 3.2. Restaurant Administrator

The administrator is an internal account with no public registration. The
administrator can:

1. sign in to a protected panel;
2. browse, filter, and open orders;
3. perform allowed fulfilment status transitions;
4. manage menu items and their availability;
5. hide products without destroying sales history;
6. view the analytics dashboard;
7. export CSV reports.

### 3.3. Registered Identities

Stage 16D implements one unified `User` for every registered identity. A normal
registered account is a `customer`, never a guest. The three mutually exclusive
roles are `customer`, `admin`, and `super_admin`. Public registration always
creates `customer` and cannot select or create a privileged role. A
`super_admin` may manage promotion and demotion between `customer` and `admin`;
an ordinary `admin` cannot use the role-management API, and the ordinary API
cannot assign or modify `super_admin`.

An anonymous `guest` remains neither a User nor a role, and guest ordering is
unchanged. Stage 16G removed the temporary historical `AdminUser` import alias,
so `User` is the only current runtime identity model. Stage 16E links new Orders
to a canonical active User when valid optional authentication is supplied and
provides read-only personal Order history. Stage 16F completes the shared
browser authentication, registration and login, authenticated ordering,
personal account, and super-administrator User-management interfaces.

Migration `0007_unify_user_auth_roles` implements the rename from `admin_users`
to `users`, the constrained role, safe zero/one-row upgrade, atomic multi-row
failure, and guarded downgrade. Its child `0008_add_order_ownership` adds the
nullable Order owner foreign key and personal-history index without a backfill.
Repository and Alembic head are `0008_add_order_ownership`. During the approved
Stage 16F local-QA preparation, the development database was backed up outside
the repository and upgraded through `0006 -> 0007 -> 0008`. The historical
administrator remains active as `super_admin`; `users`, the ownership foreign
key, and the owner-history index are present, and the legacy `admin_users`
table is absent.

## 4. Main Flows

### 4.1. Menu Browsing and Cart

1. The `/` route presents the restaurant landing page, while `/menu` retrieves
   active categories and active menu items. Active but
   temporarily unavailable items remain visible by default and expose their
   availability state.
2. The customer filters the menu and builds a cart in the browser.
3. The cart stores product identifiers and quantities. The price displayed in
   the interface is informational and is not authoritative for the backend.
4. Availability shown while browsing is informational at read time. The quote
   endpoint revalidates both active and available state for every request.

### 4.2. Quoting and Order Creation

1. The frontend requests a transient quote using only product identifiers and
   quantities. Names, prices, currency, activity, and availability are
   authoritative database values.
2. The backend validates every item, rejects duplicates and mixed currencies,
   and calculates line totals, subtotal, and total with integer minor units.
3. The quote response is a point-in-time snapshot of names and prices. It is
   not persisted and does not reserve price or availability.
4. Stage 8 order creation accepts identifiers and quantities again and
   revalidates current activity, availability, names, prices, costs, category
   names, and currency. A previous quote is never authoritative.
5. One short transaction stores the `Order`, ordered `OrderItem` snapshots, and
   initial `OrderStatusHistory(created)` entry. Dine-in creation first locks and
   validates an active RestaurantTable, then all creations lock MenuItem and
   Category rows with `FOR SHARE` in deterministic order.
6. The durable aggregate has a private internal UUID and a separate
   `public_order_number`. Dine-in orders preserve a table-number snapshot, and
   later menu or table changes cannot alter the historical order.
7. Creation without Authorization stores NULL ownership. Valid canonical
   `user_access` assigns the current active User in the same aggregate
   transaction; an invalid present Bearer is never downgraded to guest.
8. Creation returns a one-time raw `order_access_token` for every Order;
   PostgreSQL stores only its SHA-256 hash. Public status permits the matching
   owner or a caller presenting the valid independent capability.
9. Every valid creation POST creates a distinct Order. Stage 8 has no
   `Idempotency-Key` or request fingerprint, so a network retry may create a
   duplicate order.
10. The in-memory, app-scoped creation limiter permits 10 attempts per 60
    seconds for each direct client host and returns HTTP 429 with `Retry-After`
    before any SQL when the limit is exceeded.
11. Order creation still creates neither a `Payment` record nor a Stripe
    session. The separate Stage 9 Checkout flow owns that boundary.

### 4.3. Stripe Payment

1. The customer calls the implemented Checkout endpoint with the
   `public_order_number`, required canonical UUIDv4 `Idempotency-Key`, and
   either canonical owner authentication or the independent
   `X-Order-Access-Token` capability.
2. After idempotency validation, rate limiting, and optional canonical User
   resolution, the backend locks `Order`, authorizes owner or capability, then
   locks related `Payment` rows. It uses only the amount and currency stored on
   Order. Denied access reaches no Payment or provider work.
3. When allowed, it persists a new `Payment(status=pending)` in a short
   transaction. Each Payment is one durable attempt, not an aggregate Order
   status.
4. With no database transaction or lock held, the backend creates one hosted
   Stripe Checkout Session using the stable key
   `checkout-session:{payment_uuid}`. A second short `Order -> Payment`
   transaction stores the validated provider result.
5. The same `Order` and `Idempotency-Key` pair cannot create another `Payment`
   record or another Stripe session.
6. After a definitive provider rejection, Stage 9 changes the attempt to
   `failed`. An ambiguous outcome remains `pending`, and retry uses the same
   Payment and Stripe key. Incomplete attempts may be retried before the
   conservative 23-hour cutoff; older attempts require reconciliation and are
   not auto-expired by the local clock.
7. The customer proceeds to the hosted Stripe page. Returning to the success
   page does not change the payment state.
8. Stage 10 accepts Stripe webhooks through a provider-facing endpoint hidden
   from OpenAPI. It verifies the exact raw body and `Stripe-Signature` through
   the official SDK before any database processing.
9. Each in-scope event is durably deduplicated by its Stripe event ID. Known
   attempts are correlated using Payment ID, Order ID, public order number,
   Checkout Session ID, amount, currency, and mode.
10. The verified webhook is authoritative for `succeeded`, `failed`, and
    `expired`. A completed unpaid session remains `pending` while awaiting an
    asynchronous result, and the first terminal result cannot be overwritten.
11. A signed event with inconsistent or unknown business correlation creates a
    durable reconciliation receipt. A signed event outside the Stage 10 event
    set is acknowledged without persistence.
12. Stage 10 still does not expose Payment state through the public Order status
    response. A public `payment_summary` requires a separate approved contract.
13. Automated Checkout and webhook tests use fake adapters or local signatures,
    make no real provider request, and require no real Stripe secret.

### 4.4. Historical Stage 11 Administrator Authentication

1. Administrators use a separate persisted `AdminUser` identity; customers do
   not receive accounts and there is no general User model or public
   registration.
2. An administrator is created only through the explicit interactive bootstrap
   CLI. The email is validated and normalized, the 15–128-code-point password
   is read twice through `getpass`, and pwdlib stores an Argon2id hash. Migration
   `0006_create_admin_user_model` creates zero identities.
3. Login validates a 1–128-code-point password input, applies a separate 5 per
   60 second direct-peer limiter, performs an exact normalized email lookup,
   and uses either real or process-local dummy Argon2 verification to resist
   identity enumeration.
4. Successful login issues a short-lived HS256 JWT containing only the fixed
   issuer, audience, token type, canonical AdminUser UUID subject, issue time,
   and expiration. The default lifetime is 30 minutes.
5. `AdminBearer` validates the token and reloads the current active AdminUser
   from PostgreSQL on every protected request. Deactivation therefore blocks an
   existing unexpired token immediately.
6. Public customer routes remain public, and the provider-facing Stripe webhook
   remains hidden from OpenAPI. Stage 12 reuses the existing `require_admin`
   dependency for every operational order and menu endpoint.

### 4.4A. Current Unified Authentication and Role Authorization

1. `POST /api/v1/auth/register` creates only an active `customer`; role,
   activation, and unknown fields are rejected. `POST /api/v1/auth/login`
   authenticates any active role, and `GET /api/v1/auth/me` returns the current
   id, email, role, and active state.
2. Production login issues only strict `user_access` JWTs through the sole
   OpenAPI bearer scheme, `UserBearer`. No token contains role authority.
3. `get_current_user` accepts only the canonical token, reloads the current
   active User from PostgreSQL, and supplies database-authoritative role state.
   `require_admin` permits current `admin` or `super_admin`, while
   `require_super_admin` permits only current `super_admin`. Missing or inactive
   identities return 401, while an authenticated insufficient role returns 403.
4. The retired backend `/api/v1/admin/auth/login` and
   `/api/v1/admin/auth/me` routes are intentionally absent and return 404.
   Synthetic tokens using the historical `admin_access` type remain only in
   negative tests and are rejected. The shared Stage 16F frontend uses the
   canonical `/api/v1/auth/...` contracts for every role. Its `/admin/login`
   redirect and one-time old session-key migration are client-side transitional
   compatibility only and do not reintroduce backend legacy authentication.
   Canonical login and registration use separate limiters.
5. `GET /api/v1/admin/users` and
   `PATCH /api/v1/admin/users/{user_id}/role` are super-admin-only. The PATCH
   endpoint uses a row lock and permits only `customer <-> admin`; it cannot
   assign or modify `super_admin`.
6. The first `super_admin` is created through the interactive bootstrap. It
   uses `getpass`, Argon2id, and a transaction advisory lock; any active or
   inactive existing super-admin blocks another, while customer/admin rows do
   not block the first.
7. Canonical configuration uses `AUTH_JWT_SECRET` and
   `AUTH_ACCESS_TOKEN_EXPIRE_MINUTES`. They are the only current runtime
   authentication environment names; retired administrator-specific aliases
   are not accepted.

### 4.5. Administrator Operations and Order Fulfilment

1. The authenticated operational boundary provides order list, filter, detail,
   and status mutation endpoints. Order detail exposes bounded Payment summaries
   but no StripeEvent, Checkout URL, Session ID, or idempotency key.
2. Administrators can list, create, and partially update categories and menu
   items. Category and item deactivation is soft; no administrative DELETE
   endpoint exists.
3. `MenuItem.is_active` controls lifecycle visibility and
   `MenuItem.is_available` independently controls temporary orderability.
   Deactivating a category does not rewrite its child item flags, and later menu
   changes do not alter historical `OrderItem` snapshots.
4. The administrator may change `order_status` from `created` to `accepted`
   only when a related `Payment(status=succeeded)` exists.
5. `created -> cancelled` is possible only when no related
   `Payment(status=pending)` or `Payment(status=succeeded)` exists.
6. An active `pending` attempt blocks cancellation with the provisional domain
   conflict `active_payment_attempt`, because a later Stripe webhook may still
   confirm payment. The customer or administrator must wait for the attempt to
   finish.
7. `failed`, `expired`, and the absence of `Payment` records do not block
   cancellation. After `failed` or `expired`, the user may cancel the order or
   create a new payment attempt.
8. After successful payment, the order cannot be cancelled in the MVP because
   doing so would require a refund process.
9. Every allowed status change and its history row are committed atomically
   under the shared Order lock.
10. The customer may read a minimal status view using the
    `public_order_number` and either matching canonical ownership or the valid
    `X-Order-Access-Token` capability.
11. Stage 12 adds no RestaurantTable administration, refund processing, actor
    attribution, generic audit log, or analytics. Analytics are introduced
    separately in Stage 13.

### 4.6. Analytics and Reports

1. The administrator selects a time range and the required data breakdown.
2. The backend calculates the basic MVP KPIs according to the following
   definitions:
   - **collected revenue:** the sum of amounts from
     `Payment(status=succeeded)` records within the range, based on payment
     confirmation time;
   - **succeeded orders count:** the number of distinct `Order` records that
     have a related `Payment(status=succeeded)`;
   - **average order value:** collected revenue divided by succeeded orders
     count; the result is zero when no such orders exist;
   - **sales by product:** the sum of sold quantities and values from
     `OrderItem` snapshots whose orders have a successful payment, grouped by
     product snapshot;
   - **sales by category:** the sum of sold quantities and values from the same
     snapshots, grouped by category snapshot;
   - **dine-in vs takeaway:** the count of successfully paid orders and
     collected revenue grouped by `order_type`.
3. Collected revenue is not automatically adjusted for refunds because refunds
   are outside the MVP. Refund-adjusted revenue is a later feature.
4. Day boundaries are presented in the `Europe/Oslo` time zone even though
   database timestamps are stored in UTC.
5. Stage 13 exposes the six KPIs through four administrator-only backend
   endpoints. There are no public analytics routes.
6. Financial metrics use `Payment.amount` from succeeded payments whose
   success time is the earliest matching transitioned successful StripeEvent.
   `Payment.updated_at` and `Order.total_amount` are not analytics event time or
   collected revenue.
7. Product and category breakdowns use immutable `OrderItem` snapshots rather
   than current catalog rows. Currencies remain separate and are never
   converted or combined.
8. Queries use aware instants and half-open UTC ranges; response range metadata
   is presented in `Europe/Oslo`.
9. Stage 13 adds no analytics persistence or database migration. Stage 14
   reuses its qualified succeeded-Payment source and product aggregation rather
   than duplicating financial-event logic.
10. Stage 14 exposes three administrator-only CSV datasets: operational orders,
    full historical product sales without the Stage 13 JSON top-N cutoff, and
    qualified succeeded payments. There are no public export routes.
11. Orders are selected by `Order.created_at`, while product-sales and payment
    exports use the earliest qualifying transitioned successful StripeEvent as
    authoritative Payment success time. These source boundaries are
    intentionally different.
12. CSV responses are synchronous and buffered, use deterministic ASCII
    filenames and a fixed UTF-8-SIG, single-BOM, comma, minimal-quoting, CRLF
    contract. Serialization neutralizes formula-like text and removes NUL
    without changing persisted values or historical grouping.
13. Stage 14 added no persistence, table, materialized view, index, migration,
    generated file, or frontend. The separate Stage 15 client does not alter
    the export boundary.

### 4.7. Customer Frontend

Stage 16F evolves the Stage 15 guest journey into one role-aware React
application without making registration a purchase requirement. `/` is the
restaurant landing page, `/menu` is the public menu, and `/cart` retains the
server-quoted dine-in and takeaway flow. `/login` and `/register` provide the
canonical account entry points, while account and administrator destinations
use the same authenticated session.

One shared `AuthContext` represents `checking-session`, `authenticated`,
`unauthenticated`, and `temporarily-unavailable`. It stores an opaque canonical
`user_access` token under `restaurant-ordering:auth:v1` in `sessionStorage`,
with an in-memory fallback when storage is unavailable. It never uses
`localStorage` or derives role authority from JWT claims. A successful
`GET /api/v1/auth/me` supplies the database-authoritative User, role, and active
state. The old administrator storage record is accepted only as a one-time
migration candidate and is then removed. Authentication defaults to `/account`,
uses a role-aware safe `next`, and treats `/admin/login` as a compatibility
redirect to `/login`.

Menu and quote requests remain credential-free. Guest creation sends no
Bearer and retains the independent Order capability for status and Checkout.
Authenticated creation sends the current canonical Bearer so the backend can
assign ownership, while still retaining the capability returned for every
Order. Authenticated status and Checkout send Bearer plus the capability when
available; the matching owner also works without that capability. A checking
or temporarily unavailable session never silently becomes a guest request, and
an authenticated 401 is not retried anonymously.

Order creation remains deliberately non-idempotent, so ambiguous failures are
not retried automatically. Hosted Checkout is a separate idempotent operation:
the browser retains one canonical UUIDv4 attempt key for ambiguous outcomes and
creates a replacement only after explicit customer action following a
definitive provider rejection. The success and cancellation return routes are
neutral navigation outcomes and never determine Payment state.

The protected status view shows only the six fulfilment states and polls with
one request in flight, visibility/offline pauses, bounded transient backoff,
and terminal stopping. It exposes no Payment status. Automated validation is
complete. The automated browser environment was unavailable, so the
developer/user completed the required QA in a local browser after the final
Stage 16F fixes; it passed with no remaining manual acceptance blocker.

### 4.7A. Administrator Frontend

The administrator route tree now consumes the shared canonical `AuthContext`,
database-authoritative `/auth/me` result, role guards, and AdminShell. The
implemented screens cover order list/detail and explicit status actions,
category and item administration, the four analytics views, the three CSV
downloads, and super-admin User management at `/admin/users`. Administrator
requests use a path-isolated Bearer transport; public and guest-only requests
never receive that credential.

Order status mutation is backend-authoritative, requires inline confirmation,
does not update optimistically, and refetches detail after success. Ambiguous
mutation outcomes block another action until Refresh establishes current state.
Menu mutation uses GET, POST, and changed-only PATCH without DELETE; active and
available remain independent and historical snapshots remain unchanged.

Analytics uses date-only Europe/Oslo controls converted to aware half-open
backend ranges, keeps currencies separate, and issues four parallel requests
with section-level partial failure. Exports preserve backend CSV bytes through
the shared Blob transport and conservative filename/download handling. The
`/admin/users` route is guarded for `super_admin` only. It lists safe User fields
and offers only explicit `customer -> admin` or `admin -> customer` actions;
`super_admin` rows are read-only. Every role change requires confirmation,
performs no optimistic update, and refetches the authoritative list. An
ambiguous mutation result locks further role actions until a successful
reconciliation refresh. The UI provides no User deletion, password reset,
active-state mutation, super-admin assignment, or super-admin demotion.

Automated acceptance and user-performed manual responsive acceptance at the
required mobile, tablet, and desktop viewports are complete and verified.

### 4.8. Order Ownership, Personal Account, and Local Readiness

The backend implements `POST /api/v1/auth/register`,
`POST /api/v1/auth/login`, and `GET /api/v1/auth/me`. The current landing page
offers guest ordering, login, and account creation; guest ordering leads to
`/menu` and preserves the complete no-login flow.

Stage 16E implements nullable `Order.customer_user_id`. A newly created Order
is linked to the current registered User when valid optional canonical Bearer
authentication is supplied; an absent Authorization header means anonymous
guest creation. Invalid, malformed, legacy, inactive, or missing-User
authentication returns 401 instead of silently downgrading to guest. Every
active `customer`, `admin`, or `super_admin` may create only its own owned
Order. Every Order still receives its independent capability for Checkout and
public status, so the matching owner or a valid capability holder may use those
public routes. An authenticated non-owner without the capability receives the
same 404 as an unknown Order, not an ownership-revealing 403.

The `GET /api/v1/account/orders` and
`GET /api/v1/account/orders/{public_order_number}` routes and their Stage 16F
list/detail screens require strict canonical authentication. Every active role
uses personal scope only. The UI provides deterministic pagination and a shared
safe Order-status summary. List, count, and detail predicates are owner-scoped
in SQL; another User's, unowned, and unknown detail all return one generic 404.
A guest capability does not bypass this boundary. Responses expose no owner,
customer PII, Payment, Stripe, cost, or margin data, and there is no account
mutation, ownership reassignment, or retroactive guest-Order claim.

The development database is now at `0008_add_order_ownership`. Its approved
`0006 -> 0007 -> 0008` upgrade used an external backup, preserved the active
historical administrator as `super_admin`, and verified the unified User and
ownership schema. Its safe post-G4 fingerprint is one User with role counts
`customer=0`, `admin=0`, and `super_admin=1`; five categories; fifteen menu
items; two Orders; two OrderItems; and zero Payments.

Stage 16G integrated acceptance used in-process ASGI/TestClient checks against
the isolated `restaurant_ordering_analytics_stage16g` database on the project
PostgreSQL service and a fake payment provider. Exact local host, port, database
name, and captured database OID guarded cleanup. The development database was
not used for disposable acceptance identities or destructive role testing, its
fingerprint was unchanged, the isolated database was removed, and no permanent
acceptance harness was tracked. This was not browser E2E, and the optional G4
browser smoke was skipped; the separately documented Stage 16F manual browser
QA was performed by the developer/user.

The project PostgreSQL container remains published from host 5433 to container
5432, its named volume is preserved, and the independent host PostgreSQL service
on 5432 was untouched. A local credential-hygiene issue was remediated by
rotation without recording a credential value, database URL, or repository
artifact.

The current automated baseline is 1654/1654 passing backend tests, 890/890
passing frontend tests, and 8/8 passing Alembic migration round-trip/no-drift
tests at the single `0008_add_order_ownership` head. Stage 16G G4 final
integrated acceptance remains complete as a historical in-process acceptance
snapshot.

Stage 16F was committed at
`dae2d8f12ed4f4de94337dfc730422504b2e528f`. Stage 16G implementation,
acceptance, independent review, and security sign-off were committed at
`8f50374759574fe7f7fea80c2eb7229cf12d3a0f`. Stage 17 implementation and
isolated acceptance are committed at current HEAD
`7c7595aed2aa0571248a867d34386c72c71f3024`. Stage 18 implementation and final
acceptance are complete but remain uncommitted during C1; Stage 18-C2
independent review and final commit have not started.

### 4.9. Local Full-System Container Runtime

Stage 17 implements exactly four local Compose services: `postgres`, one-shot
`migrate`, `backend`, and `frontend`. The accepted request path is:

```text
Browser -> frontend Nginx:8080 -> backend Uvicorn:8000 -> PostgreSQL:5432
```

The frontend is the sole application ingress and publishes
`127.0.0.1:5173 -> frontend:8080`. PostgreSQL publishes
`127.0.0.1:${POSTGRES_HOST_PORT:-5433} -> postgres:5432` for host-side local
tools. The backend and migration job publish no ports. The frontend is isolated
to the `app` network, PostgreSQL and migrations to `data`, and the backend
bridges the two. Nginx serves the compiled React SPA, provides deep-link
fallback, and proxies `/api`, `/health`, and `/ready` to the backend. Browser
traffic is therefore same-origin, and the backend has no wildcard CORS policy.

Startup follows one explicit dependency chain. Healthy PostgreSQL permits the
one-shot `alembic upgrade head` migration. Only successful migration permits
the backend startup command, which first runs the read-only
`alembic current --check-heads` check and then starts one Uvicorn worker. The
backend must pass `/ready` before the frontend starts; frontend health is
reported by `/healthz`. `/health` remains process liveness without a database
query, while `/ready` executes `SELECT 1` and returns 503 if the database is not
ready. Startup never seeds data, bootstraps a privileged User, resets or
downgrades the schema, or removes the persistent PostgreSQL volume.

The backend and migration image runs as UID/GID 10001, and the static Nginx
frontend runs as UID/GID 101; neither runtime contains a development server.
The application services have read-only root filesystems, bounded `/tmp`
tmpfs mounts, all Linux capabilities dropped, and
`no-new-privileges`. Nginx overwrites client forwarding headers at the trusted
proxy hop, while Uvicorn disables proxy-header trust. These controls and the
loopback host bindings define a local runtime, not a public deployment. HTTPS,
managed secret storage, and a least-privilege production database role remain
future Stage 20 deployment work. The current single database role is accepted
only for the loopback Stage 17 environment.

Stage 17-5 validated the runtime under the unique isolated Compose project
`roa-stage17-accept-7975ee`, with synthetic configuration, separate loopback
ports, and a dedicated volume. The real `.env`, host PostgreSQL on port 5432,
development container, development database, and development volume were not
modified. Two explicit migrations and the managed-startup migration all ended
at `0008_add_order_ownership`. Canonical register/login/me, legacy
administrator-auth 404 responses, protection against an attacker-supplied
`X-Forwarded-For` limiter bypass, persisted synthetic data after restart, and
the hardening plus sanitized secret/image/log audits all passed. The
development database fingerprint was unchanged.

Browser automation was unavailable, so Stage 17-5 made no browser-E2E or
rendered-DOM claim. Programmatic HTTP smoke through the frontend-only ingress
verified the SPA shell and deep links plus API JSON/non-SPA separation. Final
shutdown used `docker compose down` without `-v`, removed the isolated
containers and networks, and intentionally retained
`roa-stage17-accept-7975ee-postgres-data`. Deleting that volume requires a
separate explicit approval.

### 4.10. Isolated Browser End-to-End Acceptance

Stage 18 uses Playwright Test 1.62.1 and real Chromium as the sole browser-E2E
framework. It runs with one worker and zero retries. Trace, video, HAR, and
`storageState` capture are disabled; screenshots are failure-only, and a
successful run removes its Playwright runtime output. Axe, Cypress, and a
second E2E framework are not part of the project. The in-app browser was
unavailable during final acceptance and is not claimed; the required browser
proof comes from Chromium Playwright.

Each run creates a unique Compose project, PostgreSQL database, and named
volume from synthetic run-scoped configuration. Disposable E2E identities and
payment data never use the development database. The real `.env`, development
database, development container and volume, and independent host PostgreSQL
service remain outside the run boundary.

The tracked `backend/e2e_harness.py` is test-only and is mounted and selected
only by the E2E Compose overlay. It constructs the normal application with an
injected fake Checkout provider and synthetic webhook verifier, then registers
test-only fake Checkout routes on that application. Production startup neither
imports the harness nor exposes those routes, so there is no production E2E
backdoor.

The fake provider stores trusted payment-state and internal-identifier facts in
a process-local server registry. The normal Order capability remains
browser-held under the established authorization contract, but the fake
Checkout completion request accepts only a random opaque handle and neither
accepts nor uses that capability. The webhook secret is separate server
configuration and is never browser-supplied or exposed. Completing fake
Checkout produces a
signed synthetic callback and sends it through the real
`/api/v1/stripe/webhook` endpoint, exercising the normal transactional Payment
path without real Stripe traffic. Synthetic credentials and secrets must not
be logged or persisted.

Stage 18-5 ran two fresh isolated final-acceptance stacks, and both complete
Playwright runs passed 8/8. The covered flows include landing/menu navigation
and deep links; canonical authentication, logout, protected routes, personal
account ownership, and cross-user privacy; guest Order creation, fake Checkout,
the signed webhook, succeeded-payment gating, and unpaid denial;
administrator fulfilment through `completed`, `customer -> admin` User role
promotion and super-admin RBAC; and responsive layouts, keyboard navigation,
and visible focus. There were zero unexpected console, page, or network
failures.

The same acceptance baseline records 1654/1654 backend tests, 890/890 frontend
tests, both npm audits at zero vulnerabilities, one Alembic head at
`0008_add_order_ownership`, and 8/8 migration round-trip/no-drift tests. The
development database fingerprint, host and development Docker state, real
`.env`, and development volume remained unchanged. No browser artifacts
remained after either successful run.

Seven detached Stage 17/18 acceptance volumes are intentionally retained;
deletion requires separate explicit approval. No acceptance containers or
networks remain running.

## 5. MVP Scope

The MVP includes:

- a restaurant landing page, public menu and categories, and frontend cart;
- backend order quoting;
- guest dine-in and takeaway orders;
- shared registered-user authentication, owned ordering, and read-only personal
  Order history;
- table handling;
- Stripe Checkout in test mode;
- verified and idempotent Stripe webhooks;
- order and payment persistence in PostgreSQL;
- an administrator panel, controlled order statuses, and super-admin User
  role management;
- menu and product availability management;
- a basic analytics dashboard with six defined metrics;
- CSV exports for orders, product sales, and payments;
- tests for critical logic;
- local execution through Docker Compose;
- CI and a deployed demo version.

## 6. Features Outside the MVP

The following remain outside the MVP:

- a loyalty program and extended customer profiles;
- a mobile application;
- table reservations and a delivery system;
- advanced inventory management;
- support for multiple restaurants or branches;
- WebSocket communication;
- forecasting and other AI features;
- Power BI and a separate data warehouse;
- microservices, Kafka, and Kubernetes;
- full and partial refunds until the basic payment flow is completed and
  verified;
- automatic expiration of Stripe sessions during cancellation;
- cancelling an order with an active Checkout Session;
- cancelling paid orders;
- estimated margin;
- sales by hour;
- average fulfilment time;
- payment failure analysis;
- an extended status distribution;
- refund-adjusted revenue;
- CSV exports other than orders, product sales, and payments.

## 7. Key Business Rules

### 7.1. Prices and Money

- The frontend is never the source of truth for prices.
- The backend retrieves current product data and calculates all values itself.
- Amounts are integers in the currency's smallest units.
- Currency is stored explicitly; `float` is not used for money.
- A value of `12900` in NOK means `129.00 NOK`.

### 7.2. Sales History

An order item preserves a snapshot of at least:

- the product and category names;
- the unit price and unit cost;
- the tax rate and tax amount;
- the discount;
- the quantity;
- the currency.

A menu change cannot alter a historical order or report. A product used in an
order is not physically deleted; `is_active` and `is_available` control its
visibility and whether it can be sold.

The implemented Stage 8 snapshot stores category and item names, quantity,
unit price, nullable unit cost, currency, line total, and the Order subtotal and
total. It reserves `tax_rate_bps_snapshot` as NULL and
`discount_amount_snapshot` as zero because Stage 8 does not calculate taxes or
discounts. Dine-in orders additionally preserve `table_number_snapshot`.

### 7.3. Time

- Timestamps are stored in UTC.
- Daily and hourly reports are presented according to `Europe/Oslo`.
- Time-zone conversion must account for daylight-saving and standard-time
  transitions.

### 7.4. Orders, Payments, and Statuses

- The `payment_status` of an individual payment attempt has the values
  `pending`, `succeeded`, `failed`, and `expired`.
- The only allowed payment transitions are `pending -> succeeded`,
  `pending -> failed`, and `pending -> expired`.
- `succeeded`, `failed`, and `expired` are terminal states. A retry creates a
  new record with status `pending` instead of changing a completed record.
- One `Order` may have multiple `Payment` records, each representing one
  attempt. `payment_status` is not an aggregate status of `Order`.
- At most one `Payment(status=pending)` and at most one
  `Payment(status=succeeded)` may exist for one `Order`.
- A new attempt may be created only when no related `Payment` has status
  `pending` or `succeeded`. PostgreSQL partial unique indexes must protect both
  constraints.
- `order_status` has the values `created`, `accepted`, `preparing`, `ready`,
  `completed`, and `cancelled`.
- The allowed fulfilment transitions are `created -> accepted`,
  `created -> cancelled`, `accepted -> preparing`, `preparing -> ready`, and
  `ready -> completed`.
- The `created -> accepted` transition requires a related
  `Payment(status=succeeded)`; an auxiliary value on `Order` is insufficient.
- The `created -> cancelled` transition requires the absence of related
  `Payment(status=pending)` and `Payment(status=succeeded)` records. No
  `Payment`, or records with `failed` or `expired`, do not block cancellation.
- An active `pending` attempt rejects cancellation as a domain conflict with
  the provisional name `active_payment_attempt`. The customer or administrator
  must wait for the attempt to finish; after `failed` or `expired`, the user may
  cancel the order or start a new attempt.
- The cancellation condition must be checked transactionally. After successful
  payment, a new transition to `cancelled` is forbidden in the MVP.
- `accepted -> cancelled` is not an allowed transition.
- Reversals and all other unlisted transitions are forbidden.
- `paid` and `pending_payment` are not part of `order_status`.
- Every allowed `order_status` change is recorded in the history.
- Confirmation of `succeeded` may come only from a verified webhook.
- Redelivery of the same Stripe event must not repeat its effects.
- StripeEvent receipts preserve durable idempotency across process restarts.
- The first terminal Payment state wins; contradictory later provider events
  require reconciliation and cannot overwrite it.
- Signed business mismatches are receipted for reconciliation rather than
  misclassified as signature failures.
- A future `refund_status` remains a separate lifecycle.
- Stage 12 applies D-016 to the administrator cancellation transition and
  preserves D-017's `Order -> Payment` lock protocol across cancellation,
  Checkout, and verified webhook processing.

### 7.5. Security and Privacy

- Registered identities use one User record with normalized lowercase email,
  pwdlib Argon2id password hashing, active state, and one constrained role.
  Public registration creates only `customer`; it cannot create a privileged
  User, and there is no public administrator registration.
- First-super-admin bootstrap is explicit, interactive, and protected by a
  PostgreSQL transaction advisory lock. Alembic, application startup, Docker
  Compose, and the menu seed create zero privileged identities.
- Login uses real or process-local dummy Argon2 verification with uniform
  credential failures to resist identity enumeration.
- JWT Bearer access is verified by the backend, and every protected request
  performs a current active-identity lookup in PostgreSQL. Role changes and
  deactivation therefore take effect immediately for existing tokens.
- The frontend uses one canonical AuthContext, an opaque token in current-tab
  `sessionStorage` or memory, and no `localStorage` or JWT role parsing. Request
  generation and token identity prevent stale 401 responses from clearing a
  newer session; administrator 403 responses trigger an authoritative
  `/auth/me` role refresh.
- Canonical login uses an app-scoped limiter of five attempts per 60 seconds for
  each direct peer; registration has a separate limiter. Forwarded identity
  headers remain ignored until a trusted-proxy policy exists.
- Secrets exist only in environment variables.
- Local browser requests use same-origin `/api` paths through either the Vite
  development proxy or the Stage 17 Nginx proxy. FastAPI has no wildcard CORS
  policy; any public cross-origin or HTTPS ingress policy remains deployment
  work.
- Sign-in, order creation, and Stripe session creation are rate-limited.
- Logs do not contain passwords, tokens, keys, or card data.
- The public order view reveals only necessary information and permits either
  the matching canonical owner or a caller with the independent Order
  capability. Invalid present authentication cannot fall back to capability
  access, and public denials use 404 rather than an ownership-revealing 403.
- `order_access_token` has at least 256 bits of randomness, is returned in raw
  form only during order creation, and only its SHA-256 hash exists in the
  database. Token comparison must be secure.
- The public status response contains only the public number,
  `status`, order type, optional table-number snapshot, currency,
  historical public item lines, subtotal, total, `created_at`, and `updated_at`.
  Stage 10 deliberately adds no `payment_summary`; any future exposure requires
  a separately approved public contract.
- Public status does not expose an email address, owner identity, internal
  UUIDs, Stripe identifiers, or administrator data. Account list and detail
  are filtered by current User in SQL and expose no capability, Payment, or
  Stripe data. Unknown, unowned, and cross-user account details share the same
  generic 404.
- Order creation is rate-limited per direct peer host by an app-scoped,
  per-process fixed window. Forwarded headers are not trusted without a future
  trusted-proxy configuration.
- Financial operations and critical changes are performed transactionally.

## 8. Expected Portfolio Value

Stages 11 through 15 and Stage 16F are complete, verified, and committed. Stage
16 implements the administrator operations, unified User/authentication/RBAC
backend, Order ownership, mixed guest/authenticated ordering, personal account,
and super-admin User-management frontend. Stage 16F adds the landing/menu route
split, one canonical browser session, login and registration, personal account
screens, and `/admin/users`. The developer/user completed its required manual
local-browser verification after the final responsive and navigation fixes.
Stage 16G canonical-auth cleanup, integrated acceptance, independent review,
final commit, and security sign-off are complete. Stage 17 local full-system
containerisation and isolated acceptance are complete, verified, and committed.
Stage 18's Playwright tooling, isolated authentication/account, guest payment,
administrator, responsive/accessibility/runtime coverage, and two-run final
acceptance are complete but remain uncommitted during C1. Stage 18-C2
independent review and final commit and Stage 19 CI have not started, and no
public deployment is claimed.

The project should demonstrate to a recruiter that its author can:

- design and explain a relational data model;
- build a typed REST API in FastAPI;
- separate business logic from integrations and the HTTP layer;
- integrate a payment service securely and handle idempotency;
- protect financial history with snapshots and constraints;
- define KPIs before writing analytical queries;
- test positive, negative, and boundary scenarios;
- connect a backend, frontend, database, containers, CI, and deployment;
- document decisions and deliberately limit MVP scope.

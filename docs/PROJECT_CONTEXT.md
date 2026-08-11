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

- allows a customer to place a guest dine-in or takeaway order;
- always prices the order on the backend;
- supports test payments through Stripe Checkout;
- allows staff to manage the menu and order fulfilment;
- preserves a reliable sales history;
- provides basic KPIs, reports, and CSV exports;
- can run locally through Docker Compose and be deployed as a demo.

## 3. Users

### 3.1. Restaurant Customer

The customer does not need to create an account. The customer can:

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

## 4. Main Flows

### 4.1. Menu Browsing and Cart

1. The frontend retrieves active categories and active menu items. Active but
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
7. Creation returns a one-time raw `order_access_token`; PostgreSQL stores only
   its SHA-256 hash. Public status requires the number and the
   `X-Order-Access-Token` header.
8. Every valid creation POST creates a distinct Order. Stage 8 has no
   `Idempotency-Key` or request fingerprint, so a network retry may create a
   duplicate order.
9. The in-memory, app-scoped creation limiter permits 10 attempts per 60
   seconds for each direct client host and returns HTTP 429 with `Retry-After`
   before any SQL when the limit is exceeded.
10. Order creation still creates neither a `Payment` record nor a Stripe
    session. The separate Stage 9 Checkout flow owns that boundary.

### 4.3. Stripe Payment

1. The customer calls the implemented Stage 9 Checkout endpoint with the
   `public_order_number`, the `X-Order-Access-Token` header, and the
   required canonical UUIDv4 `Idempotency-Key` header.
2. The backend authenticates guest access, locks `Order` before its related
   `Payment` rows, and uses only the amount and currency stored on `Order`.
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

### 4.4. Administrator Authentication

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
10. The customer may read a minimal status view by providing the
   `public_order_number` and the `X-Order-Access-Token` header.
11. Stage 12 adds no RestaurantTable administration, refund processing, actor
    attribution, generic audit log, analytics, or Stage 13 implementation.

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
5. MVP CSV exports cover orders, product sales, and payments.

## 5. MVP Scope

The MVP includes:

- public menu and categories;
- a frontend cart;
- backend order quoting;
- guest dine-in and takeaway orders;
- table handling;
- Stripe Checkout in test mode;
- verified and idempotent Stripe webhooks;
- order and payment persistence in PostgreSQL;
- an administrator panel and controlled order statuses;
- menu and product availability management;
- a basic analytics dashboard with six defined metrics;
- CSV exports for orders, product sales, and payments;
- tests for critical logic;
- local execution through Docker Compose;
- CI and a deployed demo version.

## 6. Features Outside the MVP

The following remain outside the MVP:

- customer accounts and a loyalty program;
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

- Administrators use a separate persisted identity with normalized lowercase
  email and pwdlib Argon2id password hashing; there is no customer account,
  general User authentication, or public administrator registration.
- Administrator bootstrap is explicit and interactive. Alembic, application
  startup, Docker Compose, and the menu seed create zero administrators.
- Login uses real or process-local dummy Argon2 verification with uniform
  credential failures to resist identity enumeration.
- Administrator JWT Bearer access is verified by the backend, and every
  protected request performs a current active-identity lookup in PostgreSQL.
- The app-scoped administrator login limiter permits five attempts per 60
  seconds for each direct peer and ignores forwarded identity headers until a
  trusted-proxy policy exists.
- Secrets exist only in environment variables.
- CORS is restricted to known origins.
- Sign-in, order creation, and Stripe session creation are rate-limited.
- Logs do not contain passwords, tokens, keys, or card data.
- The public order view reveals only necessary information and requires the
  `public_order_number` and the `X-Order-Access-Token` header.
- `order_access_token` has at least 256 bits of randomness, is returned in raw
  form only during order creation, and only its SHA-256 hash exists in the
  database. Token comparison must be secure.
- The public status response contains only the public number,
  `order_status`, order type, optional table-number snapshot, currency,
  historical public item lines, subtotal, total, `created_at`, and `updated_at`.
  Stage 10 deliberately adds no `payment_summary`; any future exposure requires
  a separately approved public contract.
- Public status does not expose an email address, internal UUIDs, Stripe
  identifiers, or administrator data. An invalid number and an invalid token
  return the same generic error.
- Order creation is rate-limited per direct peer host by an app-scoped,
  per-process fixed window. Forwarded headers are not trusted without a future
  trusted-proxy configuration.
- Financial operations and critical changes are performed transactionally.

## 8. Expected Portfolio Value

Stage 11 is complete. The next exact stage is **Stage 12 — Administrator Panel
— Operational API**, which has not started and requires separate approval.

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

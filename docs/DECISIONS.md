# Architectural Decision Log

This document records durable contextual decisions. A change to an accepted
decision should add a new entry with rationale instead of removing history.

## D-001: Modular Monolith

- **Status:** accepted by the project assumptions
- **Decision:** the backend will be one deployable system divided into business
  modules.
- **Rationale:** the scale of one restaurant does not justify the communication,
  deployment, and observability costs of microservices.
- **Consequences:** modules share a database and process but retain explicit
  responsibilities. Boundaries can be tested without a network protocol.

## D-002: Integer Amounts

- **Status:** accepted by the project assumptions
- **Decision:** all amounts are stored and calculated as integers in the
  smallest units of an explicitly stored currency.
- **Rationale:** this eliminates binary `float` representation errors and
  simplifies comparison with payment-provider amounts.
- **Consequences:** tax, discount, and rounding rules must be explicit and
  tested at boundary values.

## D-003: UTC in the Database

- **Status:** accepted by the project assumptions
- **Decision:** all timestamps are stored as time-zone-aware UTC values.
- **Rationale:** this makes the moment of an event unambiguous and simplifies
  integrations.
- **Consequences:** the application must not store naive local datetimes.

## D-004: Europe/Oslo in Reports

- **Status:** accepted by the project assumptions
- **Decision:** reporting day and hour boundaries are determined using the
  `Europe/Oslo` time zone.
- **Rationale:** a report should correspond to the restaurant's local operating
  day.
- **Consequences:** queries and tests must cover daylight-saving time, standard
  time, and days with an unusual number of hours.

## D-005: Guest Orders

- **Status:** accepted by the project assumptions
- **Decision:** a customer does not need an account to place an order.
- **Rationale:** this reduces purchase friction and the scope of personal data.
- **Consequences:** order status requires a secure public access mechanism that
  is independent of a customer account.

## D-006: JWT Only for Administrators

- **Status:** accepted by the project assumptions
- **Decision:** JWT is used only to authenticate administrators; public
  registration of administrator accounts does not exist.
- **Rationale:** this matches the two user types and limits authentication scope.
- **Consequences:** token lifetime, frontend storage, and revocation strategy
  must be approved before implementation.

## D-007: Stripe Checkout

- **Status:** accepted by the project assumptions
- **Decision:** payments use hosted Stripe Checkout in test mode.
- **Rationale:** this limits the handling of sensitive card data while
  demonstrating a real payment integration.
- **Consequences:** the application stores only necessary identifiers and
  metadata, never card data. Keys and the webhook secret come from the
  environment.

## D-008: Webhook as the Source of Truth for Payment

- **Status:** accepted by the project assumptions
- **Decision:** only a correctly verified webhook may confirm payment.
- **Rationale:** a user redirect does not prove that payment was completed.
- **Consequences:** a signature is mandatory, events are idempotent, and the
  Stripe identifier has a unique constraint. Duplicate and out-of-order events
  must be handled.

## D-009: Data Snapshot in OrderItem

- **Status:** accepted by the project assumptions
- **Decision:** an order item stores a historical snapshot of the product,
  category, price, cost, tax, discount, quantity, and currency.
- **Rationale:** later menu edits must not alter a sales document or historical
  reports.
- **Consequences:** some data is intentionally denormalized. Tests must confirm
  that history remains unchanged after a product edit.

## D-010: No Data Warehouse in the MVP

- **Status:** accepted by the project assumptions
- **Decision:** the dashboard and reports query PostgreSQL and transactional
  tables directly.
- **Rationale:** demonstration volume does not require a separate analytics
  system.
- **Consequences:** queries must be properly indexed and tested; a separate
  analytics model may be considered only after a need is demonstrated.

## D-011: No Microservices or Kubernetes

- **Status:** accepted by the project assumptions
- **Decision:** the MVP does not use microservices, Kubernetes, Kafka, or
  elaborate queues.
- **Rationale:** these technologies would increase cost without solving the
  current business problem.
- **Consequences:** deployment includes one backend, one frontend, and one
  database; any change requires a documented problem that the monolith cannot
  solve.

## O-001: Separation of Payment and Fulfilment Statuses

- **Status:** accepted on 2026-08-05
- **Decision:** the payment-attempt status and order-fulfilment status are two
  independent lifecycles. A future `refund_status` will also remain a separate
  lifecycle.
- **Rationale:** the payment outcome and restaurant work progress describe
  different processes, have different initiators, and require separate
  transition rules.

### `payment_status`

Allowed values:

- `pending` — the payment attempt is waiting for an outcome;
- `succeeded` — payment was confirmed by a correctly verified Stripe webhook;
- `failed` — the payment attempt ended unsuccessfully;
- `expired` — the opportunity to complete this payment attempt expired.

Allowed transitions:

```text
pending -> succeeded
pending -> failed
pending -> expired
```

`succeeded`, `failed`, and `expired` are terminal states of an individual
payment attempt. They must not be reversed to `pending`. Retrying payment
creates a new attempt record with status `pending`; it does not reactivate a
record completed as `failed` or `expired`.

### `order_status`

Allowed values:

- `created` — the order has been stored, but fulfilment has not started;
- `accepted` — the paid order has been accepted by the restaurant;
- `preparing` — the order is being prepared;
- `ready` — the order is ready for collection or service;
- `completed` — the order has been delivered and completed;
- `cancelled` — order fulfilment has been cancelled.

Allowed transitions:

```text
created -> accepted
created -> cancelled
accepted -> preparing
preparing -> ready
ready -> completed
```

The `created -> accepted` transition is allowed only when a related
`Payment(status=succeeded)` exists. The `created -> cancelled` transition is
allowed only when no related `Payment` has status `pending` or `succeeded`.
Status reversals and every transition not listed above are forbidden. `paid`
and `pending_payment` are not `order_status` values.

- **Consequences:** transition rules must be enforced in business logic and
  tested independently of the interface. Every `order_status` change is stored
  in the history. Confirmation of `payment_status = succeeded` comes only from
  a verified Stripe webhook.

## D-012: No Cancellation of Paid Orders in the MVP

- **Status:** accepted on 2026-08-05
- **Decision:** after a related `Payment(status=succeeded)` appears, the order
  cannot transition to `order_status = cancelled`. The
  `accepted -> cancelled` transition does not exist. `created -> cancelled` is
  possible only without a successful payment.
- **Rationale:** cancelling a paid order requires a consistent refund process,
  which is outside the MVP.
- **Consequences:** `order_status = cancelled` never changes `payment_status` by
  itself. Cancellation after payment will be added together with a separate
  `refund_status` lifecycle and refund module.
- **Further clarification:** D-016 preserves this rule and additionally resolves
  the problem of an active `pending` attempt that could end with a later success
  webhook.

## D-013: Order 1:N Payment Relationship and Payment-Attempt Invariants

- **Status:** accepted on 2026-08-05
- **Decision:** one `Order` may have multiple `Payment` records, and each
  `Payment` represents exactly one payment attempt. `payment_status` is the
  state of that attempt, not an aggregate status of the whole order.
- **Invariants:**
  - at most one `Payment(status=pending)` exists for one `Order`;
  - at most one `Payment(status=succeeded)` exists for one `Order`;
  - `failed`, `expired`, and `succeeded` are terminal;
  - a `failed` or `expired` record does not return to `pending`;
  - a new attempt may be created only when no `Payment` with status `pending` or
    `succeeded` exists for the order;
  - `created -> accepted` requires a related `Payment(status=succeeded)`; an
    auxiliary value on `Order` is not the source of payment confirmation.
- **Rationale:** separate records preserve attempt history and allow safe
  payment retries without mutating completed financial events.
- **Consequences:** PostgreSQL should enforce at most one `pending` attempt and
  one `succeeded` attempt per order with partial unique indexes. Application
  logic and tests must additionally protect the invariants during concurrent
  requests.

## D-014: Basic MVP Analytics Scope

- **Status:** accepted on 2026-08-05
- **Decision:** the MVP dashboard contains only collected revenue, succeeded
  orders count, average order value, sales by product, sales by category, and
  dine-in vs takeaway. MVP exports cover orders, product sales, and payments.
- **Rationale:** this scope retains portfolio analytics value while remaining
  realistic for one person.
- **Consequences:** estimated margin, sales by hour, average fulfilment time,
  payment failure analysis, an extended status distribution, refund-adjusted
  revenue, and other exports are post-MVP extensions. MVP collected revenue is
  the sum of successful payments and does not account for automatic refunds
  because the refunds module is outside the MVP.

## D-015: Full-System Docker Before E2E

- **Status:** accepted on 2026-08-05
- **Decision:** minimal Docker Compose for PostgreSQL is created during the
  database configuration stage. The full Compose setup is extended with the
  backend and frontend before end-to-end tests.
- **Rationale:** E2E requires a repeatable environment for the entire system,
  while an earlier PostgreSQL container reduces manual local configuration.
- **Consequences:** the final order is full-system Docker as Stage 17, E2E as
  Stage 18, CI as Stage 19, deployment as Stage 20, and portfolio documentation
  as Stage 21.

## D-016: Cancellation Blocked by an Active or Successful Payment Attempt

- **Status:** accepted on 2026-08-05
- **Problem history:** D-012 blocked cancellation after successful payment but
  did not resolve the `Payment(status=pending)` case. After order cancellation,
  an active Checkout Session could produce a valid success webhook and leave a
  cancelled but paid order without a refund process.
- **Decision:** `created -> cancelled` is allowed only when no `Payment` with
  status `pending` or `succeeded` exists for the order.
- **Detailed rules:**
  - the absence of `Payment` records does not block cancellation;
  - `Payment(status=failed)` does not block cancellation;
  - `Payment(status=expired)` does not block cancellation;
  - `Payment(status=pending)` blocks cancellation with the provisional domain
    conflict `active_payment_attempt`;
  - `Payment(status=succeeded)` blocks cancellation because refunds are outside
    the MVP;
  - after `failed` or `expired`, the user may create a new payment attempt or
    cancel the order.
- **Rationale:** a Stripe webhook may arrive after the cancellation request, so
  the mere absence of `succeeded` at the time of an unprotected read does not
  protect financial consistency.
- **Consequences:** the condition is checked transactionally together with the
  `order_status` change. The customer or administrator waits for an active
  attempt to finish. The exact error code will be approved with the API
  contract. The MVP does not automatically expire a Stripe session during
  cancellation, cancel an order with an active Checkout Session, handle
  automatic refunds, or cancel paid orders.

## D-017: Shared Order -> Payment Concurrency Control

- **Status:** accepted on 2026-08-05
- **Decision:** order cancellation, creation of a new `Payment` attempt, and
  payment updates from a Stripe webhook use the same locking strategy. Each
  operation locks `Order` first and only then the related `Payment` records.
- **Database operation protocol:**
  1. start a short transaction;
  2. lock the relevant `Order` record, for example with
     `SELECT ... FOR UPDATE`;
  3. read or lock the required `Payment` records;
  4. check status, idempotency, and attempt-count invariants;
  5. perform the change;
  6. commit the transaction.
- **Lock order:** every flow follows `Order -> Payment`. Related `Payment`
  records, when several are locked, are retrieved in a stable order. A uniform
  order reduces deadlock risk.
- **Database integrity:** partial unique indexes continue to enforce at most one
  `Payment(status=pending)` and one `Payment(status=succeeded)` per `Order`.
  Application locks do not replace constraints or indexes.
- **Stripe integration boundary:** the transaction and `Order` lock do not
  remain open during an external Stripe call. Checkout uses a short
  `Order -> Payment` transaction that creates the attempt and stores idempotency
  data, then calls Stripe without the lock, and stores the outcome in another
  short transaction using the same lock order.
- **Rationale:** the shared `Order` record is the serialization point for
  operations that could otherwise cancel an order, start a payment, or confirm
  it through a webhook at the same time.
- **Consequences:** the implementation must include real concurrency tests. Two
  webhooks for the same event are additionally protected by event-identifier
  uniqueness and idempotent processing.

## D-018: English as the Canonical Repository Language

- **Status:** accepted on 2026-08-05
- **Decision:** all content stored in the repository must be written in English,
  including documentation, source code, API and database contracts, tests,
  logs, configuration comments, and project materials. Communication displayed
  to the user may be written in Polish.
- **Rationale:** one canonical repository language keeps implementation,
  contracts, reviews, and portfolio presentation consistent and accessible.
- **Consequences:** internal and public repository documentation must use
  English. Future Norwegian user-interface localization may be implemented only
  through an i18n layer. Translation values may then be Norwegian, but
  translation keys, source code, API contracts, and database identifiers remain
  English, which also remains the fallback language.

## D-019: Synchronous SQLAlchemy

- **Status:** accepted on 2026-08-05
- **Decision:** use synchronous SQLAlchemy 2 and Psycopg 3 for database access.
- **Rationale:** the scale of one restaurant does not justify async database
  complexity. FastAPI can run synchronous database endpoints in a thread pool,
  while transactions, Alembic, and tests remain easier to reason about.
- **Consequences:** database-accessing FastAPI endpoints should normally use
  synchronous `def`, blocking database operations must not run directly inside
  `async def`, and short explicit transactions remain required.

## D-020: PostgreSQL 17 for Local Development

- **Status:** accepted on 2026-08-05
- **Decision:** use the official `postgres:17-alpine` image for the local
  PostgreSQL service.
- **Rationale:** PostgreSQL 17 is stable, supported, and compatible with the
  planned hosting direction. It avoids PostgreSQL 18 container layout
  differences while the hosting target is not yet finalized.
- **Consequences:** the local container uses PostgreSQL 17. Compatibility must
  be reviewed again before deployment or a future major-version upgrade. The
  Windows host port is configurable and currently defaults to 5433 because
  local PostgreSQL 18 occupies 5432.

## D-021: SQLAlchemy Constraint Naming Convention

- **Status:** accepted on 2026-08-05
- **Decision:** use the approved naming convention for primary keys, foreign
  keys, unique constraints, check constraints, and indexes.
- **Rationale:** stable names improve Alembic autogenerate output and make
  future schema changes predictable.
- **Consequences:** future models must use the shared `Base` metadata. Check
  constraints using `constraint_name` must provide a short semantic name.

## D-022: Menu Money and Currency Representation

- **Status:** accepted on 2026-08-05
- **Decision:** menu prices and costs use integer minor units. `price_amount`
  must be greater than zero. `cost_amount` is optional and must be non-negative
  when present. Currency is a required three-character uppercase ASCII code
  with `NOK` as the default.
- **Rationale:** integer minor units avoid floating-point errors. A positive
  price prevents ambiguous complimentary items from being represented as
  normal menu prices. A nullable cost distinguishes an unknown cost from a
  known zero cost.
- **Consequences:** the smallest valid menu price is one minor unit.
  Complimentary items, promotions, and discounts require explicit later
  business logic. Currency validation is enforced by the database, while
  broader currency support remains possible without an enum migration.

## D-023: Allergen Storage and Mutation Tracking

- **Status:** accepted on 2026-08-05
- **Decision:** store MenuItem allergens as a non-null PostgreSQL `TEXT[]` with
  an empty-array default. Use SQLAlchemy `MutableList` to track in-place list
  changes.
- **Rationale:** an array represents the small list naturally, avoids
  comma-separated storage, and remains simple for API serialization.
  `MutableList` prevents in-place list updates from being silently ignored by
  the ORM.
- **Consequences:** the database enforces the array type and non-null value.
  API-level validation will later normalize, deduplicate, and restrict values
  against an approved catalogue. The model remains PostgreSQL-specific, and no
  GIN index is added without a demonstrated query requirement.

## D-024: Soft Deactivation and Restricted Deletion

- **Status:** accepted on 2026-08-05
- **Decision:** Category and MenuItem use `is_active` for soft deactivation.
  MenuItem separately uses `is_available` for temporary sellability. The
  Category-to-MenuItem foreign key uses `ON DELETE RESTRICT`, and the ORM does
  not use delete or delete-orphan cascade.
- **Rationale:** menu records may become unavailable without losing their
  identity or historical meaning. Restricting category deletion prevents
  accidental removal of related products.
- **Consequences:** normal application workflows should deactivate records
  instead of deleting them. Active but unavailable products may still be
  displayed with an unavailable status. Physical category deletion requires
  removal or reassignment of all related MenuItems.

## D-025: Case-Insensitive and Trim-Insensitive Menu Uniqueness

- **Status:** accepted on 2026-08-05
- **Decision:** Category names are unique by `lower(btrim(name))`. MenuItem
  names are unique within a category by
  `(category_id, lower(btrim(name)))`.
- **Rationale:** names differing only by letter case or leading and trailing
  whitespace should represent the same business value. Product names may still
  be reused across different categories.
- **Consequences:** the database prevents normalized duplicates through
  functional unique indexes. Stored values are not automatically rewritten by
  the model; future API validation should trim input before persistence.

## History of Decisions That Required Resolution

### O-002: Boundary Between Order Creation and Stripe Checkout Session

- **Status:** accepted on 2026-08-05
- **Original state:** required approval before implementing orders and Stripe.
- **Option A:** `POST /orders` creates an order, and a separate endpoint creates
  a session. It is easy to observe and retry but requires protection against
  multiple sessions.
- **Option B:** one application operation creates the order and session. This
  simplifies the frontend, but an external Stripe call does not participate in
  the database transaction and requires careful recovery.
- **Recommendation:** retain two endpoints, use an idempotency key, and control
  the active session for an order. This allows the quoted order to be stored
  durably and atomically first and a Stripe failure to be retried safely.
- **Recommendation confidence:** 0.90.
- **Accepted resolution:**
  - `POST /api/v1/orders` validates products and prices, creates `Order` and
    `OrderItem` snapshots, then returns the `public_order_number` and raw
    `order_access_token`; it does not create `Payment` and does not communicate
    with Stripe;
  - `POST /api/v1/orders/{order_id}/checkout-session` requires access to the
    order through the `public_order_number` and `X-Order-Access-Token` and
    requires the `Idempotency-Key` header; it creates
    `Payment(status=pending)`, uses the amount stored on `Order`, creates a
    Stripe Checkout Session, stores the session identifier, and returns the
    Checkout URL;
  - the same `Order` and `Idempotency-Key` pair returns the result of the same
    operation and does not create another `Payment` or another session;
  - the Stripe idempotency key is stably associated with the `Payment` attempt
    identifier;
  - after an unambiguous failure before session creation, the attempt may
    transition to `failed`;
  - after an ambiguous timeout, a retry uses the same attempt and the same
    idempotency key instead of creating a new record.

### O-003: Secure Public Retrieval of Order Status

- **Status:** accepted on 2026-08-05
- **Original state:** required approval before the public status endpoint.
- **Problem:** a predictable order number allows enumeration of other customers'
  orders and data disclosure.
- **Recommendation:** use a separate random access token stored securely, or a
  public identifier with sufficient entropy, and a minimal response schema
  without personal data.
- **Recommendation confidence:** 0.95.
- **Accepted resolution:**
  - `Order` has a presentational `public_order_number` and a separate
    `order_access_token` with at least 256 bits of randomness;
  - the raw token is returned only during order creation, and the database
    stores only its SHA-256 hash;
  - the public status endpoint requires the `public_order_number` and the
    `X-Order-Access-Token` header and compares the token securely;
  - the public response contains only `public_order_number`, `order_status`, a
    payment summary without Stripe identifiers, `order_type`, `created_at`,
    `updated_at`, and an estimated or completed timestamp when one exists;
  - the response does not contain an email address, internal UUIDs, Stripe
    identifiers, or administrator data;
  - an invalid number and an invalid token return the same generic error.

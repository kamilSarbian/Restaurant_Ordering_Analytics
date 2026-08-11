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

## D-026: Explicit and Local-Only Seed Execution

- **Status:** accepted on 2026-08-06
- **Decision:** the demonstration seed is executed only through the explicit
  `python -m app.seed` command. It is not attached to application startup,
  Alembic migrations, Docker Compose startup, deployment, or CI. The CLI
  accepts only the exact local development PostgreSQL target.
- **Rationale:** seed data is useful for local development and portfolio
  demonstrations but must never be introduced through an implicit lifecycle
  hook or an unverified remote connection.
- **Consequences:** the CLI rejects remote hosts, port 5432, test and
  administrative databases, alternative database names, and incomplete
  credentials before creating an Engine. Production bootstrap data requires a
  separate future process.

## D-027: Deterministic Seed Identities and Idempotent Upsert

- **Status:** accepted on 2026-08-06
- **Decision:** seed categories and menu items use fixed UUIDs and PostgreSQL
  primary-key upserts. A rerun restores all canonical business fields,
  preserves `created_at`, and changes `updated_at` only when a real value
  differs.
- **Rationale:** stable identifiers support repeatable local demonstrations and
  future API examples. Conditional upserts prevent duplicates and preserve
  timestamps during no-op executions.
- **Consequences:** manual changes to records owned by seed UUIDs are restored
  on rerun. Records deleted manually are recreated. All canonical fields must
  remain covered by the `IS DISTINCT FROM` update condition.

## D-028: Non-Destructive Ownership of Seed Records

- **Status:** accepted on 2026-08-06
- **Decision:** the seed owns only the approved fixed UUIDs. It never deletes,
  truncates, replaces, or claims unrelated records by normalized name. A
  normalized-name conflict involving another UUID causes the complete seed
  transaction to roll back.
- **Rationale:** local developers may create additional menu records that must
  survive repeatable seed execution. Ownership by fixed UUID prevents
  accidental takeover of unrelated data.
- **Consequences:** records removed from a future seed dataset are not
  automatically pruned. Cleanup, dataset versioning, and retirement workflows
  require a separate explicit design.

## D-029: Public Menu Visibility Rules

- **Status:** accepted on 2026-08-06
- **Decision:** the public menu returns only active categories and active menu
  items. Active but unavailable items remain visible by default and expose
  `is_available=false`. The `available_only=true` filter hides unavailable
  items. Categories without visible items are omitted. Active unavailable
  items remain accessible through the public detail endpoint.
- **Rationale:** deactivation and temporary availability represent different
  business states. Customers may still need to see temporarily unavailable
  offerings, while inactive records must remain private.
- **Consequences:** the menu response may contain unavailable products. Future
  quoting and ordering flows must revalidate both active and available state.

## D-030: Explicit Versioned Public Menu Contract

- **Status:** accepted on 2026-08-06
- **Decision:** the public menu is exposed through `GET /api/v1/menu` and
  `GET /api/v1/menu/items/{item_id}`. The list uses a `categories` envelope and
  supports only the `available_only` filter. The detail endpoint returns the
  same 404 contract for missing and non-public records. Explicit response
  schemas exclude costs, timestamps, and internal status fields.
- **Rationale:** a versioned, explicit contract provides a stable boundary for
  the future frontend and prevents ORM changes from leaking into the public
  API.
- **Consequences:** contract changes require deliberate API and documentation
  updates. Operational endpoints such as `/health` remain outside the business
  API version prefix.

## D-031: Deterministic Public Menu Ordering

- **Status:** accepted on 2026-08-06
- **Decision:** public categories are ordered by `display_order`, then `id`.
  Menu items within each category are ordered by `display_order`, then `id`.
  Ordering is enforced in the backend query layer.
- **Rationale:** database row order is not guaranteed, and clients should
  receive the same menu hierarchy without implementing their own tie-breaking
  rules.
- **Consequences:** `display_order` is part of the public response contract,
  and UUID ordering is the stable tie-breaker.

## D-032: Minimal Read-Only Query Layer

- **Status:** accepted on 2026-08-06
- **Decision:** the public menu uses synchronous SQLAlchemy and explicit
  column-level queries. The list uses two SELECT statements when categories
  exist and one when none exist. Item details use one SELECT. The
  implementation avoids lazy loading, N+1 access, and an unnecessary
  repository/service split.
- **Rationale:** the current public menu use cases are small and read-only.
  Explicit queries provide predictable performance and prevent internal fields
  from entering response serialization.
- **Consequences:** additional complex menu use cases may justify a broader
  service layer later, but Stage 6 remains intentionally minimal.

## D-033: Server-Authoritative Order Quotes

- **Status:** accepted on 2026-08-06
- **Decision:** order quote requests contain only menu item identifiers and
  quantities. Product names, prices, and currencies are always read from the
  database. All quote calculations use integer minor units.
- **Rationale:** client-supplied prices cannot be trusted. The server must
  remain authoritative for all monetary values used in a quote.
- **Consequences:** clients cannot override names, prices, or currencies. Any
  future order-creation flow must apply the same trust boundary.

## D-034: All-or-Nothing Quote Validation

- **Status:** accepted on 2026-08-06
- **Decision:** a quote either succeeds for every requested item or fails
  completely. Requests contain 1–50 unique items with quantities from 1–99.
  Duplicate identifiers return 422, missing or non-public items return 404,
  and unavailable or mixed-currency requests return 409.
- **Rationale:** partial quotes would be ambiguous for customers and difficult
  to reconcile with later order creation. Deterministic validation makes
  client behavior predictable.
- **Consequences:** the first missing, inactive, or unavailable item in request
  order terminates the quote. Mixed currency is checked only after all
  item-level validation succeeds.

## D-035: Transient Non-Persistent Quote Snapshot

- **Status:** accepted on 2026-08-06
- **Decision:** an order quote is a non-persistent point-in-time calculation.
  It has no identifier, timestamp, or expiry and does not reserve menu items,
  prices, or availability.
- **Rationale:** Stage 7 provides pricing feedback without introducing
  incomplete order persistence or reservation semantics.
- **Consequences:** a later quote may differ after a menu change. The quote
  response is not a durable business record.

## D-036: Quote and Order Revalidation Boundary

- **Status:** accepted on 2026-08-06
- **Decision:** future order creation must not trust previous quote responses
  or client-supplied prices. It re-reads active state, availability, price, and
  currency and creates the durable snapshot only when the order is created.
- **Rationale:** state may change between quoting and order creation.
  Revalidation is required to preserve server authority and transactional
  correctness.
- **Consequences:** clients submit identifiers and quantities again during
  order creation. Durable price snapshots belong to `OrderItem`, not to
  transient quotes.

## D-037: Persistent Order Aggregate and Initial State

- **Status:** accepted on 2026-08-07
- **Decision:** Stage 8 persists RestaurantTable, Order, OrderItem, and
  OrderStatusHistory. Each entity has an application-generated private UUID
  primary key. Order additionally has a unique presentational
  `public_order_number`, starts in `created`, and is written with all items and
  the initial history entry in one aggregate transaction.
- **Rationale:** a durable aggregate is required before payment, fulfilment,
  and analytics can safely refer to an order. The public identifier must remain
  separate from the internal relational key.
- **Consequences:** successful creation produces exactly one Order, one or more
  ordered OrderItems, and sequence-zero history. A failed write rolls back the
  complete aggregate. Stage 8 creates no Payment or Stripe session.

## D-038: Durable Server-Authoritative Order Snapshot

- **Status:** accepted on 2026-08-07
- **Decision:** OrderItem stores category name, item name, quantity, unit price,
  nullable unit cost, `tax_rate_bps_snapshot`,
  `discount_amount_snapshot`, and line total. Stage 8 stores the tax-rate
  snapshot as NULL and the discount snapshot as zero. Dine-in Order stores a
  table-number snapshot. Order stores currency, subtotal, and total. Derived
  totals use `BIGINT`.
- **Rationale:** the historical order must not change when menu, category,
  cost, price, availability, or table data changes later. Values supplied by
  the client are not authoritative.
- **Consequences:** creation re-reads current source rows and calculates integer
  minor-unit totals. Taxes and discounts are reserved snapshot fields but are
  not calculated in Stage 8. Future source changes do not rewrite history.

## D-039: Transactional Menu Revalidation and Row Locking

- **Status:** accepted on 2026-08-07
- **Decision:** creation revalidates current activity, availability, names,
  prices, costs, category names, and currency inside one short transaction.
  Dine-in first locks RestaurantTable with `FOR SHARE`; all creations then lock
  MenuItem and Category with `FOR SHARE` in deterministic MenuItem UUID order.
- **Rationale:** quote data and browser state may be stale. Shared row locks
  keep the source snapshot stable without serializing independent read-only
  creations globally.
- **Consequences:** the lock order is RestaurantTable before MenuItem/Category.
  Concurrent shared creations may proceed, while a conflicting source UPDATE
  or DELETE waits until the creation transaction ends. Request-order error
  precedence is evaluated after the deterministic database read.

## D-040: Order Creation Idempotency Deferred

- **Status:** accepted on 2026-08-07
- **Decision:** Stage 8 does not accept `Idempotency-Key`, store a request
  fingerprint, or deduplicate creation requests. Each valid POST creates a new
  Order. A network retry can therefore create a duplicate Order.
- **Rationale:** guest creation returns a high-entropy raw access token exactly
  once and persists only its SHA-256 hash. Reversible or plaintext token
  storage was rejected, and safely replaying the exact response would require
  a broader idempotency design.
- **Consequences:** clients must treat a lost creation response as ambiguous.
  Payment and Checkout idempotency remain a separate Stage 9 concern and will
  use the Payment-attempt boundary approved by O-002.

## D-041: Historical Order Retention and Foreign-Key Policy

- **Status:** accepted on 2026-08-07
- **Decision:** Order foreign keys use `ON DELETE RESTRICT`. ORM relationships
  use no delete or delete-orphan cascade. Order lifecycle changes status rather
  than physically deleting the aggregate, and snapshots preserve its
  historical meaning.
- **Rationale:** deleting a referenced menu item, table, item line, history
  record, or order could destroy auditable operational and future financial
  history.
- **Consequences:** physical deletion is not a normal workflow. D-016 remains
  the cancellation source of truth. Stage 8 implements its pure cancellation
  policy, while Payment-aware transactional integration remains deferred until
  a real Payment model exists.

## D-042: In-Memory Order Creation Rate Limit

- **Status:** accepted on 2026-08-07
- **Decision:** order creation uses a thread-safe fixed-window limiter allowing
  10 attempts per 60 seconds for each direct `request.client.host`. The limiter
  is app-scoped and per process, uses an injectable monotonic clock, and returns
  a positive `Retry-After` value when denying a request.
- **Rationale:** a small local MVP needs predictable abuse protection without
  introducing external infrastructure before a shared limiter is required.
- **Consequences:** denied requests execute no SQL. `X-Forwarded-For` is not
  trusted without future trusted-proxy configuration. Process restart resets
  buckets, and multi-worker shared or global limiting is deferred.

## D-043: Payment Attempt Persistence and Integrity

- **Status:** accepted on 2026-08-07
- **Decision:** `Payment` represents one durable Checkout attempt related to an
  Order. It copies the server-authoritative Order amount and currency and has
  one of `pending`, `succeeded`, `failed`, or `expired` as its status. The
  Order foreign key uses `ON DELETE RESTRICT`, and the ORM uses neither delete
  nor delete-orphan cascade.
- **Integrity:** PostgreSQL enforces
  `UNIQUE(order_id, request_idempotency_key)`, a globally unique Stripe
  idempotency key, and a globally unique nullable Checkout Session ID. Partial
  unique indexes allow at most one `pending` and one `succeeded` Payment per
  Order. A non-unique `(order_id, created_at, id)` index provides deterministic
  payment history ordering.
- **Rationale:** attempt records preserve financial history and make retries
  observable without mutating an unsuccessful terminal attempt back to
  `pending`.
- **Consequences:** Payment deletion cannot cascade from Order. Stage 9 creates
  `pending` and may mark a definitive provider rejection as `failed`;
  provider-confirmed terminal transitions remain a webhook responsibility.

## D-044: Checkout Idempotency and Ambiguous Recovery

- **Status:** accepted on 2026-08-07
- **Decision:** Checkout requires a canonical lowercase hyphenated UUIDv4
  `Idempotency-Key`. The Order and request key identify exactly one Payment,
  whose stable provider key is `checkout-session:{payment_uuid}`.
- **Replay rules:** same-key requests reuse the persisted operation. A new key
  is rejected while a `pending` Payment exists and all new attempts are
  rejected after `succeeded`. An incomplete pending attempt may call Stripe
  again with the same provider key while it is less than 23 hours old. At or
  after the conservative cutoff it remains pending for reconciliation; local
  time does not auto-expire it.
- **Ambiguity:** a definitive provider rejection may transition the attempt to
  `failed`. A transport, provider, malformed-response, or unknown failure whose
  creation outcome cannot be proven remains `pending`. A crash after remote
  success is recovered by replaying the same Stripe key. An identical provider
  replay is accepted, while a mismatched replay requires reconciliation and
  never overwrites stored provider state.
- **Rationale:** local retries must converge on the original financial
  operation even when the external outcome is temporarily unknown.
- **Consequences:** old or conflicting pending attempts require an explicit
  reconciliation process rather than unsafe local inference.

## D-045: Stripe Adapter and Two-Transaction Boundary

- **Status:** accepted on 2026-08-07
- **Decision:** the application uses a narrow adapter over the official Stripe
  Python SDK. Hosted Checkout uses `mode=payment`, one line item for the durable
  Order total, server-owned currency, validated redirect URLs, safe metadata,
  and the Payment-scoped provider idempotency key. Tests inject a fake adapter
  and make no real Stripe request.
- **Transaction boundary:** Phase 1 is a short `Order -> Payment` transaction
  that validates state and persists or identifies the attempt. The provider
  call runs after commit with no database transaction or row lock. Phase 3 is a
  second short `Order -> Payment` transaction that rechecks invariants and
  stores the result.
- **Error boundary:** request and authentication rejections known to precede
  creation are definitive. Transport, server, rate-limit, generic Stripe, and
  unknown adapter failures are treated conservatively as ambiguous.
- **Rationale:** an external request cannot participate atomically in the
  PostgreSQL transaction, and holding financial locks during network I/O would
  damage concurrency and increase deadlock risk.
- **Consequences:** every phase follows D-017, and post-provider state is
  revalidated before any write.

## D-046: Guest Checkout Contract and Exposure Boundary

- **Status:** accepted on 2026-08-07
- **Decision:**
  `POST /api/v1/orders/{public_order_number}/checkout-session` requires the
  public number, `X-Order-Access-Token`, and canonical UUIDv4
  `Idempotency-Key`. It has no monetary request body and uses a separate
  app-scoped fixed-window limiter of 10 attempts per 60 seconds per direct peer
  host.
- **Public response:** the endpoint returns only the public order number,
  Payment status, sensitive hosted Checkout URL, and expiration. It exposes no
  internal Payment or Order ID, Stripe Session ID, provider or request
  idempotency key, guest token, or token hash. The public Order status response
  still has no `payment_summary` in Stage 9.
- **HTTP behavior:** new attempts return 201, same-operation replay returns 200,
  and stable 404, 409, 422, 429, 502, and 503 outcomes cover access, state,
  validation, limiting, definitive provider failure, and unavailable or
  ambiguous session state. Rate-limit denial returns `Retry-After` before SQL.
- **Rationale:** guest Checkout needs strong unguessable authorization and
  replay protection without exposing financial internals or accepting
  client-owned money.
- **Consequences:** Checkout URLs must not be logged. Payment summary exposure
  and webhook transport require separate approved contracts.

D-016 remains verified against persisted Payment rows at the domain and
integration level. D-017 is verified through real PostgreSQL lock-order,
provider-boundary, Checkout, webhook, and cancellation-eligibility concurrency
tests. D-054 now defines the implemented administrator cancellation transition
while preserving these financial concurrency rules.

## D-047: Verified Stripe Webhook and Provider-Authoritative Transitions

- **Status:** accepted on 2026-08-08
- **Decision:** only an event whose exact raw request bytes and
  `Stripe-Signature` pass official Stripe SDK verification may apply
  provider-confirmed Payment outcomes. Stage 10 accepts
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, and `checkout.session.expired`.
  Completed and paid or asynchronous success may confirm `succeeded`; completed
  and unpaid remains pending for an asynchronous result; asynchronous failure
  may confirm `failed`; and an unpaid expired session may confirm `expired`.
- **Authority:** redirects, client claims, and local clocks cannot confirm a
  provider outcome. The first terminal Payment state wins and is never replaced
  by a later contradictory event.
- **Consequences:** webhook configuration is optional for general startup, the
  endpoint is hidden from OpenAPI, and automated verification uses local
  signatures without real Stripe calls.

## D-048: Durable Event Receipts, Correlation, and Transactional Idempotency

- **Status:** accepted on 2026-08-08
- **Decision:** StripeEvent stores one minimal durable receipt identified by a
  globally unique `stripe_event_id`. A known Payment transition and its receipt
  commit in one transaction. The nullable Payment foreign key permits a signed
  event with unknown correlation to be retained as
  `reconciliation_required` without inventing a Payment.
- **Correlation:** the service checks Payment ID, Order ID, public order number,
  Checkout Session ID, amount, currency, and mode against server-owned data.
  A mismatch is acknowledged only after a durable reconciliation receipt and
  never becomes a signature error.
- **Consequences:** duplicates remain idempotent across restarts. Valid signed
  events outside the Stage 10 allowlist are acknowledged without persistence,
  and raw payloads, signatures, Checkout URLs, and metadata JSON are not stored.

## D-049: Webhook Concurrency with Checkout and Cancellation

- **Status:** accepted on 2026-08-08
- **Decision:** known webhook processing reuses D-017 and locks Order before
  related Payments ordered by creation time and UUID. It never uses an
  Event-to-Payment-to-Order lock order. Event-ID uniqueness additionally
  protects concurrent duplicate delivery.
- **Races:** the first committed terminal event wins. A webhook may precede
  Checkout Phase 3; Phase 3 may then fill an entirely empty provider session
  tuple for the exact already-succeeded Payment without regressing status, but
  cannot do so after failure or expiration. Future cancellation uses the same
  Order-to-Payment lock order and D-016 blocking policy.
- **Consequences:** real PostgreSQL tests cover known and unknown duplicate
  races, success versus expiration, Checkout Phase 3, and cancellation
  eligibility without deadlocks. This decision extends D-016, D-017, and
  D-043 through D-046 without adding a cancellation endpoint.

## D-050: Persisted Administrator Identity and Argon2id Password Storage

- **Status:** accepted on 2026-08-09
- **Decision:** administrators use a separate minimal `AdminUser` with an
  application-generated UUID, normalized unique lowercase email, nonblank
  password hash, `is_active`, and timezone-aware timestamps. pwdlib hashes exact
  15–128-code-point bootstrap passwords with Argon2id using memory cost 19456
  KiB, time cost 2, parallelism 1, and a library-generated salt. There is no
  pepper, plaintext password, role, token version, reset state, MFA state,
  customer account, general User model, or public registration.
- **Provisioning:** migration `0006_create_admin_user_model` is schema-only and
  creates zero administrators. Creation occurs only through the explicit
  `python -m app.auth.bootstrap --email <email>` CLI, which reads password and
  confirmation through `getpass`, exposes no password argument, and never
  overwrites or reactivates a duplicate normalized identity. PostgreSQL email
  uniqueness is the final arbiter for concurrent creation.
- **Consequences:** imports, application startup, migrations, Docker Compose,
  tests, and the menu seed never create a default administrator. Password
  reset/change and MFA remain deferred and require separate approval.

## D-051: Short-Lived Administrator JWT Access Tokens

- **Status:** accepted on 2026-08-09
- **Decision:** administrator access tokens use PyJWT with only HS256 and key
  material of at least 32 UTF-8 bytes. Tokens contain exactly canonical
  AdminUser UUID `sub`, fixed administrator token `type`, integer `iat` and
  `exp`, fixed issuer, and fixed audience. Decoding explicitly allowlists
  `algorithms=[HS256]`, requires every claim, rejects noncanonical subjects and
  invalid time windows, and uses an injectable UTC clock.
- **Lifetime:** the default access-token lifetime is 30 minutes and
  configuration permits only 1 through 60 minutes. There is no default JWT
  secret. General application startup remains possible without auth
  configuration, while auth operations return 503 until configured.
- **Consequences:** Stage 11 has no refresh tokens, logout endpoint, revocation
  list, token version, or MFA. Every protected request additionally reloads the
  current active AdminUser, so deactivation invalidates an unexpired token
  immediately. Deployment must use HTTPS.

## D-052: Administrator Login Protection and Failure Semantics

- **Status:** accepted on 2026-08-09
- **Decision:** login validates and normalizes email, accepts password input
  from 1 through 128 code points, performs one exact email SELECT, and uses real
  Argon2 verification for a known identity. An unknown identity performs one
  lazily initialized process-local dummy verification whose source is random;
  no static dummy credential or hash is stored. Inactive identities complete
  real password verification before rejection.
- **HTTP boundary:** unknown identities, wrong passwords, and inactive
  identities share one login 401. Missing, malformed, expired, wrong, unknown,
  or inactive Bearer identities share one protected 401 with a Bearer
  challenge. `AdminBearer` performs token validation before a current active
  AdminUser lookup. Public customer routes remain unauthenticated, login is
  public, `/auth/me` is protected, and the Stripe webhook remains hidden from
  OpenAPI.
- **Rate limiting:** a separate app-scoped, per-process fixed window permits
  five login attempts per 60 seconds for each direct peer. It ignores
  `X-Forwarded-For` without trusted-proxy configuration and returns 429 with a
  positive `Retry-After` before SQL, Argon2, or token creation. Schema 422 and
  unavailable-service 503 outcomes precede limiter consumption where defined.
- **Consequences:** a distributed limiter and trusted-proxy identity policy are
  deferred until deployment needs demonstrate them. Stage 12 reuses the
  authorization dependency but remains separately approved scope.

## D-053: Administrator Operational API Boundary

- **Status:** accepted on 2026-08-11
- **Decision:** authenticated operational endpoints use the
  `/api/v1/admin/...` route family and the existing `require_admin` dependency.
  Stage 12 exposes administrator order list, detail, and status mutation plus
  category and menu-item list, create, and partial update operations.
- **Security boundary:** the login endpoint remains public, `/auth/me` and all
  operational routes use AdminBearer, and public customer routes receive no
  global administrator dependency. The provider-facing Stripe webhook remains
  hidden from OpenAPI.
- **Consequences:** Stage 12 adds no RestaurantTable management, refund,
  StripeEvent diagnostic, generic audit-log, or analytics endpoint. Those
  capabilities require separately approved stages.

## D-054: Transactional Order Status Transition and History Protocol

- **Status:** accepted on 2026-08-11
- **Decision:** the fulfilment graph permits exactly `created -> accepted`,
  `created -> cancelled`, `accepted -> preparing`, `preparing -> ready`, and
  `ready -> completed`; `completed` and `cancelled` are terminal. Acceptance
  requires at least one related `Payment(status=succeeded)`.
- **Transaction protocol:** a transition locks Order with `FOR UPDATE`.
  Acceptance and cancellation then lock related Payments in stable creation
  time and UUID order, preserving D-017's `Order -> Payment` protocol. D-016
  remains authoritative for cancellation: pending and succeeded attempts block
  it, while failed, expired, or absent attempts do not.
- **Atomicity:** one successful operation updates `Order.status` and appends
  exactly one sequenced history row in the same short transaction. The Order
  lock serializes sequence allocation, and no Stripe provider call occurs while
  locks are held.
- **Consequences:** Stage 12 adds no reversal, separate cancellation endpoint,
  paid-order cancellation, refund, or actor attribution to status history.

## D-055: Administrative Menu Mutation and Soft-Deactivation Semantics

- **Status:** accepted on 2026-08-11
- **Decision:** administrators may list, create, and partially update Category
  and MenuItem records. There is no physical DELETE route or service operation;
  lifecycle changes use `is_active`, while `MenuItem.is_available` independently
  represents temporary orderability.
- **Integrity:** category names remain globally unique by
  `lower(btrim(name))`; menu-item names remain unique by category and
  `lower(btrim(name))`. PostgreSQL indexes are the final arbiter. PATCH locks
  the target row with `FOR UPDATE`, and only known uniqueness violations map to
  a conflict.
- **Visibility and history:** deactivating a category does not rewrite child
  item flags. Inactive categories remain manageable, item reassignment to an
  existing inactive category is allowed, and activity and availability flags
  have no automatic coupling. Public menu rules continue to filter current
  state, while persisted OrderItem name, category, price, and cost snapshots
  remain immutable.
- **Consequences:** Stage 12 requires no model or migration change and adds no
  menu audit actor or generic audit log.

## D-056: Analytics Source-of-Truth and Historical Snapshot Semantics

- **Status:** accepted on 2026-08-11
- **Decision:** collected revenue uses `Payment.amount` from succeeded
  Payments, and paid-order count uses distinct succeeded `Payment.order_id`.
  Time-bounded inclusion is anchored to the earliest transitioned successful
  StripeEvent receipt for that Payment. `Payment.updated_at` is not analytics
  event time.
- **History boundary:** product and category analytics use immutable
  `OrderItem` snapshots and never current catalog state. Products retain their
  menu-item UUID and historical name; categories group by historical name
  because OrderItem stores no historical Category UUID. Catalog changes do not
  rewrite historical results.
- **Consequences:** Stage 13 has no cost or margin analytics, and
  `Order.total_amount` is not the source of collected revenue.

## D-057: Analytics Time-Range, Currency, Aggregation, and Query Boundary

- **Status:** accepted on 2026-08-11
- **Decision:** every analytics request requires aware `start` and `end` and
  applies the half-open `[start, end)` interval to UTC instants. Response range
  metadata is normalized to `Europe/Oslo`. An optional currency filter is
  exactly three uppercase ASCII letters; mixed-currency totals and FX
  conversion are prohibited.
- **Result semantics:** an unfiltered empty overview has no currency rows,
  while an explicit valid empty currency has one zero row. Product and category
  top-N limits apply independently per currency. AOV is calculated per currency
  in integer minor units with `ROUND_HALF_UP`.
- **Query boundary:** each endpoint performs one set-based aggregate SELECT
  after authentication. Product and category ranking uses PostgreSQL window
  functions. Current MVP scale requires no analytics persistence, new index,
  or migration.

## D-058 — CSV Export Contract, Source Boundaries, and Spreadsheet Safety

- **Status:** accepted on 2026-08-11
- **Decision:** Stage 14 exposes exactly three administrator-only CSV routes
  for orders, full product sales, and qualified succeeded payments. Responses
  are synchronous and buffered, use deterministic ASCII filenames, and encode
  UTF-8-SIG with exactly one BOM, comma delimiters, minimal double-quote
  quoting, and CRLF record terminators.
- **Source boundaries:** the orders range is based on `Order.created_at`.
  Product-sales and payments ranges use the earliest qualifying transitioned
  successful StripeEvent time for a succeeded Payment. Product-sales reuses
  the Stage 13 historical aggregation without its JSON per-currency top-N
  cutoff; success-event qualification is not duplicated.
- **Spreadsheet safety:** formula-like text beginning with `=`, `+`, `-`, or
  `@`, including dangerous leading whitespace and control forms, is
  neutralized with a leading apostrophe during serialization. NUL characters
  are removed first. Sanitization occurs after database grouping and never
  changes persisted values.
- **Exposure boundary:** exports include only approved operational and
  historical fields. They contain no PII, internal Order, Payment, or
  StripeEvent IDs, provider URLs or identifiers, event data, idempotency keys,
  guest credentials, administrator identity, or cost data.
- **Consequences:** Stage 14 adds no export persistence, table, materialized
  view, index, or migration. In-memory buffering is accepted for the current
  single-restaurant MVP scale; streaming and background exports require a
  measured need and separate approval.

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

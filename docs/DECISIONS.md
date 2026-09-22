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
- **Historical consequence:** when this decision was accepted, the roadmap
  placed deployment in Stage 20 and portfolio documentation in Stage 21. Later
  planning split repository deployment readiness from public deployment and
  inserted the Nordic Hearth UI/UX stage. The current sequence is Stage 20
  Production Deployment Readiness, Stage 21 UI/UX Redesign & Product Polish,
  Stage 22 Production Deployment & Public Acceptance, and Stage 23 Portfolio
  Documentation & Case Study. This does not change the Docker-before-E2E
  ordering.

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

## D-059 — Customer Frontend Trust, Guest Session, and Order-Creation Boundary

- **Status:** accepted on 2026-08-11
- **Decision:** Stage 15 is a guest-only React application. The browser submits
  only menu-item identifiers, quantities, order type, and an optional table
  number; the backend remains authoritative for visibility, availability,
  names, prices, currency, totals, Order state, and Payment state. There is no
  customer account, PII collection, administrator frontend, or frontend-owned
  business transition.
- **Session boundary:** the versioned cart stores only identifiers and
  quantities in `sessionStorage`. The raw order access token returned once by
  creation is retained only for the current session or transient memory and is
  sent only in `X-Order-Access-Token`. The app uses no `localStorage` and never
  places the guest token in a URL, rendered DOM, or log.
- **Order-creation boundary:** cart changes obtain transient, debounced quotes,
  and submit obtains a fresh quote before `POST /orders`. Because order creation
  is not idempotent, the client prevents ordinary duplicate submission but does
  not automatically retry an ambiguous network or timeout result. A deliberate
  retry remains possible only with an explicit duplicate-order warning.
- **Consequences:** corrupted session records are discarded, raw backend error
  details are not rendered, and Stage 15 requires no backend model, schema,
  route, migration, customer identity, or long-lived browser credential.

## D-060 — Checkout Idempotency, Return Semantics, and Fulfilment Polling

- **Status:** accepted on 2026-08-11
- **Decision:** each browser Checkout attempt uses a canonical lowercase UUIDv4
  `Idempotency-Key` and the guest access header. Network, timeout, HTTP 429 and
  503, and redirect failures retain the same attempt. Only explicit customer
  action after definitive HTTP 502 creates a new key. The attempt record stores
  no token, Checkout URL, Stripe identifier, or Payment identifier, and hosted
  Checkout opens in the same tab without Stripe.js.
- **Return semantics:** the payment-return and checkout-cancelled routes are
  neutral navigation outcomes. Neither route changes or infers Payment state,
  and the success URL is never presented as payment confirmation. The public
  status screen displays only fulfilment status.
- **Polling boundary:** protected Order status begins immediately with at most
  one request in flight. Normal polls occur 8 seconds after settlement;
  transient retries use bounded 8, 16, and 30 second delays. Polling pauses when
  hidden or offline, resumes when visible and online, aborts stale work, and
  stops for `completed`, `cancelled`, privacy-preserving 404, or an invalid
  response contract. WebSockets and server-sent events are deferred.
- **Consequences:** webhook processing remains the only authority for terminal
  Payment transitions. Responsive manual acceptance at the approved mobile,
  tablet, and desktop viewports remains a completion gate for Stage 15.

## D-061 — Unified User Identity and Role Model

- **Status:** accepted on 2026-08-12
- **Decision:** every registered identity uses one minimal `User` with a
  normalized unique email, Argon2id password hash, active flag, timestamps, and
  exactly one role: `customer`, `admin`, or `super_admin`. The role uses a
  Python `StrEnum`, a `VARCHAR` column, and a database `CHECK`; no Role table or
  multi-role RBAC layer is justified. An anonymous `guest` is neither a User
  nor a role.
- **Registration and authority:** public registration always creates
  `customer` and rejects any role field. JWT identifies the User, while the
  current database role and active state are authoritative on every protected
  request. Client state and any informational token claim cannot grant access.
  `require_admin` accepts `admin` and `super_admin`; `require_super_admin`
  protects role changes.
- **Migration and highest trust:** migration 0007 evolves `admin_users`
  into `users` while preserving identity and password data and maps the
  documented single existing administrator to the initial `super_admin`. Zero
  rows remain valid for later secure bootstrap; an unexpected multi-admin
  migration state fails safely. Public registration and ordinary administrators
  cannot grant `super_admin`, the normal role workflow allows only
  `customer <-> admin`, and backend invariants preserve at least one active
  `super_admin` whenever one exists.
- **Consequences:** Stage 16D implements the migration and database-backed
  unified User dependencies while retaining existing `/api/v1/admin/...`
  operational contracts. `AdminUser` is a temporary Python import alias only;
  no multi-role, OAuth, MFA, or profile fields are added.

## D-062 — Guest Ordering, Account Ownership, and Landing/Auth Direction

- **Status:** accepted on 2026-08-12
- **Decision:** anonymous guest ordering remains fully available without login
  or registration. Registered identities now use unified
  `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, and
  `GET /api/v1/auth/me` routes. The planned Stage 16F `/` landing page offers
  Order as guest, Log in, and Create account; the public menu moves to `/menu`.
- **Ownership:** a planned nullable indexed `Order.customer_user_id` references
  `User.id` with `ON DELETE SET NULL`. Anonymous creation stores NULL; creation
  with a valid current User stores that User ID. Missing Authorization means
  guest creation, but an invalid supplied Authorization value returns 401 and
  never silently downgrades to guest.
- **Access and privacy:** every Order continues to receive its independent
  order-access token for Checkout and public status. The owner ID is not public,
  customer account queries filter by the current User on the server, and the
  own-order list and detail expose no other user's Order. Historical anonymous
  Orders cannot be claimed retroactively.
- **Consequences:** account ownership supplements rather than replaces the
  current guest credential. Unified backend authentication is implemented;
  nullable ownership, own-order history, and the landing/account frontend
  remain planned before Stage 17.

## D-063 — Administrator Frontend Session and Operational Interaction Model

- **Status:** accepted on 2026-08-12
- **Decision:** the current administrator client uses a dedicated AdminShell and
  protected `/admin/...` route tree. Its opaque access token is held in memory
  and in the versioned current-tab `restaurant-ordering:admin-auth:v1`
  `sessionStorage` record, and protected rendering requires a successful
  `/api/v1/admin/auth/me` validation. The shared transport may attach Bearer
  only to canonical administrator API paths; there is no global interceptor.
- **Operational interaction:** orders use list/detail reads and explicit status
  actions derived from the current backend state. Each mutation requires inline
  confirmation, sends one PATCH, performs no optimistic update, and refetches
  authoritative detail. An ambiguous result or failed post-mutation refetch
  blocks another action until Refresh. Menu administration similarly uses only
  GET, POST, and changed-only PATCH, never DELETE or optimistic mutation.
- **Consequences:** Stage 16 adds no administrator automatic polling, frontend
  authority over fulfilment, fabricated history or Payment data, refund flow,
  or finer RBAC. Frontend logout clears the current session because the backend
  has no logout endpoint. Stage 16D makes the legacy login alias issue unified
  `user_access`; Stage 16F will replace the temporary administrator-specific
  browser session model.

## D-064 — Administrator Analytics Time Boundary and CSV Download Model

- **Status:** accepted on 2026-08-12
- **Decision:** administrator reporting uses date-only Europe/Oslo controls that
  convert to explicit aware ISO instants and a half-open `[start, end)` backend
  range. The inclusive UI end date becomes the next Oslo midnight. The default
  covers the last seven Oslo calendar days including today, and the helper is
  DST-tested without depending on the host local time zone.
- **Analytics interaction:** four requests run in parallel under one generation
  with abort and stale-response protection. Sections can fail independently,
  there is no polling or automatic retry, and currencies remain separate with
  no FX. Stage 16 makes no time-series, cost, margin, or profit claim.
- **CSV interaction:** authenticated exports use the administrator Blob
  transport that shares the JSON transport's path and Bearer boundary. The
  backend CSV Blob remains unparsed and unmodified. A conservative quoted ASCII
  `.csv` filename allowlist falls back by report type, and one temporary object
  URL is always revoked after the download click. No Blob is persisted.

## D-065 — Unified User Authentication and Database-Authoritative Role Authorization

- **Status:** accepted on 2026-08-12
- **Decision:** canonical `register`, `login`, and `me` contracts use one User
  identity evolved from AdminUser, with exactly one of `customer`, `admin`, or
  `super_admin`. An anonymous guest is neither a User nor a role. Public
  registration always creates `customer`. Canonical
  `user_access` and temporary legacy `admin_access` tokens have strict types and
  distinct audiences; production login routes issue only `user_access`.
- **Authorization:** tokens identify a User but contain no role authority.
  Every protected request reloads current `role` and `is_active` from
  PostgreSQL. `get_current_user` accepts an active canonical User,
  `require_admin` permits current `admin` or `super_admin`, and
  `require_super_admin` permits only current `super_admin`. Missing, invalid,
  inactive, or deleted identities return 401; an authenticated insufficient
  role returns 403.
- **Compatibility:** the existing administrator login and me routes remain
  aliases for frontend continuity. Login rejects customers with a generic 401
  and issues `user_access`; strict legacy `admin_access` is validation-only.
  Both login aliases share one limiter, while registration has a separate
  limiter.
- **Consequences:** role changes and deactivation affect existing tokens
  immediately. No refresh token, logout, revocation list, OAuth, MFA, password
  reset, token role claim, or parallel identity table is introduced.

## D-066 — Super-Admin Role Governance, Bootstrap, and Auth Configuration Transition

- **Status:** accepted on 2026-08-12
- **Role governance:** super-admin-only User listing exposes safe fields and
  deterministic pagination. Role mutation locks the target row and permits only
  `customer <-> admin`; it cannot assign, demote, or otherwise modify a
  `super_admin`, mutate active state, or delete a User.
- **Bootstrap:** the explicit interactive command reads the password with
  `getpass`, applies the existing Argon2id policy, and takes a deterministic
  PostgreSQL transaction advisory lock. Any active or inactive super-admin
  blocks another; customer and admin rows do not. Concurrent first-bootstrap
  attempts create exactly one super-admin.
- **Configuration:** `AUTH_JWT_SECRET` and
  `AUTH_ACCESS_TOKEN_EXPIRE_MINUTES` are canonical. Temporary `ADMIN_*` input
  aliases support existing environments. Canonical-only, legacy-only, and equal
  dual values are accepted; conflicting dual values fail safely without
  exposing secrets.
- **Migration:** 0007 renames `admin_users` to `users`, preserves zero or one
  historical identity, maps exactly one to `super_admin`, and fails atomically
  for more than one. The role is constrained, non-null, and has no server
  default. Downgrade is guarded against customer-data loss. Repository head is
  0007; the development database remains deliberately at 0006 until a separate
  approved migration operation.

## D-067 — Order Ownership and Mixed Guest/Authenticated Access

- **Status:** accepted on 2026-08-13
- **Decision:** `orders.customer_user_id` is a nullable UUID foreign key to
  `users.id` with `ON DELETE SET NULL`, no Python or server default, no backfill,
  and no ORM ownership relationship. An anonymous guest remains neither a User
  nor a role. Historical Orders remain unowned, and no flow retroactively claims
  them.
- **Creation boundary:** an absent Authorization header creates an unowned
  guest Order. A valid canonical `user_access` assigns the current active User
  in the initial Order aggregate transaction, with no follow-up ownership
  update. All active roles may own personal Orders. A present invalid,
  malformed, legacy `admin_access`, inactive, or missing-User credential is not
  downgraded to guest access.
- **Independent capability:** every Order, including an owned Order, retains the
  one-time raw guest capability whose hash is persisted. Public status and
  Checkout authorize a matching non-NULL owner or a valid capability. A
  canonical non-owner without the capability receives the same 404 as an
  unknown Order; public routes do not use 403 to disclose ownership. Invalid
  present canonical authentication fails before capability fallback, and roles
  grant no public bypass.
- **Persistence:** migration `0008_add_order_ownership`, child of
  `0007_unify_user_auth_roles`, adds the nullable foreign key and non-unique
  `(customer_user_id, created_at, id)` index. User deletion may null ownership
  while preserving Order history; no User-delete API is introduced.
- **Qualification:** this decision creates the sole ownership-FK exception to
  D-041's Order retention rule and adds canonical ownership as an alternative
  to the capability-only clauses in D-046 and O-003. Their capability secrecy,
  minimal response, idempotency, retention, and financial lock rules remain
  unchanged. It also implements the backend ownership portion that D-062
  recorded as planned; D-062's landing and customer-account frontend remains
  future Stage 16F work. D-066's repository-head statement records the 0007
  state when that decision was accepted; the current head is 0008.

## D-068 — Customer Account Order History and Privacy Boundary

- **Status:** accepted on 2026-08-13
- **Decision:** the account API is read-only and accepts strict canonical
  `user_access` only. `customer`, `admin`, and `super_admin` all use personal
  account scope; administrator roles have no global account-history bypass.
- **SQL privacy:** list SELECT, list COUNT, and detail lookup are scoped by the
  current User in SQL. Detail combines `public_order_number` and
  `customer_user_id` in one predicate. Another User's Order, an unowned Order,
  and an unknown Order return the same 404. A guest capability cannot bypass
  account ownership.
- **Safe contracts:** list uses a dedicated seven-field summary DTO. Detail
  reuses the shared safe `OrderStatusResponse` serializer after authorization;
  that builder performs serialization only. Neither contract exposes owner
  identity, PII, a guest capability or hash, Payment, or Stripe data.
- **Pagination:** list defaults to `limit=50` and `offset=0`, accepts limits from
  1 through 100, reports an owner-scoped total, and orders deterministically by
  `created_at DESC, id DESC`. No account mutation, ownership claim, or owner
  reassignment route is added.

## D-069 — Unified Frontend Authentication and Session Transition

- **Status:** accepted on 2026-08-14
- **Decision:** one shared frontend `AuthContext` owns authentication for
  `customer`, `admin`, and `super_admin`. It uses the canonical `user_access`
  token only, treats the token as opaque, and obtains current identity, role,
  and active state from database-authoritative `GET /api/v1/auth/me`; the
  browser never parses JWT role authority.
- **Session transition:** the canonical current-tab record is
  `restaurant-ordering:auth:v1` in `sessionStorage`, with an in-memory fallback
  when storage is unavailable and no `localStorage`. The former
  `restaurant-ordering:admin-auth:v1` record is accepted only as a one-time
  migration candidate and is removed after validation or rejection; it is not
  a parallel live session silo.
- **Routing:** `/login` is the unified sign-in route, `/register` is public, and
  `/admin/login` is a compatibility redirect. Successful authentication
  defaults to `/account`. A same-origin, role-aware `next` allowlist permits
  account destinations for every authenticated role, operational administrator
  destinations for `admin` and `super_admin`, and `/admin/users` only for
  `super_admin`; auth loops and unsafe destinations are rejected. Tokens are
  never placed in route state or URLs.
- **Race and authorization safety:** the context has explicit
  `checking-session`, `authenticated`, `unauthenticated`, and
  `temporarily-unavailable` states. Abort and generation guards prevent stale
  completions from replacing current state. An HTTP 401 clears a session only
  when the request captured the still-current token and generation. An
  administrator HTTP 403 refreshes `/auth/me` so current database role drives
  the safe fallback.
- **Qualification:** this decision supersedes D-063's temporary
  administrator-specific browser-session clauses and the Stage 16F future tense
  in D-062 and D-067. D-063's operational mutation rules and the backend auth
  compatibility aliases remain unchanged. D-066's development-database-at-0006
  statement records its acceptance-time state; approved Stage 16F local-QA
  preparation later upgraded that database through 0008 while preserving the
  historical administrator as `super_admin`.

## D-070 — Customer Account and Authenticated Ordering Frontend

- **Status:** accepted on 2026-08-14
- **Decision:** `/` is the restaurant landing page and `/menu` is the public
  menu. Anonymous ordering remains fully supported. Menu and quote requests
  carry no authentication; guest creation carries no Bearer; authenticated
  creation carries the current canonical Bearer so the backend can assign
  ownership.
- **Mixed access:** every Order still receives its independent capability.
  Guest status uses the capability, and guest Checkout uses the capability plus
  its UUIDv4 idempotency key. Authenticated status and Checkout use Bearer plus
  the capability when available, while the matching owner works without the
  capability. A checking or temporarily unavailable session never silently
  downgrades to guest, and an authenticated failure is never retried
  anonymously.
- **Account:** `/account` and `/account/orders/:publicOrderNumber` provide
  paginated history and detail for the current User. Every authenticated role
  has personal scope only. Account requests use strict canonical Bearer and no
  guest-capability authority. Cross-user, unowned, and unknown detail share the
  same 404, and the shared safe Order summary exposes no owner identity, PII,
  Payment, Stripe, cost, or margin data.
- **Consequences:** authenticated creation links only new Orders; historical
  guest Orders are not claimed retroactively. The independent capability is
  retained for newly owned Orders, and the post-authentication default remains
  `/account`. This implements the landing, mixed-ordering, and account frontend
  recorded as future in D-062 and D-067 and renders D-068's API privacy boundary
  without changing their backend ownership, capability, or privacy invariants.

## D-071 — Super-Admin User Management Frontend

- **Status:** accepted on 2026-08-14
- **Decision:** `/admin/users` is guarded for the current `super_admin` and uses
  the backend's database-authoritative safe list and role-transition contracts.
  The UI offers only `customer -> admin` and `admin -> customer`. Every
  `super_admin` row is read-only, and the client cannot assign, demote, or
  otherwise mutate `super_admin`.
- **Mutation protocol:** each change requires explicit confirmation, sends one
  PATCH, performs no optimistic update, and obtains authoritative state through
  list refetch. A network, timeout, uncertain server result, or failed
  post-mutation refetch establishes a reconciliation gate that disables further
  role actions until a successful refresh.
- **Authorization changes:** current-token 401 handling uses D-069's generation
  safety. A 403 refreshes canonical `/auth/me` before routing according to the
  current role. A customer falls back to `/account`; an ordinary administrator
  denied `/admin/users` falls back to `/admin`.
- **Consequences:** the frontend provides no User deletion, password reset,
  active-state mutation, super-admin assignment, or super-admin demotion. This
  extends D-066's backend governance into the browser and supersedes only the
  earlier statement that the `/admin/users` frontend was not implemented; all
  backend bootstrap and last-super-admin protections remain authoritative.

## D-072 — Canonical Authentication Compatibility Finalization

- **Status:** accepted on 2026-08-15
- **Decision:** Stage 16G removes the legacy backend administrator-auth
  compatibility surface. `UserBearer` is the only runtime bearer security
  scheme, `user_access` is the only runtime JWT token family, and runtime
  authentication configuration uses only `AUTH_JWT_SECRET` and
  `AUTH_ACCESS_TOKEN_EXPIRE_MINUTES`. The former `AdminBearer` scheme and
  `AdminUser` runtime import alias are removed.
- **Route and token boundary:** `POST /api/v1/admin/auth/login` and
  `GET /api/v1/admin/auth/me` are intentionally not mounted and return 404.
  Synthetic `admin_access` tokens remain only as negative-test inputs and are
  never accepted by runtime authorization.
- **Authority:** JWT identifies the canonical User, while PostgreSQL remains
  authoritative for the current `role` and `is_active` state on every protected
  request.
- **Client-side compatibility:** the accepted frontend `/admin/login` redirect
  and one-time migration or cleanup of the former administrator session key may
  remain. They are client-side compatibility only and do not restore a backend
  route, token family, security scheme, model alias, or configuration alias.
- **Tradeoff:** breaking callers of the removed backend compatibility surface is
  intentional. No known current frontend or external runtime consumer depends
  on it.
- **Qualification:** D-050 through D-053 remain acceptance-time history. This
  decision supersedes only the remaining backend compatibility clauses in
  D-061, D-063, D-065 through D-067, and D-069; their other security invariants
  and D-069 through D-071 frontend behavior remain unchanged.

## D-073 — Integrated Acceptance Environment and Test-Data Isolation

- **Status:** accepted on 2026-08-15
- **Decision:** destructive or integrated role, Order, and account acceptance
  uses an isolated temporary PostgreSQL database. The development database must
  not receive disposable role, User, Order, or account acceptance data.
- **Target and cleanup guards:** the harness requires an exact allowlisted local
  host, project PostgreSQL port 5433, and the exact
  `restaurant_ordering_analytics_stage16g` database name. It captures the
  database OID immediately after creation and verifies the same OID and target
  immediately before drop. A mismatch aborts cleanup.
- **Data and integration boundary:** acceptance identities are synthetic and
  disposable. Payment acceptance uses an injected fake provider and never
  creates a real Stripe charge.
- **Lifecycle and evidence:** acceptance harnesses are ephemeral and untracked.
  The development database fingerprint is compared before and after the run,
  and the isolated database must be removed after successful acceptance.
- **Infrastructure boundary:** host PostgreSQL on port 5432 and the project
  PostgreSQL named volume remain untouched.
- **Consequences:** integrated acceptance requires explicit environment guards
  and cleanup evidence, but it cannot pollute development data or create a
  permanent repository harness.

## D-074 — Container Topology, Explicit Migration, and Readiness Boundary

- **Status:** accepted on 2026-08-22
- **Topology:** the Stage 17 Compose application has exactly four services:
  `postgres`, a one-shot `migrate` job, `backend`, and `frontend`. Frontend Nginx
  is the sole application ingress and serves the SPA while forwarding
  same-origin `/api` requests to the private backend. Backend and migrate have no
  host port. PostgreSQL is published only on a configurable loopback port for
  local tooling. The `app` network connects frontend to backend, while the
  `data` network connects backend and migrate to PostgreSQL.
- **Migration and startup:** PostgreSQL health gates the explicit, non-restarting
  `alembic upgrade head` migration job. Backend may start only after that job
  succeeds and must independently pass the read-only
  `alembic current --check-heads` guard before starting one Uvicorn worker.
  Backend readiness then gates frontend startup. Startup performs no seed,
  bootstrap, reset, downgrade, or migration hidden inside the application
  process.
- **Readiness boundary:** `/health` remains a database-independent liveness
  response. `/ready` is the backend readiness contract and succeeds only after a
  `SELECT 1` database probe; predictable database failures return a safe 503.
  Frontend exposes its separate Nginx `/healthz` check, and operational health
  paths never use the SPA fallback.
- **Hardening and persistence:** backend and migrate run as fixed non-root user
  and group `10001:10001`, and frontend runs as `101:101`. Application
  containers use read-only root filesystems, a constrained `/tmp` tmpfs, all
  capabilities dropped, and `no-new-privileges`. PostgreSQL data remains in a
  named volume across ordinary shutdowns. Secrets enter at runtime through the
  environment and are not baked into images.
- **Local and public deployment boundary:** the current local database role is
  acceptable only for the loopback-only Stage 17 environment. This decision
  does not approve a public deployment. A later deployment stage must provide
  HTTPS, a secret manager, a least-privilege production database role, and an
  explicit trusted-proxy boundary before exposing the application publicly.
- **Rationale:** a separate migration job makes schema mutation visible and
  fail-closed, while independent head and readiness checks prevent an outdated
  schema or unavailable database from being presented as a healthy application.
  One same-origin ingress keeps the browser-to-API trust boundary small.
- **Consequences:** the accepted startup chain is PostgreSQL healthy, migration
  successful, backend head check and readiness successful, then frontend. The
  backend remains private, no wildcard CORS policy is required, and the
  persistent database volume is never reset implicitly. This decision completes
  D-015's full-system Docker direction without changing the modular-monolith
  decision or making the one-shot migration job a long-running application
  tier.

## D-075 — Isolated Browser E2E, Fake Payment Provider, and Artifact Boundary

- **Status:** accepted on 2026-08-23
- **Browser framework:** Playwright Test 1.62.1 with Chromium is the sole
  browser-E2E framework. Runs use one worker and zero retries. The required
  browser proof is a real Playwright-controlled Chromium run; no in-app-browser
  result is claimed, and no Axe, Cypress, or second browser-E2E framework is
  introduced.
- **Isolation:** every browser-E2E run uses a unique Compose project with its
  own PostgreSQL database and named volume plus synthetic credentials. The
  development database is never used for disposable E2E data, and the real
  `.env` and development volume remain outside the acceptance boundary.
- **Fake payment boundary:** the fake provider exists only in the isolated
  test-only `backend/e2e_harness.py` process. The browser receives only an
  opaque Checkout handle. A process-local server registry retains the trusted
  payment and internal-ID facts. Amount, status, internal identifiers, Order
  capability, and webhook secret are never accepted from the browser; status
  and the signed synthetic event are derived server-side and delivered through
  the real webhook endpoint. The flow makes no real Stripe request and adds no
  production E2E backdoor.
- **Artifact boundary:** trace, video, HAR, and `storageState` capture remain
  disabled; screenshots are failure-only. Synthetic credentials, JWTs, Order
  capabilities, DSNs, and webhook secrets must not be logged or persisted as
  artifacts.
- **Retention:** acceptance containers and networks are removed after a run.
  Retained E2E volumes are not deleted without separate explicit approval.
- **Consequences:** browser acceptance exercises the real ingress, API,
  database, signature-verification, authorization, and financial state paths
  while keeping disposable data, fake-provider state, and sensitive test
  material outside development and production boundaries.

## D-076 — Deterministic Least-Privilege CI and Isolated Browser Validation

- **Status:** accepted on 2026-08-24
- **Decision:** Stage 19 uses one GitHub Actions workflow with exactly four
  required checks: `Backend`, `Migrations`, `Frontend`, and `Browser E2E`.
  Backend, Migrations, and Frontend run independently on `ubuntu-24.04`;
  Browser E2E has explicit `needs` edges to all three and runs only after all
  succeed. The workflow is triggered by `pull_request`, pushes to `main`, and
  `workflow_dispatch`, and concurrent runs for the same pull request or ref
  cancel superseded work.
- **Least-privilege and supply-chain boundary:** workflow permissions are
  limited to `contents: read`, checkout does not persist credentials, and every
  third-party action is pinned to a full immutable commit SHA. Python CI
  dependencies are installed with hashes: Backend uses the dedicated full CI
  lock and Migrations uses the runtime lock. Frontend uses the committed npm
  lock through `npm ci`.
- **Credential and pull-request boundary:** current CI requires no GitHub
  Secrets. PostgreSQL, authentication, webhook, and browser identities use only
  synthetic CI-scoped values. The workflow uses `pull_request`, never
  `pull_request_target`, and references no repository or environment secret, so
  a fork pull request cannot receive a workflow secret. Current CI loads no real
  `.env`, never uses the development database, and makes no real Stripe request.
- **Browser isolation:** Browser E2E creates a unique Compose project, database,
  volume, loopback port, and runner-temporary files for each run. The tracked
  test-only fake payment provider sends a synthetic signed callback through the
  real webhook path, while the Stripe API key remains empty. The runner audits
  logs, removes Playwright output and temporary files, removes its containers
  and networks, and uploads no artifact containing test state or credentials.
- **Live failure evidence:** hosted GitHub acceptance completed a deliberate
  GREEN -> RED -> GREEN sequence. Both GREEN runs passed all four jobs and
  Playwright 8/8. The controlled RED made Frontend fail exactly as intended;
  Backend and Migrations remained successful, and the dependency graph blocked
  Browser E2E, which was skipped without running a step. Count-only audits
  found no real secret, credentialed DSN, JWT, Order capability, webhook
  secret, real Stripe endpoint, private key, or uploaded artifact. The
  temporary pull request, branch, and worktree were cleaned without merge, and
  `main` was preserved.
- **Responsive regression handling:** hosted Chromium exposed intrinsic card
  overflow on `/menu` and a mobile user-agent `dd` margin overflow on
  `/admin/users`. Production CSS now constrains the menu card track with
  `minmax(0, 1fr)` and resets `.cardDetails dd` to `margin: 0`. The strict
  Playwright overflow assertion was retained rather than weakened or given a
  product-specific exemption.
- **Branch protection:** `main` requires the exact four workflow checks with
  strict status checks enabled. Force pushes and branch deletion are disabled.
  Administrator enforcement is intentionally false at this stage, so
  repository administrators remain exempt from the protection rule; no ruleset
  adds an unexpected policy.
- **Consequences:** changes must satisfy the three independent quality jobs
  before isolated browser validation can run, and the protected branch requires
  all four successful contexts. CI remains synthetic and least-privilege; it
  does not approve a public deployment. Stage 20 later supplied repository-ready
  production configuration, ingress, secret-input, database-role separation,
  and release contracts. Actual infrastructure and managed-secret provisioning,
  controlled release, and public exposure remain Stage 22 work.

## D-077 — NOK-Only Administrator Menu Money Contract

- **Status:** accepted on 2026-08-27
- **Decision:** Nordic Hearth menu administration accepts only `NOK`. NOK has a
  fixed minor-unit scale of two. Administrator forms display and accept exact
  major-unit decimal strings, while the API and database continue to transport
  and persist integer minor-unit amounts.
- **Conversion boundary:** the frontend converts decimal strings by splitting
  whole and fractional components, padding to two fractional digits, and
  checking integer bounds before transport. It never uses floating-point
  multiplication, silent rounding, or `toFixed()` as the source of truth.
- **Enforcement:** Admin Menu create and update request validation accepts only
  exact `NOK`; omission on create retains the existing `NOK` default. No model,
  database constraint, migration, or public menu response change is required.
- **Consequences:** arbitrary multi-currency menu administration and a generic
  currency-scale framework are intentionally out of scope. Historical order,
  payment, analytics, and reporting currency contracts remain unchanged.

## D-078 — Repository-Ready Deployment Boundary and Immutable Release Contract

- **Status:** accepted on 2026-09-15
- **Decision:** Stage 20 completes Production Deployment Readiness in the
  repository only. Production settings fail closed, backend and frontend images
  are portable, runtime and migration database credentials remain separate, and
  the GHCR/Render release contract identifies the backend/migrator image by an
  immutable digest.
- **Migration boundary:** the long-running backend uses `DATABASE_URL` and
  performs only a read-only schema-head check. The one-shot migrator uses
  `MIGRATION_DATABASE_URL`, constrained role elevation, a session-level advisory
  lock, and exact-head verification.
- **Release boundary:** completing Stage 20 does not mean the manual release
  workflow was dispatched or that GHCR, Render, managed production secrets,
  production Stripe, a public URL, or production data were created. Release
  execution must remain fail-closed until its live-runtime proof is explicitly
  accepted.
- **Consequences:** Stage 22 owns infrastructure provisioning, the deterministic
  and resettable synthetic demo dataset, the first controlled online release,
  and public demo acceptance. The application becomes intentionally public to
  recruiters or a portfolio audience only after Stage 22-D passes.
- **Current applicability:** this decision remains historical acceptance of
  Stage 20 readiness and its security principles. D-080 operationally
  supersedes its paid Render/private-service/GHCR/cron deployment topology for
  the zero-base-cost portfolio demo; the historical decision is not deleted.

## D-079 — Provider-Neutral Portfolio Demo Persistence

- **Status:** accepted on 2026-09-19 with the AF1+B1-2 commit.
- **Decision:** migration
  `0009_add_portfolio_demo_origin_and_payment_provider` establishes
  `Order.data_origin` with exact values `live`, `portfolio_seed`, and
  `portfolio_runtime`, and `Payment.provider` with exact values
  `stripe_test` and `demo`. Persisted Payment Checkout fields are renamed
  to provider-neutral idempotency key, session ID, URL, and expiry fields.
  Provider-aware uniqueness and the existing at-most-one-pending and
  at-most-one-succeeded Payment per Order invariants remain enforced.
- **Success-time authority:** `Payment.succeeded_at` is required for a
  succeeded Payment and is the current analytics and payment/product-sales
  report time source. `StripeEvent` remains a Stripe-specific webhook audit
  and deduplication record, not the ongoing analytics time source. This
  supersedes the success-time source originally recorded in D-056 and D-058
  without rewriting their historical acceptance.
- **Migration safety:** existing Orders become `live` and existing Payments
  become `stripe_test`. The migration derives historical succeeded timestamps
  from the earliest authoritative transitioned Stripe success event and fails
  closed when evidence is absent. Downgrade cannot silently erase demo
  Payments. Stripe webhook transitions are provider-guarded and write
  `succeeded_at` atomically.
- **Boundary:** the existing Stripe test Checkout/webhook integration remains
  implemented and preserved. A public demo payment provider, seeded Orders,
  and runtime provenance assignment are later slices, not consequences of
  this migration alone. The repository head is 0009, while the local
  development database may remain at 0008 until separately authorized
  migration.

## D-080 — Zero-Cost Portfolio Demo Deployment Contract

- **Status:** accepted on 2026-09-22 with the AF1+B1-3 commit.
- **Decision:** the current repository target is exactly two Render Free
  services: a Static Site frontend and a Docker Web Service backend, with an
  external Neon PostgreSQL Free database. No Render database, private
  service, cron/migrator service, persistent disk, GHCR publish, or paid plan
  is part of the portfolio-demo target. Zero paid resources are a target,
  not an SLA or a promise of unlimited free usage.
- **Origins and runtime:** the Static Site API base uses Render-provided
  backend URL wiring. Backend public frontend/API origins and release identity
  derive from Render-provided values, with exact HTTPS origins, strict CORS,
  trusted-host derivation, direct browser-to-API calls, and DB-independent
  `/health` plus DB-aware `/ready`. There is no `/api/*` static proxy.
  The eventual demo Render configuration sets `PORTFOLIO_DEMO_MODE=true`
  and `PAYMENT_PROVIDER=demo` without Stripe secrets; the Static Site uses
  the bounded 90-second API timeout for Free-tier cold starts. These are
  repository settings, not evidence that demo payment or public hosting exists.
- **Migration boundary:** application runtime uses the Neon pooled URL.
  A separately authorized manual GitHub `workflow_dispatch` migration uses
  the direct Neon URL, the four required CI checks, exact current-`main`
  identity, the `MIGRATE_NEON_PRODUCTION` confirmation phrase, pinned actions,
  minimal read permissions, and a final remote-main recheck immediately
  before the runner. Only the migration step receives the direct-URL secret;
  the runner checks `roa_migrator`, `roa_owner`, and the exact 0009 head.
  The named `production-neon` GitHub Environment and secret require actual operator
  configuration and verification; repository text does not prove live rules.
- **Release boundary:** exact live-origin CSP remains deferred to public
  acceptance without a wildcard relaxation. The historical D-078 paid
  Render/GHCR topology is operationally superseded for this portfolio demo,
  but its fail-closed configuration, least-privilege migration, no hidden
  startup migration, and immutable-source principles remain. No public
  deployment, Neon migration, or cloud provisioning is claimed by this
  repository decision.

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

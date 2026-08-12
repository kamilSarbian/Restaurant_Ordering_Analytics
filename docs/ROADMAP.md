# Project Roadmap

## Delivery Rules

- One small stage is completed at a time.
- Before a stage is implemented, a plan covering files, decisions, risks, and
  tests is prepared.
- A stage is complete only after the specified verification has been run.
- The next stage requires user approval.
- Critical logic receives positive, negative, and boundary tests.

## 1. Repository Initialization

- **Status:** completed
- **Goal:** create a minimal repository skeleton and shared working rules.
- **Outcome:** Git, the `backend`, `frontend`, and `docs` directories, a basic
  README, `.gitignore`, and `.env.example` without secrets.
- **Dependencies:** approval of the repository layout and tools.
- **Completion criterion:** a new user understands the structure and environment
  requirements, and the repository does not track local files or secrets.
- **Test:** inspect the structure and `git status`, and search for accidentally
  stored secrets or environment artifacts.

## 2. FastAPI Foundation

- **Status:** completed
- **Goal:** run the smallest valid backend application.
- **Outcome:** application configuration, a `/health` router, settings handling,
  and basic API tests.
- **Dependencies:** Stage 1.
- **Completion criterion:** the application starts and the health check returns
  a stable, documented contract without exposing internal details.
- **Test:** a pytest test for `/health`, Ruff, a Black check, and application
  startup.

## 3. PostgreSQL and Alembic

- **Status:** completed
- **Goal:** prepare a secure database connection and schema versioning.
- **Outcome:** minimal Docker Compose running only PostgreSQL, SQLAlchemy
  configuration, a database session, Alembic, and the first non-destructive
  technical migration.
- **Dependencies:** Stage 2 and locally available Docker.
- **Completion criterion:** the migration can be applied to an empty database
  and rolled back in a test environment, PostgreSQL passes its health check,
  and configuration comes from environment variables.
- **Test:** start the minimal Compose stack, run the PostgreSQL health check,
  apply `upgrade`/`downgrade` on an isolated test database, and test the
  connection. This stage requires advance warning that Docker must be
  available.

## 4. Menu Models

- **Status:** completed
- **Goal:** model categories and menu items with data integrity.
- **Outcome:** category and product models, UUIDs, integer prices, currency,
  allergens, `is_active`, `is_available`, constraints, indexes, and a migration.
- **Dependencies:** Stage 3 and an approved ERD fragment.
- **Completion criterion:** the database rejects invalid prices and
  relationships, and a product can be disabled without deletion.
- **Test:** model and constraint tests and a migration from an empty database.

## 5. Data Seed

- **Status:** completed
- **Goal:** provide a controlled demonstration menu dataset.
- **Outcome:** an explicit, repeatable mechanism for seeding categories and
  products.
- **Dependencies:** Stage 4.
- **Completion criterion:** safe re-execution of the seed does not create
  duplicates or overwrite unrelated data.
- **Test:** run it twice on an empty test database and verify record counts and
  values.

## 6. Public Menu API

- **Status:** completed
- **Goal:** expose active categories and products to the customer.
- **Outcome:** `GET /api/v1/menu`, its `available_only` filter, and
  `GET /api/v1/menu/items/{item_id}` with strict typed response schemas and one
  non-public-record 404 contract.
- **Dependencies:** Stages 4–5.
- **Completion criterion:** inactive products are not public, availability is
  visible, and filtering and no-data states have a defined contract.
- **Test:** API tests for lists, filters, details, 404 responses, and hidden
  products.

## 7. Order Quoting

- **Status:** completed
- **Goal:** build pure, testable, server-authoritative order quote logic.
- **Outcome:** a transient quote endpoint accepting only menu item identifiers
  and quantities, with duplicate rejection, current database prices, active and
  available validation, one-currency enforcement, and integer totals.
- **Dependencies:** Stage 6.
- **Completion criterion:** client-supplied monetary data cannot affect the
  result, response order matches request order, and the calculation performs
  one SELECT, zero writes, and no persistence.
- **Test:** schema and PostgreSQL integration tests for limits, duplicates,
  server-owned names and prices, activity, availability, mixed currencies,
  error precedence, integer totals, price changes, one SELECT, zero DML, and
  the complete HTTP and OpenAPI contracts.

## 8. Order Creation

- **Status:** completed
- **Goal:** persist guest orders and historical snapshots.
- **Outcome:** table, order, item, and status-history models, a migration,
  dine-in/takeaway rules, `order_status` starting at `created`, a
  `public_order_number`, an access-token hash, and rate limiting for
  `POST /api/v1/orders`. The endpoint returns the raw token only at creation and
  creates neither a `Payment` nor a Stripe session. Public status retrieval
  requires the number and the `X-Order-Access-Token` header and returns only
  minimal data.
- **Dependencies:** Stage 7, accepted O-001, O-002, and O-003, and an approved
  ERD.
- **Completion criterion:** the order and all snapshots are created atomically,
  the token has at least 256 bits of randomness, only its SHA-256 hash exists in
  the database, an invalid table is rejected, menu changes do not alter
  history, and the pure cancellation policy accepts a future
  blocking-payment flag. Payment-aware database integration is deferred until
  Payment exists.
- **Test:** tests for transactionality, snapshots, table validation, both order
  types, initial `order_status = created`, token generation and hashing, the
  same error for an invalid number and token, absence of `Payment` creation,
  constraints, and exceeding the `POST /orders` limit. Pure domain tests cover
  cancellation of a `created` order with and without a blocking-payment flag.
  Tests that require real `Payment` records and transactional `Order -> Payment`
  locking remain in Stage 9 or the first stage that implements Payment.

## 9. Stripe Checkout

- **Status:** completed
- **Goal:** create a test payment session for the stored order amount.
- **Outcome:** an `Order 1:N Payment` relationship, partial unique indexes for
  one `pending` and one `succeeded` payment, a Stripe adapter, and a Checkout
  endpoint protected by `X-Order-Access-Token`, the `Idempotency-Key` header,
  and rate limiting. The endpoint identifies the order by
  `public_order_number`, creates `Payment(status=pending)`, creates a session for
  the amount from `Order`, stores the session identifier, and returns the URL.
- **Dependencies:** Stage 8, accepted O-002 and D-013, a Stripe test account,
  and environment variables.
- **Completion criterion:** the same `Order` and `Idempotency-Key` pair does not
  duplicate the attempt or session, the Stripe key is associated with
  `Payment`, and a new attempt is not created while `pending` or `succeeded`
  exists. An unambiguous failure may end the attempt as `failed`, while a
  timeout is retried using the same key and record. Every database phase locks
  `Order -> Payment`, but the transaction and lock do not include the Stripe
  call.
- **Test:** tests using a Stripe mock for success, a valid and invalid token, an
  idempotent retry, an unambiguous failure, an ambiguous timeout, partial
  indexes, a new attempt after `failed` or `expired`, prohibition of an attempt
  for `pending`/`succeeded`, and exceeding the checkout-session endpoint limit.
  Concurrency tests cover cancellation running in parallel with `Payment`
  creation and two parallel attempts to create `Payment`; the outcome cannot
  contain `order_status = cancelled` together with `Payment(status=pending)`.
  A test also confirms that no transaction remains open during the mocked
  Stripe call. Stripe keys require manual configuration.
- **Deferred Stage 8 verification:** implement D-016 and D-017 against real
  Payment records, including blocking cancellation for `pending` and
  `succeeded` attempts and enforcing the `Order -> Payment` lock protocol.
- **Verified outcome:** Stage 9 persists pending Payment attempts, may mark a
  definitive Checkout creation failure as failed, and creates or replays a
  hosted Checkout Session without holding a database transaction during the
  provider call. Provider-confirmed `succeeded` and `expired` transitions are
  deliberately deferred to Stage 10.

## 10. Stripe Webhook

- **Status:** completed
- **Goal:** confirm payment outcomes securely.
- **Outcome:** a raw webhook endpoint, signature verification, an event table,
  event ID uniqueness, payments, and transactional event handling.
- **Dependencies:** Stage 9, the webhook secret, and accepted decision O-001.
- **Completion criterion:** only a valid webhook may perform
  `pending -> succeeded`; the other terminal transitions are
  `pending -> failed` and `pending -> expired`. A duplicate does not repeat
  effects, and a terminal state does not return to `pending`. No auxiliary value
  on `Order` replaces a successful `Payment` record. The webhook locks `Order`,
  then the relevant `Payment`, and maintains a short transaction.
- **Test:** tests for a valid and invalid signature, a duplicate, rollback,
  redelivery, all three transitions, a forbidden reversal, and out-of-order
  events. Concurrency tests cover cancellation running in parallel with a
  `succeeded` webhook, two concurrent webhooks for the same event, and the
  impossibility of obtaining `order_status = cancelled` together with
  `Payment(status=succeeded)`.
- **Verified outcome:** Stage 10 stores durable StripeEvent receipts, verifies
  raw payloads through the official SDK, applies provider-authoritative Payment
  transitions atomically, preserves the first terminal result, and handles
  duplicate, Checkout Phase 3, and future cancellation races without deadlock.

## 11. Administrator Authentication

- **Status:** completed
- **Goal:** protect all internal features.
- **Outcome:** a minimal AdminUser model, explicit interactive administrator
  creation command, Argon2id password hashing, sign-in, short-lived JWT,
  `/auth/me`, reusable AdminBearer authorization, and sign-in rate limiting.
- **Dependencies:** Stage 3 and decisions about JWT lifetime and revocation.
- **Completion criterion:** there is no public registration, the password is
  neither stored nor logged in plain text, and a protected endpoint rejects a
  missing or invalid token. Sign-in enforces the configured request limit.
- **Test:** tests for successful and unsuccessful sign-in, password hashes, JWT
  expiration, authorization, and exceeding the sign-in limit.
- **Verified outcome:** Stage 11 persists normalized administrator identities,
  creates zero accounts through migration, supports race-safe interactive
  bootstrap, resists login enumeration, validates active database identity on
  every protected request, and leaves all public customer routes unauthenticated.

## 12. Administrator Panel — Operational API

- **Status:** completed
- **Goal:** expose secure order and menu management.
- **Outcome:** protected endpoints for lists, filters, details, status changes,
  menu editing, and availability.
- **Dependencies:** Stages 6, 8, and 10–11 and accepted decision O-001.
- **Completion criterion:** every operation requires an administrator, a
  forbidden transition or reversal is rejected, `created -> accepted` requires
  a related `Payment(status=succeeded)`, and `created -> cancelled` requires the
  absence of `pending` and `succeeded` attempts. The condition is checked
  transactionally without trusting the frontend, after locking `Order` and then
  `Payment`. `accepted -> cancelled` is forbidden, and every status change has
  a history entry.
- **Test:** tests for filters, pagination, authorization, every allowed and
  forbidden transition, cancellation without `Payment`, after `failed`, and
  after `expired`, an `active_payment_attempt` conflict for `pending`,
  prohibition of cancellation for `succeeded`, history, editing, and hiding a
  product used in history. A separate concurrency test runs cancellation in
  parallel with `Payment` creation and with a `succeeded` webhook. It confirms
  that an active Stripe attempt cannot coexist with an `order_status`
  transition to `cancelled` and that every path locks records in the
  `Order -> Payment` order.
- **Verified outcome:** Stage 12 provides authenticated order list, detail, and
  transactional status mutation plus category and menu-item list, create, and
  partial update operations. Payment-aware transitions, atomic history,
  normalized menu uniqueness, soft deactivation, public-menu behavior, and
  historical snapshots are verified without a model or migration change.

## 13. Analytics

- **Status:** completed and verified on 2026-08-11.
- **Goal:** calculate six basic KPIs directly from transactional data.
- **Outcome:** endpoints for collected revenue, succeeded orders count, average
  order value, sales by product, sales by category, and dine-in vs takeaway.
- **Dependencies:** Stages 8 and 10–12 and approved KPI definitions.
- **Completion criterion:** collected revenue sums successful payment amounts;
  succeeded orders count counts distinct successfully paid orders; average
  order value divides those values; product and category sales use `OrderItem`
  snapshots; dine-in vs takeaway groups count and value by `order_type`.
  Results use UTC in the database and `Europe/Oslo` for presentation.
- **Test:** a separate test for each KPI on a small dataset, including empty
  data, an unpaid order, multiple completed payment attempts, a successful
  payment, and local-date boundaries.
- **Verified outcome:** four protected administrator endpoints implement the
  six KPIs from qualified succeeded payments and historical item snapshots,
  with per-currency results, half-open UTC filtering, Europe/Oslo response
  metadata, and one set-based analytics SELECT per endpoint. No migration was
  required.

## 14. CSV Export

- **Status:** completed and verified on 2026-08-11.
- **Goal:** expose reporting data in a predictable format.
- **Outcome:** three protected MVP exports—orders, product sales, and
  payments—with filters, headers, and explicit encoding.
- **Dependencies:** Stage 13.
- **Completion criterion:** the export matches dashboard definitions and
  correctly handles commas, international characters, the time zone, and an
  empty result.
- **Test:** tests for CSV content and headers, escaping, filters, authorization,
  and totals consistent with a controlled dataset.
- **Verified outcome:** exactly three protected synchronous CSV routes expose
  orders, full historical product sales, and qualified succeeded payments with
  strict query, source-time, UTF-8-SIG, single-BOM, CRLF, deterministic
  filename, spreadsheet-safety, and exposure contracts. Each performs one
  report SELECT after authentication, with no persistence or migration.

## 15. Customer Frontend

- **Status:** completed and verified on 2026-08-12.
- **Goal:** deliver a responsive flow from menu to order status.
- **Outcome:** menu, filters, cart, order-type and table selection, quoting,
  Checkout, return screen, and secure status retrieval.
- **Dependencies:** stable APIs from Stages 6–10.
- **Completion criterion:** every screen handles loading, empty, error, and
  success states, forms are validated, and the view works on mobile devices.
- **Test:** component and API integration tests, a TypeScript build, and a
  manual responsive scenario that does not treat the success URL as payment
  confirmation.
- **Verified outcome:** the guest-only React application implements the menu,
  local filters, session cart, server-authoritative quote, non-idempotent order
  creation safeguards, idempotent hosted Checkout, neutral return screens, and
  protected fulfilment polling. The complete frontend automated suite, lint,
  format check, build, dependency audits, and contract/security scans pass.
  Manual visual acceptance passed at 375x812, 768x1024, and 1280x800 for the
  complete customer flow from menu through order status, including keyboard,
  focus, touch-target, overflow, neutral-return, and non-color-only semantics.

## 16. Administrator Frontend

- **Goal:** provide staff with a simple operational panel and dashboard.
- **Outcome:** sign-in, protected routes, order list and detail, status changes,
  menu management, charts, and CSV downloads.
- **Dependencies:** Stages 11–14 and the frontend foundation from Stage 15.
- **Completion criterion:** an unauthenticated user cannot access the panel, API
  errors are clear, and key actions require deliberate confirmation.
- **Test:** routing and view tests, session expiration, API errors, a build, and
  manual mobile and desktop verification.

## 17. Full-System Docker

- **Goal:** provide repeatable local startup of the entire system.
- **Outcome:** extension of the minimal Compose configuration from Stage 3 with
  backend and frontend images, health checks, volumes, and documented
  environment variables.
- **Dependencies:** working applications, migrations, and frontend from
  Stages 1–16.
- **Completion criterion:** a new person can start the entire system by
  following the README, migrations are controlled, and secrets do not enter
  images or the repository.
- **Test:** clean Compose build and startup, PostgreSQL, backend, and frontend
  health checks, migration, and a critical API and UI smoke test.

## 18. End-to-End Test

- **Goal:** verify the critical flow across the entire system.
- **Outcome:** an automated menu → cart → order → Checkout → mock/test webhook →
  panel → status scenario and a negative scenario.
- **Dependencies:** Stages 15–17 and a stable Compose environment.
- **Completion criterion:** the test is deterministic, isolates data, and
  detects regression in the most important business path.
- **Test:** run the complete E2E suite at least twice on clean data and run the
  full backend/frontend suite in Compose.

## 19. CI

- **Goal:** automatically block quality and functional regressions.
- **Outcome:** GitHub Actions for linting, formatting, backend tests,
  migrations, type checking, and frontend builds.
- **Dependencies:** stable local commands and Stage 18.
- **Completion criterion:** the pipeline runs on a clean runner, does not use
  real Stripe secrets, and fails after a deliberately introduced regression.
- **Test:** a successful full workflow run and a controlled failure attempt on
  a working branch.

## 20. Deployment

- **Goal:** make a secure demo version available.
- **Outcome:** frontend, backend, and PostgreSQL on approved services, HTTPS,
  restricted CORS, migrations, test-mode Stripe, and basic error monitoring.
- **Dependencies:** Stage 19, hosting accounts, domains/URLs, and environment
  secrets.
- **Completion criterion:** the demo works over HTTPS, production URLs are
  correct, the webhook is verified, and deployment instructions make the setup
  reproducible.
- **Test:** deployment smoke test, test payment and webhook, administrator
  sign-in, CSV, and a CORS check. This stage requires manual configuration of
  services and secrets.

## 21. Portfolio Documentation

- **Goal:** prepare the project for independent review by a recruiter.
- **Outcome:** current README, ERD, diagrams, and descriptions of security, API,
  tests, Stripe, deployment, decisions, limitations, and sample screens.
- **Dependencies:** completed and verified MVP.
- **Completion criterion:** the documentation does not promise unimplemented
  features, includes demonstration instructions, and supports explanation of
  the most important decisions.
- **Test:** follow the instructions from a fresh clone and review links,
  diagrams, commands, and documentation consistency with actual behavior.

## Next Recommended Stage

Stage 1 through Stage 15 have been completed and verified. Stage 15 preserves
the original goal to deliver a responsive flow from menu to order status and
passed both automated validation and the mandatory responsive manual scenario.

The next recommended stage is **Stage 16 — Administrator Frontend**. Stage 16
has not started and requires separate user approval.

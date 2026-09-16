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
- **Historical outcome at Stage 11 completion:** a minimal AdminUser model,
  explicit interactive administrator creation command, Argon2id password
  hashing, sign-in, short-lived JWT, `/auth/me`, reusable AdminBearer
  authorization, and sign-in rate limiting.
- **Dependencies:** Stage 3 and decisions about JWT lifetime and revocation.
- **Completion criterion:** there is no public registration, the password is
  neither stored nor logged in plain text, and a protected endpoint rejects a
  missing or invalid token. Sign-in enforces the configured request limit.
- **Test:** tests for successful and unsuccessful sign-in, password hashes, JWT
  expiration, authorization, and exceeding the sign-in limit.
- **Historical verified outcome:** Stage 11 persisted normalized administrator
  identities, created zero accounts through migration, supported race-safe
  interactive bootstrap, resisted login enumeration, validated active database
  identity on every protected request, and left all public customer routes
  unauthenticated. Stage 16G later removed the `AdminUser`, `AdminBearer`, and
  dedicated backend administrator-auth compatibility from the current runtime.

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

- **Status:** Stage 16F and Stage 16G are complete and committed. Stage 16G-C2
  completed its independent review, security sign-off, and final commit on
  2026-08-20.
- **Goal:** provide staff with a simple operational panel and dashboard.
- **Outcome:** sign-in, protected routes, order list and detail, status changes,
  menu management, charts, and CSV downloads.
- **Dependencies:** Stages 11–14 and the frontend foundation from Stage 15.
- **Completion criterion:** an unauthenticated user cannot access the panel, API
  errors are clear, and key actions require deliberate confirmation.
- **Test:** routing and view tests, session expiration, API errors, a build, and
  manual mobile and desktop verification.

### 16B-1 — Admin Authentication and Protected Shell

- **Status:** implemented on 2026-08-12.
- **Outcome:** dedicated administrator login, versioned current-tab session,
  `/me` validation, route guard, and responsive AdminShell.

### 16B-2 — Admin Order Reads

- **Status:** implemented on 2026-08-12.
- **Outcome:** filtered paginated order list and safe snapshot, history, and
  Payment-summary detail views.

### 16B-3 — Admin Order Status Mutations

- **Status:** implemented on 2026-08-12.
- **Outcome:** explicit confirmed backend-authoritative fulfilment actions with
  refetch and ambiguity refresh gates.

### 16B-3A — Architecture Sources-of-Truth Addendum

- **Status:** completed on 2026-08-12.
- **Outcome:** D-061 and D-062 record the accepted unified User, exact roles,
  anonymous guest boundary, landing/auth direction, nullable Order ownership,
  own-order history, and super-admin role-management plan. This is documentation
  only; at that historical boundary the AdminUser and guest-ordering behavior
  remained implemented.

### 16B-4 — Admin Menu

- **Status:** implemented on 2026-08-12.
- **Outcome:** responsive category and menu-item management using the existing
  administrator operational API and deliberate mutation confirmation.

### 16B-5 — Admin Analytics

- **Status:** implemented on 2026-08-12.
- **Outcome:** responsive views for the four protected analytics contracts and
  their six established metrics without changing backend definitions.

### 16B-6 — Admin CSV Exports

- **Status:** implemented on 2026-08-12, including the shared Blob transport.
- **Outcome:** deliberate downloads for the three existing protected CSV
  reports with clear range, filter, loading, and failure states.

### 16C — Stage 16 Administrator Frontend Acceptance and Review

- **Status:** completed and committed on 2026-08-12; user-performed manual
  responsive QA passed at all required viewports.
- **Outcome:** full frontend regression, responsive and accessibility QA,
  documentation audit, independent review, and the final Stage 16 commit gate
  for the administrator screens.

### 16D — Unified User, Authentication, and Role Authorization Backend

- **Status:** completed and committed on 2026-08-12.
- **Historical outcome at the Stage 16D boundary:** AdminUser was evolved into
  the unified User model with constrained role; canonical register/login/me,
  database-backed current-user/admin/super-admin authorization, secure
  first-super-admin bootstrap, minimum role API, auth configuration transition,
  and temporary administrator consumer compatibility were implemented. Stage
  16G later removed that backend compatibility from the current runtime.
- **Migration boundary:** this stage established migration 0007 while the
  development database deliberately remained at 0006. Stage 16E later advanced
  repository and Alembic head to 0008. Stage 16F ENV1 then backed up and safely
  upgraded the development database through 0007 to 0008 while preserving the
  historical administrator as an active `super_admin`.

### 16E — Order Ownership and Customer Account API

- **Status:** completed, independently reviewed, and committed on 2026-08-13.
- **Outcome:** nullable Order ownership through migration 0008, exact optional
  canonical-auth semantics for creation, owner-or-capability public status and
  Checkout, current-User own-order list/detail, privacy-safe DTOs, and
  concurrency/security hardening while preserving anonymous guest ordering and
  the independent Order capability.
- **Completed slices:** E1 ownership model/migration, E2 optional-auth creation,
  E3 owner-or-capability status/Checkout, E4 account reads, E5 hardening,
  E5-FIX1 deterministic frontend Date tests, C1 documentation/full pre-commit
  validation, and C2 independent review/final commit.
- **Historical frontend boundary:** at Stage 16E completion, production customer
  and administrator frontend source was unchanged. Landing, unified customer
  auth/account UI, authenticated ordering UX, and administrator User-management
  UI were implemented later in Stage 16F.

### 16F — Landing, Unified Authentication Frontend, Customer Account, and Super-Admin User Management

- **Status:** completed, independently reviewed, and committed on 2026-08-14.
- **Outcome:** the concise landing page, public menu at `/menu`, unified
  `/login` and `/register`, shared AuthContext, mixed guest/authenticated Order
  flows, `/account` and own-order UI, super-admin-only `/admin/users`, migration
  of the administrator frontend to unified auth, and a transitional
  `/admin/login` redirect are implemented.
- **Completed slices:** F1 shared canonical auth/session and administrator auth
  migration; F2 landing, menu, registration, and navigation; F3 authenticated
  ordering, status, and Checkout; F4 personal account Order UI; F5 super-admin
  User governance; F6 cumulative hardening; FIX1 long-email wrapping; FIX2
  deterministic Login/Register back navigation; ENV1 controlled development
  database upgrade; and C1 documentation and cumulative validation.
- **Validation state:** C1 passed the 780-test targeted and 890-test full
  frontend suites, the 273-test targeted and 1584-test full backend suites,
  backend/frontend quality gates, dependency audits, and isolated Alembic
  round-trip/no-drift validation. Repository, Alembic, and the development
  database are at
  `0008_add_order_ownership`. The automated browser environment was unavailable,
  and accepted developer/user local-browser QA, including the final FIX2
  recheck, passed.
- **Commit state:** Stage 16F-C2 completed the independent review and final
  commit. At that historical boundary, Stage 16G and Stage 17 had not started.

### 16G — Integrated Security, Regression, Documentation, and Final Review

- **Status:** completed and committed on 2026-08-20; independent review and
  security sign-off are complete. Stage 16G-1, security-remediated Stage 16G-2,
  Stage 16G-4, C1, and C2 are complete; Stage 16G-3 was not required.
- **Outcome:** the backend runtime now uses only unified `User` authentication,
  the `user_access` token family, the `UserBearer` OpenAPI scheme, and canonical
  `AUTH_JWT_SECRET` and `AUTH_ACCESS_TOKEN_EXPIRE_MINUTES` configuration. The
  legacy backend administrator-auth endpoints, token family, scheme,
  configuration aliases, token service, and `AdminUser` runtime alias are
  removed. The accepted client-side `/admin/login` redirect and old session-key
  migration remain transitional frontend compatibility and do not restore
  backend legacy authentication.
- **Integrated acceptance:** guest capability, authenticated ownership,
  personal account privacy, customer/admin reconciliation with the same
  canonical token, operational administrator authorization, and super-admin
  User governance passed against an isolated temporary PostgreSQL database.
  Exact local target and OID guards protected cleanup; the isolated database
  was removed and the development database fingerprint remained unchanged.
  Acceptance used in-process ASGI/TestClient, not browser E2E; the optional
  Stage 16G-4 browser smoke was skipped.
- **Validation state:** the high-risk backend suite passed 686 tests in 19
  files, the full backend suite passed 1587 tests, and the frontend suite passed
  890 tests in 31 files. Backend and frontend quality gates, dependency audits,
  the single `0008_add_order_ownership` Alembic head, and eight migration
  round-trip/no-drift tests passed. A local credential hygiene issue was
  remediated without recording a credential or DSN.
- **Final gate:** Stage 16G-C2 completed independent review, security sign-off,
  and the final commit. Stage 17 work followed this committed boundary.

## 17. Full-System Docker

- **Status:** completed, independently reviewed, and committed on 2026-08-22.
  Stage 17-1 through Stage 17-5, C1 documentation and cumulative pre-commit
  validation, and C2 independent review and final commit are complete.
- **Goal:** provide repeatable local startup of the entire system.
- **Outcome:** a production-only backend image, static Nginx frontend image,
  same-origin proxy, four-service Compose stack, explicit migration boundary,
  readiness and startup gating, persistent PostgreSQL volume, and documented
  environment variables.
- **Topology:** Browser -> frontend Nginx on container port 8080 -> private
  backend on port 8000 -> PostgreSQL on container port 5432. The exact services
  are `postgres`, one-shot `migrate`, `backend`, and `frontend`. Frontend is the
  sole application ingress at `127.0.0.1:5173`; PostgreSQL is loopback-only at
  `127.0.0.1:5433`; backend and migrate publish no host ports. Separate app and
  data networks prevent frontend-to-database access.
- **Runtime boundary:** Nginx serves the SPA, preserves deep links, and proxies
  `/api` on the same origin without wildcard CORS. Backend runs one Uvicorn
  worker. Backend, migrate, and frontend run non-root with read-only root
  filesystems, writable tmpfs, `cap_drop: ALL`, and `no-new-privileges`.
- **Migration and readiness:** migrate remains the explicit one-shot
  `python -m alembic upgrade head`. Backend performs read-only
  `python -m alembic current --check-heads` before Uvicorn. `/health` remains
  process liveness, `/ready` performs a lightweight `SELECT 1`, and frontend
  exposes `/healthz`. Startup is PostgreSQL healthy -> migrate success ->
  backend head check and readiness -> frontend. No seed, bootstrap, reset,
  downgrade, or application-lifespan migration runs at startup.
- **Dependencies:** working applications, migrations, and frontend from
  Stages 1–16.
- **Completion criterion:** a new person can start the full local system by
  following the README, migrations remain explicit and controlled, secrets do
  not enter images or the repository, and isolated acceptance preserves the
  development environment.
- **Test:** clean isolated image builds and Compose startup; PostgreSQL,
  migration, backend readiness, and frontend health gates; critical API and SPA
  smoke; regression, dependency, security, topology, persistence, shutdown, and
  development-environment preservation checks.
- **Completed slices:** Stage 17-1 backend runtime, Stage 17-2 static frontend
  and same-origin proxy, Stage 17-3 Compose topology, Stage 17-4 readiness and
  startup gating, and Stage 17-5 isolated Docker acceptance.
- **Acceptance evidence:** a unique isolated Compose project used separate
  synthetic environment values, loopback ports, networks, and volume. Two
  explicit migrations and the managed startup migration all ended at revision
  `0008_add_order_ownership`. Canonical register/login/me, legacy-auth 404s, the
  X-Forwarded-For spoof negative test, restart persistence, hardening, and
  secret/image/log audits passed. Programmatic frontend-only HTTP smoke verified
  SPA deep links, API JSON routing, and non-SPA unknown API responses. Browser
  automation was unavailable, so this is not a browser E2E claim.
- **Shutdown and safety:** acceptance containers and networks were removed with
  `docker compose down` without `-v`; the detached Stage 17 acceptance volume
  remains intentionally retained. The real `.env`, host PostgreSQL on port
  5432 and PID 6120, healthy development PostgreSQL on port 5433, development
  named volume, and exact development database fingerprint remained unchanged.
- **Validation state:** backend and frontend images built successfully. The
  backend suite passed 1590 tests, the frontend suite passed 890 tests, all
  language and dependency gates passed, Alembic exposes one
  `0008_add_order_ownership` head, and eight migration round-trip/no-drift tests
  passed.
- **Historical C1/C2 gate:** C1 changed exactly six authoritative documents;
  the cumulative Stage 17 union was exactly 17 physical paths,
  `A6 / M11 / D0`, with an empty index. All C1 gates passed, and C2 completed
  independent review and the final commit.
- **Historical deployment boundary:** Stage 17 defines a loopback-only local
  container contract, not a public deployment. At that stage boundary, HTTPS,
  public ingress, managed production secrets, and least-privilege production
  database roles remained future work. Stage 20 subsequently completed the
  repository-side readiness contracts; infrastructure provisioning and public
  exposure remain Stage 22 work.

## 18. End-to-End Test

- **Status:** completed, independently reviewed, and committed at
  `a1999f9ce22d92876c38a71e24ad9ff8c43075d2`. Stage 18-1 through Stage 18-5,
  C1 documentation and cumulative pre-commit validation, the C2-FIX1 test
  stabilization, C2 independent review, and the final commit are complete.
- **Goal:** verify the critical flow across the entire system.
- **Outcome:** deterministic real-Chromium coverage for landing and deep links,
  authentication and logout, protected routes, account ownership and privacy,
  guest ordering, fake Checkout and payment confirmation, administrator order
  lifecycle, `customer -> admin` User role promotion, super-admin RBAC, and
  responsive, keyboard, focus, and runtime-error behavior.
- **Dependencies:** Stages 15–17 and a stable Compose environment.
- **Framework and execution:** Playwright Test 1.62.1 with Chromium is the sole
  browser-E2E framework. Configuration fixes `workers=1` and `retries=0`.
  Trace, video, HAR, and `storageState` capture are disabled; screenshots are
  failure-only. The required proof uses Playwright-driven real Chromium. The
  unavailable in-app browser is not claimed, and there is no Axe, Cypress,
  second E2E framework, cross-browser claim, or real Stripe traffic.
- **Isolation:** every run uses a unique Compose project, PostgreSQL database,
  and named volume with synthetic credentials. Disposable E2E data never uses
  the development database, and the real `.env` and development stack remain
  outside the run.
- **Fake payment boundary:** the test-only `backend/e2e_harness.py` returns only
  an opaque fake Checkout handle to the browser. A process-local registry keeps
  trusted Checkout and payment facts, including amount, status, and internal
  identifiers. The normal application contract keeps the Order capability in
  the browser, but fake completion accepts only the opaque handle and neither
  accepts nor uses that capability. The synthetic webhook secret is separate
  server configuration and is never browser-supplied or exposed. A signed
  synthetic webhook traverses the real webhook endpoint. The harness performs
  no Stripe request and creates no production E2E backdoor.
- **Completed slices:** Stage 18-1 Playwright and isolated Compose tooling;
  Stage 18-2 authentication, account, privacy, and protected routes; Stage 18-3
  guest ordering, payment, webhook, administrator lifecycle,
  `customer -> admin` User role promotion, and RBAC; Stage 18-4 responsive,
  accessibility, and runtime-failure coverage; and Stage 18-5 two-run final
  acceptance.
- **Acceptance evidence:** two fresh isolated Stage 18-5 runs each passed the
  complete Playwright suite, 8/8, with zero unexpected console errors, page
  errors, or failed network responses. Coverage includes unpaid-order denial,
  successful signed-webhook payment, lifecycle completion, cross-user 404
  privacy, and responsive keyboard/focus behavior. Both successful runs left no
  browser artifacts or temporary environment file.
- **Cumulative gates:** the backend passed 1654/1654 tests, Ruff, Black, and
  isort. The frontend passed 890/890 tests, ESLint, Prettier, and the production
  build. Both npm audits reported zero vulnerabilities. Alembic has the single
  `0008_add_order_ownership` head, and migration round-trip/no-drift passed 8/8.
- **Environment and retention:** the real `.env` remained byte-identical; host
  PostgreSQL on port 5432 and PID 6120, healthy development PostgreSQL on port
  5433, its named volume, and the development database fingerprint remained
  unchanged. No acceptance container or network is running. Seven detached
  Stage 17/18 acceptance volumes remain intentionally retained because deletion
  requires separate explicit approval.
- **Artifact and secret policy:** synthetic credentials and secrets, JWTs,
  capabilities, DSNs, webhook secrets, and trusted payment state must not be
  logged or persisted. Retained acceptance volumes must not be deleted without
  explicit approval.
- **Historical C1/C2 gate:** C1 changed exactly six authoritative documents.
  Including the one-file C2-FIX1 stabilization, the cumulative Stage 18 union
  was exactly 22 physical paths, `A10 / M12 / D0`, with an empty index. C2
  completed independent review and the final commit at the hash recorded
  above.

## 19. CI

- **Status:** complete, independently reviewed, and committed at
  `ad637053e2fb4979cf1bf5f5cc8c3a7f95317079`. Stage 19-1 through Stage 19-4,
  live `GREEN -> RED -> GREEN` acceptance, `main` branch protection, Stage 19-C1,
  and Stage 19-C2 are complete.
- **Goal:** automatically block quality and functional regressions.
- **Outcome:** one GitHub Actions workflow on `ubuntu-24.04` exposes exactly
  four jobs and required checks: `Backend`, `Migrations`, `Frontend`, and
  `Browser E2E`. The first three jobs are independent; `Browser E2E` depends on
  all three. The workflow runs for pull requests, pushes to `main`, and manual
  dispatch, with concurrency cancellation for superseded runs.
- **Security and reproducibility:** workflow permissions are limited to
  `contents: read`; third-party actions use immutable full-commit SHA pins;
  Python CI dependencies are hash-locked; and all PostgreSQL, authentication,
  and webhook values are synthetic and CI-only. The workflow requires no
  GitHub Secrets, real Stripe traffic, or real `.env` file, and it uses
  `pull_request` rather than `pull_request_target`.
- **Dependencies:** stable local commands and Stage 18.
- **Completion criterion:** the pipeline runs on a clean runner, does not use
  real Stripe secrets, and fails after a deliberately introduced regression.
- **Test:** a successful full workflow run and a controlled failure attempt on
  a working branch.
- **Completed slices:** Stage 19-1 CI foundation and backend job; Stage 19-2
  migrations and frontend jobs; Stage 19-3 isolated Docker-backed Browser E2E
  job; and Stage 19-4 live GitHub Actions acceptance.
- **Live acceptance:** the first GREEN run passed all four jobs and Playwright
  8/8. A temporary, one-assertion controlled RED made `Frontend` fail exactly
  as intended, caused `Browser E2E` to be skipped through its dependency gate,
  and left `Backend` and `Migrations` independent. After the assertion was
  reverted, the second GREEN run passed all four jobs and Playwright 8/8.
  Count-only log and artifact audits found no real secret or credentialed DSN
  exposure and no uploaded artifact. The temporary pull request, branch, and
  worktree were removed without merge, and the `main` commit was preserved.
- **Hosted responsive fixes:** hosted Chromium exposed intrinsic card-grid
  overflow on `/menu` and the user-agent `<dd>` margin overflowing mobile
  `/admin/users`. Production CSS now constrains the menu card grid with
  `minmax(0, 1fr)` and resets `.cardDetails dd` to `margin: 0`. The strict
  Playwright overflow assertion was retained rather than weakened.
- **Branch protection:** after live acceptance, `main` was configured to require
  exactly `Backend`, `Migrations`, `Frontend`, and `Browser E2E`, with strict
  status checks enabled. Administrator enforcement is intentionally disabled at
  this stage; force pushes and branch deletion remain disabled.
- **Historical C1/C2 gate:** C1 touched exactly six authoritative documents.
  The cumulative Stage 19 union was exactly 12 physical paths, `A3 / M9 / D0`,
  with an empty index. C2 completed independent review and the final commit at
  the hash recorded above.

## 20. Production Deployment Readiness

- **Status:** complete at the repository, security, and release-contract level;
  not deployed.
- **Goal:** prepare a fail-closed, reproducible production target without
  provisioning or exposing live infrastructure.
- **Outcome:** production configuration and trusted-origin contracts, portable
  backend and Nginx frontend images, isolated runtime and migration database
  roles, and an immutable GHCR/Render release blueprint are implemented and
  locally verified. The manual release workflow has not been dispatched, and
  no Render or GHCR cloud mutation, production Stripe use, public URL, or public
  deployment is claimed.
- **Boundary:** infrastructure provisioning, managed production secrets, the
  first controlled online release, and public acceptance belong to Stage 22.

## 21. UI/UX Redesign & Product Polish

- **Status:** complete locally; not publicly deployed.
- **Goal:** deliver the Nordic Hearth customer and administrator experience with
  responsive, accessible, secure, and performant interactions.
- **Outcome:** Nordic Hearth brand integration, customer and administrator
  redesigns, responsive/accessibility hardening, route-level code splitting,
  motion and feedback polish, and final visual/pre-deployment acceptance are
  complete. Acceptance passed 1,073/1,073 frontend tests and 23/23 synthetic
  production-preview Playwright scenarios, and no JavaScript chunk exceeds
  500 kB.

## 22. Production Deployment & Public Acceptance

- **Status:** not started.
- **Goal:** provision, release, and accept a safe public demo using the Stage 20
  target architecture and the accepted Stage 21 product.

### 22-A — Infrastructure Provisioning

Provision the approved production infrastructure, managed secrets, trusted
public origins, and least-privilege database roles without enabling production
Stripe.

### 22-B — Demo Mode & Synthetic Production Dataset

Provide a separate demo administrator, preferably an ordinary `admin` rather
than `super_admin`, with safe read-only or resettable behavior. Use a
deterministic synthetic dataset covering approximately 90 days and targeting
approximately 500–1,000 realistic orders, payments, cancellations, weekdays,
and hours. It must contain no real PII and must have a deterministic reset/import
strategy.

### 22-C — First Controlled Online Release

Execute the first explicitly authorized immutable-image release, migration,
health, and smoke-test sequence against the provisioned environment.

### 22-D — Public Demo Acceptance

Complete public security, functional, responsive, accessibility, and
operational acceptance. A recruiter/portfolio URL may exist and be advertised
only after this slice passes.

## 23. Portfolio Documentation & Case Study

- **Status:** not started.
- **Goal:** produce the final recruiter-facing README, case study, screenshots,
  architecture presentation, and CV-facing material after Stage 22-D
  acceptance.
- **Boundary:** current reconciliation keeps repository documentation truthful;
  it is not the Stage 23 portfolio deliverable.

## Next Recommended Stage

Stages 1 through 19 are complete and committed. At the 2026-09-15
documentation-reconciliation boundary, Stage 20 Production Deployment Readiness
and Stage 21 UI/UX Redesign & Product Polish were complete locally and awaited
the renewed pre-commit independent review and logical commit-plan confirmation.
Neither stage claims a live deployment or public URL.

Stage 22 Production Deployment & Public Acceptance and Stage 23 Portfolio
Documentation & Case Study have not started. At that reconciliation boundary,
the immediate repository gate was the renewed pre-commit review. After a
separately authorized commit and deployment decision, the next implementation
slice is Stage 22-A Infrastructure Provisioning.

Repository, Alembic, and the development database remain at
`0008_add_order_ownership`.

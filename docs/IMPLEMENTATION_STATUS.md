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
- **Current stage:** Stage 18 is complete and committed at
  `a1999f9ce22d92876c38a71e24ad9ff8c43075d2`. Stage 19-1 through Stage 19-4,
  including live `GREEN -> RED -> GREEN` GitHub Actions acceptance and `main`
  branch protection, are complete but uncommitted during Stage 19-C1. Stage
  19-C2 has not started.
- **Backend:** FastAPI, database foundation, menu models, local seed data,
  public menu, transient quoting, persistent order creation, and secure public
  order status, Payment persistence, Stripe Checkout, and verified Stripe
  webhook processing, unified User authentication and role authorization,
  nullable Order ownership, mixed guest/authenticated Order access, strict
  personal account Order reads,
  administrator order and menu operational APIs, administrator analytics,
  administrator CSV reports, and super-admin User governance completed
- **Frontend:** landing and public menu routes, unified authentication and
  registration, mixed guest/authenticated ordering, personal account Order
  history and detail, super-admin User governance, and the existing
  administrator operational interface are implemented and acceptance-verified
- **Container runtime:** the production-only backend image, static Nginx
  frontend image and same-origin proxy, four-service Compose stack, readiness
  and migration startup gates, isolated full-stack acceptance, and isolated
  browser-E2E Compose overlay are complete
- **Database:** PostgreSQL, Alembic, menu, order, Payment, StripeEvent, and User
  models and deterministic menu seed completed; repository and development
  database are both at `0008_add_order_ownership`. The controlled ENV1 upgrade
  preserved the historical administrator as an active `super_admin`
- **Seed data:** completed and verified
- **Public menu API:** list, availability filter, item details, and 404 contract
  completed and verified
- **Menu write API:** administrator category and item list, create, partial
  update, activity, availability, and reassignment completed and verified
- **Order quoting:** completed and verified
- **Order creation:** guest or optional canonical User ownership completed and
  verified; every Order retains an independent guest capability
- **Public order status:** owner-or-capability access completed and verified
- **RestaurantTable foundation:** completed; provisioning and administration
  workflow not started
- **Payment persistence:** completed and verified
- **Stripe Checkout:** owner-or-capability access completed and verified using
  the official SDK boundary and fake-provider automated tests
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
- **Unified User persistence and constrained roles:** completed and verified;
  the temporary `AdminUser` runtime alias has been removed
- **Argon2id password hashing:** completed and verified through pwdlib
- **Unified authentication:** canonical `/api/v1/auth/register`,
  `/api/v1/auth/login`, and `/api/v1/auth/me`; the single `user_access` HS256
  token family; the single `UserBearer` OpenAPI scheme; canonical
  `AUTH_JWT_SECRET` and `AUTH_ACCESS_TOKEN_EXPIRE_MINUTES` runtime
  configuration; and database-authoritative role and active-state checks
  completed and verified. The legacy backend administrator auth routes and
  runtime aliases are intentionally absent
- **Role authorization:** reusable current-user, admin, and super-admin
  dependencies plus super-admin-only User list and ordinary role transition API
  completed and verified
- **Authentication limiters:** canonical login limiter and separate
  registration limiter completed and verified
- **Super-admin bootstrap CLI:** explicit interactive Argon2id bootstrap with a
  PostgreSQL advisory lock completed and verified; no development identity was
  created by migration or automated tests
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
- **Application tests:** the current Stage 19 baseline passed 1654 backend
  tests and 890 frontend tests. Backend Ruff, Black, and isort checks; browser
  E2E type checking; frontend ESLint, Prettier, build; and both dependency
  audits passed. Each live GREEN workflow passed all four jobs, including the
  complete eight-test Playwright suite. Alembic exposes the single
  `0008_add_order_ownership` head, and migration round-trip/no-drift passed 8/8
- **Stage 16 frontend:** the committed B1 through B6 operational administrator
  interface remains complete. Stage 16F F1 through F6 plus FIX1 and FIX2 add
  the landing route, shared auth, registration, authenticated ordering,
  personal account, and super-admin User-management UI; automated acceptance
  and developer/user manual responsive QA are complete
- **Stage 16D:** committed on 2026-08-12
- **Stage 16E:** committed on 2026-08-13
- **Stage 16F:** committed on 2026-08-14
- **Stage 16D backend:** committed. At the historical Stage 16D commit boundary,
  D1 through D5 implemented unified User persistence, migration 0007, public
  registration/login/me, compatibility auth aliases, database-backed RBAC,
  secure super-admin bootstrap, role management, and canonical AUTH
  configuration. Stage 16G later removed the backend compatibility aliases
- **Stage 16D-1:** complete
- **Stage 16D-2:** complete
- **Stage 16D-3:** complete
- **Stage 16D-4:** complete
- **Stage 16D-5:** complete
- **Stage 16E-1:** complete — nullable Order ownership and migration 0008
- **Stage 16E-2:** complete — optional canonical authentication on creation
- **Stage 16E-3:** complete — owner-or-capability status and Checkout
- **Stage 16E-4:** complete — strict read-only personal account Order API
- **Stage 16E-5:** complete — security and concurrency hardening
- **Stage 16E-5-FIX1:** complete — deterministic Date-only frontend tests;
  production frontend source unchanged
- **Stage 16E-C1:** complete; documentation and pre-commit validation passed
- **Stage 16E-C2:** complete; Stage 16E was independently reviewed and committed
  on 2026-08-13
- **Stage 16F-1:** complete — shared canonical AuthContext, session transition,
  and administrator frontend auth migration
- **Stage 16F-2:** complete — landing page, `/menu`, unified login/register
  routes, and deterministic navigation
- **Stage 16F-3:** complete — authenticated Order creation, status, and Checkout
  without silent guest downgrade
- **Stage 16F-4:** complete — personal account list/detail and shared safe Order
  status presentation
- **Stage 16F-5:** complete — super-admin-only User list and ordinary role
  governance UI with authoritative reconciliation
- **Stage 16F-6:** complete — cumulative security, accessibility, responsive,
  and acceptance hardening
- **Stage 16F-6-FIX1:** complete — long authenticated Landing and Admin Users
  confirmation emails wrap safely
- **Stage 16F-6-FIX2:** complete — Login and Register provide a deterministic
  secondary `← Back to home` link
- **Stage 16F-6-ENV1:** complete — the development database was backed up
  outside the repository and upgraded through 0007 to 0008 while preserving the
  historical active `super_admin`
- **Stage 16F manual QA:** complete — the automated browser environment was
  unavailable, and the developer/user completed the required local-browser QA,
  including the final FIX2 recheck
- **Stage 16F-C1:** complete — documentation and cumulative pre-commit
  validation passed
- **Stage 16F-C2:** complete — Stage 16F was independently reviewed and
  committed on 2026-08-14
- **Stage 16G-1:** complete — canonical authentication compatibility cleanup
- **Stage 16G-2:** complete — isolated integrated acceptance;
  security-remediated
- **Stage 16G-3:** not required
- **Stage 16G-4:** FINAL ACCEPTANCE COMPLETE
- **Stage 16G-C1:** complete — documentation and pre-commit validation passed
- **Stage 16G-C2:** complete — independent review, security sign-off, and final
  commit completed on 2026-08-20
- **Overall Stage 16G:** complete and committed; security sign-off is complete
- **Stage 17-1:** complete — reproducible production-only backend image and
  hash-locked runtime dependencies
- **Stage 17-2:** complete — static non-root Nginx frontend image and
  same-origin backend proxy
- **Stage 17-3:** complete — four-service Compose topology with isolated app
  and data networks
- **Stage 17-4:** complete — database readiness and deterministic migration,
  head-check, backend-health, and frontend-health startup gating
- **Stage 17-5:** complete — isolated full-stack Docker acceptance
- **Stage 17-C1:** complete — documentation and cumulative pre-commit
  validation passed
- **Stage 17-C2:** complete — independent review and final commit completed on
  2026-08-22
- **Overall Stage 17:** complete and committed
- **Stage 18-1:** complete — Playwright Test 1.62.1, Chromium, deterministic
  single-worker configuration, and isolated E2E Compose tooling
- **Stage 18-2:** complete — authentication, account ownership, privacy, and
  protected-route browser E2E
- **Stage 18-3:** complete — guest order, fake Checkout, signed webhook,
  administrator lifecycle, and RBAC browser E2E
- **Stage 18-4:** complete — responsive, keyboard, focus, and runtime-failure
  browser E2E
- **Stage 18-5:** FINAL ACCEPTANCE COMPLETE — two fresh isolated runs passed
  the complete Playwright suite, 8/8 in each run
- **Stage 18-C1:** complete — documentation and cumulative pre-commit
  validation passed
- **Stage 18-C2:** complete — independent review and final commit completed at
  `a1999f9ce22d92876c38a71e24ad9ff8c43075d2`
- **Overall Stage 18:** complete and committed
- **Stage 19-1:** complete — CI foundation and independent Backend job
- **Stage 19-2:** complete — independent Migrations and Frontend jobs
- **Stage 19-3:** complete — dependency-gated, isolated Docker Browser E2E job
- **Stage 19-4:** complete — live `GREEN -> RED -> GREEN` GitHub Actions
  acceptance, responsive production fixes, and `main` branch protection
- **Stage 19-C1:** in progress — exactly six authoritative documents and
  cumulative pre-commit validation
- **Stage 19-C2:** not started
- **Overall Stage 19:** implementation and live acceptance are complete but
  uncommitted before C2
- **Remaining direction:** finish every Stage 19-C1 gate, then run Stage 19-C2
  independent review and final commit
- **Deployment (Stage 20):** not started
- **Portfolio documentation (Stage 21):** not started

## Known limitations

- The backend exposes health, public menu and quote endpoints, mixed guest or
  authenticated ordering and payment flows, secure public status and personal
  account reads, authenticated administrator operations and reports, and
  super-admin User governance. The unified customer and administrator frontend
  is completed and acceptance-verified.
- Unified authentication has no refresh, logout, revocation, password
  reset/change, or MFA. Its limiter is per process and resets on restart.
- Repository migration 0008 is implemented and verified. During Stage 16F ENV1,
  the development database was backed up outside the repository and upgraded
  through the approved `0006 -> 0007 -> 0008` path. The historical
  administrator remains an active `super_admin`; current Compose binds project
  PostgreSQL at `127.0.0.1:5433` to container port 5432, and the separate host
  PostgreSQL service on port 5432 was not modified.
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
- A real Stripe CLI smoke remains optional and manual. Automated tests use
  injected adapters or the test-only fake provider and synthetic signed
  webhooks; Stage 18 performs no real Stripe traffic.
- The seed is restricted to the exact local development database and is not a
  production bootstrap process.
- Stage 17 provides a repeatable loopback-only local container stack, not a
  public deployment. HTTPS, a public ingress boundary, managed secrets, and a
  least-privilege production database role remain Stage 20 deployment work; the
  current local database role is accepted only for the loopback Stage 17 scope.
- Stage 17 acceptance used programmatic SPA and API HTTP smoke, not browser E2E.
  Stage 18 now supplies the required browser proof through Playwright Test
  1.62.1 and real Chromium only. The in-app browser was unavailable and is not
  claimed; Axe, Cypress, cross-browser coverage, and any second E2E framework
  are outside the implemented scope.
- Unified User persistence, customer registration/authentication, role
  management, Order ownership, read-only own-order API and frontend, and
  `/admin/users` UI are implemented. Refresh tokens, password recovery, MFA,
  and refunds have not started. Continuous integration is implemented and live
  acceptance-verified. Deployment and portfolio documentation have not started.

## Last verification

Stage 19-1 through Stage 19-4 completed by 2026-08-24. Stage 19 is complete but
uncommitted during C1, and Stage 19-C2 has not started:

- The GitHub Actions workflow runs on `ubuntu-24.04` for pull requests, pushes
  to `main`, and manual dispatch. Concurrency cancels superseded runs, and
  workflow permissions are limited to `contents: read`
- The exact job and required-check names are `Backend`, `Migrations`,
  `Frontend`, and `Browser E2E`. The first three jobs are independent;
  `Browser E2E` declares all three in `needs` and runs only after their success
- Third-party actions use immutable full-commit SHA pins. Python CI dependencies
  are hash-locked, and the workflow uses only synthetic CI-specific PostgreSQL,
  authentication, and webhook values. It requires no GitHub Secrets, real
  Stripe traffic, or real `.env` file; it uses `pull_request`, never
  `pull_request_target`
- Live GREEN #1 passed all four jobs, including Playwright 8/8. The controlled
  RED made `Frontend` fail exactly as intended, `Browser E2E` was skipped by its
  dependency gate, and `Backend` and `Migrations` remained independent. After
  the one-assertion regression was reverted, live GREEN #2 passed all four jobs,
  including Playwright 8/8
- The temporary acceptance pull request, branch, and worktree were cleaned
  without merge. Count-only log and artifact audits found no real secret or
  credentialed DSN exposure and no uploaded artifact, and `main` remained at
  the committed Stage 18 hash
  `a1999f9ce22d92876c38a71e24ad9ff8c43075d2` throughout acceptance
- Hosted Chromium exposed intrinsic grid overflow in `/menu` cards and the user
  agent `<dd>` margin overflowing `/admin/users` at the mobile viewport.
  `MenuPage.module.css` now constrains the card grid with
  `grid-template-columns: minmax(0, 1fr)`, and `AdminUsersPage.module.css`
  applies `.cardDetails dd { margin: 0; }`. The strict Playwright overflow
  assertion remains strict; production CSS was fixed instead of weakening the
  test
- After live acceptance, `main` branch protection was configured to require
  exactly `Backend`, `Migrations`, `Frontend`, and `Browser E2E`, with strict
  status checks enabled. Administrator enforcement is intentionally disabled at
  this stage; force pushes and branch deletion are disabled
- The backend baseline remains 1654/1654 tests plus Ruff, Black, and isort. The
  frontend baseline remains 890/890 tests plus browser E2E type checking,
  ESLint, Prettier, the production build, and zero vulnerabilities in both npm
  audits. Alembic has the single `0008_add_order_ownership` head, and migration
  round-trip/no-drift passed 8/8
- C1 touches exactly six authoritative documents. The cumulative post-C1 Stage
  19 union is exactly 12 physical paths, `A3 / M9 / D0`, with an empty index.
  Stage 19 remains uncommitted, and Stage 19-C2 has not started
- The real `.env`, host and development PostgreSQL instances, development
  database fingerprint, and retained acceptance volumes remain unchanged. No
  acceptance container or network is running. Stage 20 deployment and Stage 21
  portfolio documentation have not started; there is no public deployment
  claim

Historical Stage 18 verification completed by 2026-08-23. Stage 18-C2 then
completed independent review and the final commit at
`a1999f9ce22d92876c38a71e24ad9ff8c43075d2`:

- Stage 18 uses Playwright Test 1.62.1 with real Chromium as its sole browser
  E2E framework. The deterministic configuration uses `workers=1`,
  `retries=0`, no trace, video, HAR, or `storageState`, and screenshots only on
  failure
- Every run uses a unique isolated Compose project, PostgreSQL database, and
  named volume with synthetic credentials. Disposable browser-E2E data never
  targets the development database, and the real `.env` is not loaded or
  modified
- The test-only `backend/e2e_harness.py` supplies an opaque fake Checkout
  handle to the browser. A process-local registry retains the trusted Checkout
  and payment facts, including amount, status, and internal identifiers. The
  normal application contract keeps the Order capability in the browser, but
  fake completion accepts only the opaque handle and neither accepts nor uses
  that capability. The synthetic webhook secret is separate server
  configuration and is never browser-supplied or exposed. The harness signs a
  synthetic webhook, sends it through the real webhook endpoint, makes no real
  Stripe request, and adds no production E2E backdoor
- Stage 18-2 verified landing, navigation and deep links, unified
  authentication and logout, protected routes, account ownership, and
  cross-user privacy. Stage 18-3 verified guest ordering, fake Checkout, signed
  webhook payment success, unpaid-order denial, the administrator lifecycle to
  completion, `customer -> admin` User role promotion, and super-admin RBAC.
  Stage 18-4 verified the required responsive viewports plus keyboard and focus
  behavior
- Stage 18-5 ran the complete suite twice on two fresh isolated stacks. Run A
  passed 8/8 and Run B passed 8/8, with zero unexpected console errors, page
  errors, or failed network responses. The required proof is Playwright-driven
  Chromium; the unavailable in-app browser is not claimed, and no Axe, Cypress,
  second E2E framework, or real Stripe was used
- Trace, video, HAR, and `storageState` capture remained disabled, screenshots
  remained failure-only, and both successful runs left no browser artifact or
  temporary environment file. Synthetic secrets, credentials, JWTs,
  capabilities, DSNs, and webhook secrets were neither logged nor persisted
- The backend passed 1654/1654 tests plus Ruff, Black, and isort. The frontend
  passed 890/890 tests plus ESLint, Prettier, and the production build. Both
  `npm audit --omit=dev` and the full `npm audit` reported zero
  vulnerabilities. Alembic exposed the single `0008_add_order_ownership` head,
  and the migration round-trip/no-drift suite passed 8/8
- Read-only before/after checks preserved the real `.env` byte-for-byte, host
  PostgreSQL on port 5432 and PID 6120, healthy development PostgreSQL on port
  5433, the development named volume, and the exact development fingerprint:
  revision 0008, one User with roles `0/0/1`, five categories, 15 menu items,
  two orders, two order items, and zero Payment or StripeEvent rows
- No acceptance container or network remains running. Seven detached Stage
  17/18 acceptance volumes are retained intentionally because their deletion
  requires separate explicit approval; C1 does not delete them
- Stage 18-C1 changed exactly six authoritative documents. After those updates
  and the one-file C2-FIX1 stabilization, the cumulative Stage 18 union is
  exactly 22 physical paths, `A10 / M12 / D0`, with an empty index. Stage 18-C2
  subsequently completed independent review and the final commit

Historical Stage 17 verification completed on 2026-08-22; Stage 17-C2 then
completed independent review and the final commit:

- Stage 17-1 created the non-root Python 3.12 backend image with a
  production-only, hash-locked dependency set and one Uvicorn worker. Stage
  17-2 created the non-root static Nginx image, same-origin `/api` proxy, SPA
  deep-link fallback, and `/healthz`; no dev server or wildcard CORS is present
- Stage 17-3 created exactly four services: `postgres`, one-shot `migrate`,
  private `backend`, and sole-ingress `frontend`. The frontend binds only
  `127.0.0.1:5173 -> 8080`, PostgreSQL binds only
  `127.0.0.1:5433 -> 5432`, and backend and migrate publish no host ports. App
  and data networks are separated, and the persistent PostgreSQL volume remains
  explicit
- Backend, migrate, and frontend use non-root runtimes with read-only root
  filesystems, writable tmpfs mounts, `cap_drop: ALL`, and
  `no-new-privileges`. Startup performs no seed, bootstrap, reset, downgrade, or
  implicit application-lifespan migration
- Stage 17-4 preserved `/health` as process liveness, added `/ready` as a safe
  `SELECT 1` database readiness boundary, retained the explicit one-shot
  `alembic upgrade head`, and added a read-only
  `alembic current --check-heads` before Uvicorn. The startup chain is
  PostgreSQL healthy -> migration success -> backend head check and readiness
  -> frontend startup and `/healthz`
- The current regression baseline is 1590/1590 backend tests and 890/890
  frontend tests. Backend and frontend quality gates and dependency audits
  passed. Alembic has one `0008_add_order_ownership` head, and all eight
  migration round-trip/no-drift tests passed
- Stage 17-5 used a unique isolated Compose project with separate synthetic
  environment values, loopback ports, networks, and volume. The real `.env`,
  development project, and development database were not acceptance targets
- Two explicit isolated migration runs and the managed startup migration all
  completed at revision 0008. Canonical register, login, and `/me`, legacy-auth
  404s, the X-Forwarded-For spoof negative test, restart persistence, container
  hardening, and secret, image, history, environment, and log audits passed
- Programmatic HTTP acceptance through the frontend verified `/`, `/menu`, and
  `/login` SPA/deep-link behavior, `/healthz`, API JSON routing, and non-SPA
  unknown API responses. Browser automation was unavailable, so this evidence
  is not a browser E2E claim; at that Stage 17 boundary, Stage 18 had not
  started
- Shutdown used `docker compose down` without `-v`. Acceptance containers and
  networks were removed, while the detached Stage 17 acceptance volume was
  retained intentionally
- Read-only before/after checks preserved host PostgreSQL on port 5432 and PID
  6120, healthy development PostgreSQL on port 5433, the development named
  volume, the real `.env`, and the exact development fingerprint: revision
  0008, one User with roles `0/0/1`, five categories, 15 menu items, two orders,
  two order items, and zero payments
- At the historical C1 boundary, Stage 17 changed exactly six authoritative
  documents and the cumulative union was exactly 17 physical paths,
  `A6 / M11 / D0`, with an empty index. All C1 gates subsequently passed, and
  Stage 17-C2 completed independent review and the final commit on 2026-08-22

Stage 16G final security sign-off and commit completed on 2026-08-20:

- Stage 16G-1 removed the legacy backend administrator-auth compatibility.
  Runtime authentication is canonical-only: `User`, `user_access`,
  `UserBearer`, `AUTH_JWT_SECRET`, and
  `AUTH_ACCESS_TOKEN_EXPIRE_MINUTES`
- The high-risk backend suite passed 686 tests in 19 files, the full backend
  suite passed 1587 tests, and the frontend suite passed 890 tests in 31 files.
  Backend and frontend quality gates, dependency audits, the single 0008 head,
  and eight migration round-trip/no-drift tests passed
- Security-remediated isolated acceptance verified the unified identity and role
  boundaries. The development database fingerprint and local PostgreSQL
  environments remained unchanged, and the local credential hygiene issue was
  remediated without recording a credential or DSN
- Stage 16G-C2 completed independent review, security sign-off, and the final
  commit. Stage 17 work followed that committed boundary

Historical Stage 16F-C1 documentation and cumulative pre-commit validation
completed on 2026-08-14:

- Stage 16F slices F1 through F6 plus FIX1, FIX2, and ENV1: complete in exactly
  74 physical paths and 119 cumulative slice-counted paths before C1
- C1 documentation scope: exactly six source-of-truth files; final Stage 16F
  scope is exactly 80 physical paths and 125 cumulative slice-counted paths
- Landing and `/menu`, unified authentication and registration, shared session
  handling, mixed guest/authenticated ordering, personal account Order reads,
  and super-admin User governance: implemented
- Frontend C1 targeted suite: 780 passed in 25 files. Full suite: 890 passed in
  31 files. ESLint, Prettier check, TypeScript/Vite build, and both npm audits
  passed; the accepted approximately 502 kB chunk warning remains
- Backend C1 targeted suite: 273 passed. Full suite: 1584 passed with the single
  accepted Starlette TestClient/httpx deprecation warning. Ruff, Black check,
  and isort check passed; no backend source changed
- Alembic exposes the single `0008_add_order_ownership` head. The isolated
  round-trip and no-drift suite passed 8 tests
- Repository, Alembic, and development database head:
  `0008_add_order_ownership`. ENV1 backed up the development database outside
  the repository, upgraded it through 0007 to 0008, preserved the historical
  administrator as an active `super_admin`, and did not modify host PostgreSQL
  on port 5432
- The automated browser environment was unavailable. Developer/user manual
  local-browser QA, including the final FIX2 recheck, passed and is the accepted
  manual evidence; no manual QA blocker remains
- Git whitespace validation passed. Stage 16F-C2 has not started; Stage 16G and
  Stage 17 have not started

Historical Stage 16E-C1 documentation and pre-commit validation on 2026-08-13:

- Stage 16E slices E1 through E5 plus FIX1: implemented in exactly 30 physical
  paths and 34 cumulative slice-counted paths before C1
- C1 documentation scope: exactly six source-of-truth files; Stage 16E physical
  scope becomes 36 paths and cumulative slice count becomes 40
- Nullable Order ownership, mixed guest/canonical creation, owner-or-capability
  status and Checkout, strict personal account reads, privacy boundaries, and
  security/concurrency hardening: implemented
- Backend full suite: 1584 passed with one accepted Starlette deprecation
  warning; Ruff, Black, isort, Alembic single head, migration round-trip,
  no-drift, OpenAPI, scope, and security checks: PASS
- Frontend full suite: 485 passed; ESLint, Prettier check, TypeScript/Vite build,
  production audit, and full audit: PASS. Stage 16E changed only two test files
  to freeze Date deterministically; production frontend source is unchanged
- Repository and Alembic head: `0008_add_order_ownership`; development DB:
  deliberately remains at `0006_create_admin_user_model` pending a separately
  approved `0006 -> 0007 -> 0008` operation
- Stage 16E-C2 has not started; Stages 16F, 16G, and 17 have not started

Historical Stage 16D-C1 documentation and pre-commit validation on 2026-08-12:

- Stage 16D slices D1 through D5: implemented in 38 physical paths and 55
  cumulative slice-counted paths before C1
- C1 documentation scope: exactly six source-of-truth files; Stage 16D physical
  scope becomes 44 paths and cumulative slice count becomes 61
- Unified User migration, public register/login/me, administrator compatibility,
  database-authoritative admin/super-admin RBAC, secure bootstrap, User list and
  role mutation, and AUTH configuration transition: implemented
- Backend full suite: 1522 passed; Ruff, Black, isort, Alembic head, migration
  round-trip, database safety, repository scope, and security checks: PASS
- Repository and Alembic head: `0007_unify_user_auth_roles`; development DB:
  deliberately remains at `0006_create_admin_user_model`
- Stage 16E, 16F, and 16G have not started; Stage 17 has not started

Historical Stage 16C-1 documentation and automated acceptance audit on
2026-08-12:

- Stage 16B-1 through B6 administrator frontend implementation: complete
- Dedicated admin auth/session, order reads and explicit mutations, menu
  management, analytics, and three secure CSV downloads: implemented
- Frontend full suite: 485 passed; ESLint, Prettier check, TypeScript/Vite build,
  and both npm audits: PASS before documentation-only C1 updates
- User-performed manual administrator responsive QA at 375x812, 768x1024, and
  1280x800, covering login, AdminShell/navigation, orders, order detail/actions,
  menu, analytics, exports, and keyboard/focus behavior: PASS
- At the Stage 16C boundary, the accepted target recorded anonymous guest ordering, unified User roles
  `customer`/`admin`/`super_admin`, database-authoritative role checks, secure
  super-admin bootstrap, nullable Order ownership, own-order history, landing
  and unified-auth routes, and isolated frontend transports: documented only
- At that historical boundary, runtime remained the separate AdminUser backend
  plus anonymous guest ordering; Stage 16D had not started
- Stage 16C cumulative scope was exactly 50 unique paths, including six
  documentation paths

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
- Stage 16 Administrator Frontend was not started at the Stage 15 verification
  boundary; the current Stage 16 progress is recorded above

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

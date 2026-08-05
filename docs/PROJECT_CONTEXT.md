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

1. The frontend retrieves active categories and available menu items.
2. The customer filters the menu and builds a cart in the browser.
3. The cart stores product identifiers and quantities. The price displayed in
   the interface is informational and is not authoritative for the backend.

### 4.2. Quoting and Order Creation

1. The frontend submits product identifiers, quantities, the order type, and a
   table number when required.
2. The backend retrieves products from the database, verifies that they are
   active and available, and calculates every amount.
3. The backend creates an order with `order_status = created`, stores an
   immutable snapshot of each item, and generates a `public_order_number` and a
   random `order_access_token`.
4. The raw token is returned to the customer only in the order creation
   response. The backend stores only its SHA-256 hash.
5. Creating an order does not create a `Payment` record and does not
   communicate with Stripe.

### 4.3. Stripe Payment

1. The customer calls a separate Checkout endpoint with the
   `public_order_number`, the `X-Order-Access-Token` header, and the
   `Idempotency-Key` header.
2. The backend ensures that no `pending` or `succeeded` attempt exists, creates
   a new `Payment(status=pending)`, and uses the amount stored on `Order`.
3. The backend creates a test Stripe Checkout Session using a Stripe key that
   is stably associated with the `Payment` attempt identifier, stores the
   session identifier, and returns the Checkout URL.
4. The same `Order` and `Idempotency-Key` pair cannot create another `Payment`
   record or another Stripe session.
5. After an unambiguous failure before session creation, the attempt may
   transition to `failed`. After an ambiguous timeout, a retry uses the same key
   and the same attempt.
6. The customer proceeds to the hosted Stripe page. Returning to the success
   page does not change the payment state.
7. Stripe sends a webhook whose signature is verified by the backend.
8. A previously unprocessed event is stored and handled idempotently in a
   database transaction.
9. Only a valid webhook may change the payment attempt status from `pending` to
   `succeeded` and confirm payment.
10. An unsuccessful or expired attempt transitions to `failed` or `expired`,
    respectively. Retrying payment creates a new attempt record with status
    `pending`.

### 4.4. Order Fulfilment

1. The administrator sees the order and the independent outcomes of its
   payment attempts.
2. The administrator may change `order_status` from `created` to `accepted`
   only when a related `Payment(status=succeeded)` exists.
3. `created -> cancelled` is possible only when no related
   `Payment(status=pending)` or `Payment(status=succeeded)` exists.
4. An active `pending` attempt blocks cancellation with the provisional domain
   conflict `active_payment_attempt`, because a later Stripe webhook may still
   confirm payment. The customer or administrator must wait for the attempt to
   finish.
5. `failed`, `expired`, and the absence of `Payment` records do not block
   cancellation. After `failed` or `expired`, the user may cancel the order or
   create a new payment attempt.
6. After successful payment, the order cannot be cancelled in the MVP because
   doing so would require a refund process.
7. Every status change is recorded in the history.
8. The customer may read a minimal status view by providing the
   `public_order_number` and the `X-Order-Access-Token` header.

### 4.5. Analytics and Reports

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
- A future `refund_status` remains a separate lifecycle.

### 7.5. Security and Privacy

- The administrator uses a securely hashed password and JWT; there is no public
  administrator registration.
- Administrator access is verified by the backend.
- Secrets exist only in environment variables.
- CORS is restricted to known origins.
- Sign-in, order creation, and Stripe session creation are rate-limited.
- Logs do not contain passwords, tokens, keys, or card data.
- The public order view reveals only necessary information and requires the
  `public_order_number` and the `X-Order-Access-Token` header.
- `order_access_token` has at least 256 bits of randomness, is returned in raw
  form only during order creation, and only its SHA-256 hash exists in the
  database. Token comparison must be secure.
- Public status contains only `public_order_number`, `order_status`, a payment
  summary without Stripe identifiers, `order_type`, `created_at`, `updated_at`,
  and an estimated or completed timestamp when one exists.
- Public status does not expose an email address, internal UUIDs, Stripe
  identifiers, or administrator data. An invalid number and an invalid token
  return the same generic error.
- Financial operations and critical changes are performed transactionally.

## 8. Expected Portfolio Value

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

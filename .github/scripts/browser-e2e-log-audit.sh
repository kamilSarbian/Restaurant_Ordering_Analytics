#!/usr/bin/env bash

# This helper is sourced by the canonical Browser E2E harness. It reports only
# closed identifiers so a failed audit cannot echo the sensitive log content.

browser_e2e_log_audit_phase_is_valid() {
  case "$1" in
    NORMAL_RUNTIME | ADMIN_DEMO_CUSTOMER_DISABLED | CUSTOMER_DEMO_ENABLED_FINAL)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

browser_e2e_log_audit_report_match() {
  local phase="$1"
  local rule="$2"
  local legacy_marker="$3"

  printf 'E2E_LOG_AUDIT_MATCH phase=%s rule=%s\n' "$phase" "$rule" >&2
  printf '%s\n' "$legacy_marker" >&2
}

browser_e2e_log_audit_report_scan_failure() {
  local phase="$1"
  local rule="$2"

  printf 'E2E_LOG_AUDIT_SCAN_FAILED phase=%s rule=%s\n' "$phase" "$rule" >&2
}

browser_e2e_log_audit_fixed_value() {
  local phase="$1"
  local log_file="$2"
  local value="$3"
  local status

  if [[ -z "$value" ]]; then
    browser_e2e_log_audit_report_scan_failure "$phase" "PROTECTED_VALUE_INPUT"
    return 1
  fi
  if grep -Fq -- "$value" "$log_file"; then
    browser_e2e_log_audit_report_match \
      "$phase" \
      "PROTECTED_VALUE" \
      "E2E_LOG_VALUE_LEAK_DETECTED"
    return 1
  else
    status=$?
  fi
  if ((status == 1)); then
    return 0
  fi
  browser_e2e_log_audit_report_scan_failure "$phase" "PROTECTED_VALUE"
  return 1
}

browser_e2e_log_audit_regex() {
  local phase="$1"
  local log_file="$2"
  local rule="$3"
  local pattern="$4"
  local status

  if grep -Eiq -- "$pattern" "$log_file"; then
    browser_e2e_log_audit_report_match \
      "$phase" \
      "$rule" \
      "E2E_LOG_SECURITY_PATTERN_DETECTED"
    return 1
  else
    status=$?
  fi
  if ((status == 1)); then
    return 0
  fi
  browser_e2e_log_audit_report_scan_failure "$phase" "$rule"
  return 1
}

browser_e2e_log_audit_http_service() {
  local line="$1"
  local line_prefix

  if [[ "$line" != *"|"* ]]; then
    BROWSER_E2E_HTTP_SERVICE="UNKNOWN_SERVICE"
    return 0
  fi
  line_prefix="${line%%|*}"
  local normalized_prefix="${line_prefix,,}"

  case "$normalized_prefix" in
    *backend*) BROWSER_E2E_HTTP_SERVICE="BACKEND" ;;
    *frontend*) BROWSER_E2E_HTTP_SERVICE="FRONTEND" ;;
    *postgres*) BROWSER_E2E_HTTP_SERVICE="POSTGRESQL" ;;
    *migrate*) BROWSER_E2E_HTTP_SERVICE="MIGRATIONS" ;;
    *) BROWSER_E2E_HTTP_SERVICE="UNKNOWN_SERVICE" ;;
  esac
}

browser_e2e_log_audit_http_route() {
  local request_target="$1"
  local request_path="${request_target%%\?*}"

  request_path="${request_path%%\#*}"
  case "$request_path" in
    /api/v1/admin/exchange-rates | /api/v1/admin/exchange-rates/*)
      BROWSER_E2E_HTTP_ROUTE="EXCHANGE_RATES"
      ;;
    /api/v1/admin/analytics | /api/v1/admin/analytics/*)
      BROWSER_E2E_HTTP_ROUTE="ADMIN_ANALYTICS"
      ;;
    /api/v1/admin/exports | /api/v1/admin/exports/*)
      BROWSER_E2E_HTTP_ROUTE="ADMIN_EXPORTS"
      ;;
    /api/v1/admin/orders | /api/v1/admin/orders/*)
      BROWSER_E2E_HTTP_ROUTE="ADMIN_ORDERS"
      ;;
    /api/v1/admin/menu | /api/v1/admin/menu/*)
      BROWSER_E2E_HTTP_ROUTE="ADMIN_MENU"
      ;;
    /api/v1/admin/users | /api/v1/admin/users/*)
      BROWSER_E2E_HTTP_ROUTE="ADMIN_USERS"
      ;;
    /api/v1/auth | /api/v1/auth/*)
      BROWSER_E2E_HTTP_ROUTE="AUTH"
      ;;
    /api/v1/account/orders | /api/v1/account/orders/*)
      BROWSER_E2E_HTTP_ROUTE="ACCOUNT_ORDERS"
      ;;
    /api/v1/e2e/fake-checkout | /api/v1/e2e/fake-checkout/*)
      BROWSER_E2E_HTTP_ROUTE="E2E_CHECKOUT"
      ;;
    /api/v1/orders/quote)
      BROWSER_E2E_HTTP_ROUTE="ORDER_QUOTE"
      ;;
    /api/v1/orders/*/checkout-session)
      BROWSER_E2E_HTTP_ROUTE="CHECKOUT"
      ;;
    /api/v1/orders | /api/v1/orders/*)
      BROWSER_E2E_HTTP_ROUTE="ORDERS"
      ;;
    /api/v1/menu | /api/v1/menu/*)
      BROWSER_E2E_HTTP_ROUTE="PUBLIC_MENU"
      ;;
    /api/v1/stripe | /api/v1/stripe/*)
      BROWSER_E2E_HTTP_ROUTE="STRIPE_WEBHOOK"
      ;;
    /health)
      BROWSER_E2E_HTTP_ROUTE="HEALTH"
      ;;
    /ready)
      BROWSER_E2E_HTTP_ROUTE="READINESS"
      ;;
    /healthz)
      BROWSER_E2E_HTTP_ROUTE="FRONTEND_HEALTH"
      ;;
    /assets/* | /images/*)
      BROWSER_E2E_HTTP_ROUTE="STATIC_ASSET"
      ;;
    / | /account | /account/* | /admin | /admin/* | /cart | /checkout | \
      /login | /menu | /orders/* | /register)
      BROWSER_E2E_HTTP_ROUTE="FRONTEND_ROUTE"
      ;;
    *) BROWSER_E2E_HTTP_ROUTE="UNKNOWN_ROUTE" ;;
  esac
}

browser_e2e_log_audit_http_service_is_valid() {
  case "$1" in
    BACKEND | FRONTEND | MIGRATIONS | POSTGRESQL | UNKNOWN_SERVICE) return 0 ;;
    *) return 1 ;;
  esac
}

browser_e2e_log_audit_http_route_is_valid() {
  case "$1" in
    ACCOUNT_ORDERS | ADMIN_ANALYTICS | ADMIN_EXPORTS | ADMIN_MENU | \
      ADMIN_ORDERS | ADMIN_USERS | AUTH | CHECKOUT | E2E_CHECKOUT | \
      EXCHANGE_RATES | FRONTEND_HEALTH | FRONTEND_ROUTE | HEALTH | ORDERS | \
      ORDER_QUOTE | PUBLIC_MENU | READINESS | STATIC_ASSET | STRIPE_WEBHOOK | \
      UNKNOWN_ROUTE)
      return 0
      ;;
    *) return 1 ;;
  esac
}

browser_e2e_log_audit_http_5xx() {
  local phase="$1"
  local log_file="$2"
  local pattern='"[^"]* HTTP/[0-9.]+"[[:space:]]+5[0-9]{2}([[:space:]]|$)'
  local request_pattern='"[A-Z]+[[:space:]]+([^"[:space:]]+)[[:space:]]+HTTP/[0-9.]+"[[:space:]]+5[0-9]{2}([[:space:]]|$)'
  local line
  local status

  if grep -Eiq -- "$pattern" "$log_file"; then
    BROWSER_E2E_HTTP_SERVICE="UNKNOWN_SERVICE"
    BROWSER_E2E_HTTP_ROUTE="UNKNOWN_ROUTE"
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ $pattern ]]; then
        browser_e2e_log_audit_http_service "$line"
        if [[ "$line" =~ $request_pattern ]]; then
          browser_e2e_log_audit_http_route "${BASH_REMATCH[1]}"
        fi
        break
      fi
    done <"$log_file"
    if ! browser_e2e_log_audit_http_service_is_valid "$BROWSER_E2E_HTTP_SERVICE"; then
      BROWSER_E2E_HTTP_SERVICE="UNKNOWN_SERVICE"
    fi
    if ! browser_e2e_log_audit_http_route_is_valid "$BROWSER_E2E_HTTP_ROUTE"; then
      BROWSER_E2E_HTTP_ROUTE="UNKNOWN_ROUTE"
    fi
    printf 'E2E_LOG_AUDIT_MATCH phase=%s rule=HTTP_5XX service=%s route=%s\n' \
      "$phase" \
      "$BROWSER_E2E_HTTP_SERVICE" \
      "$BROWSER_E2E_HTTP_ROUTE" >&2
    printf '%s\n' 'E2E_LOG_SECURITY_PATTERN_DETECTED' >&2
    return 1
  else
    status=$?
  fi
  if ((status == 1)); then
    return 0
  fi
  browser_e2e_log_audit_report_scan_failure "$phase" "HTTP_5XX"
  return 1
}

browser_e2e_audit_log_file() {
  local phase="$1"
  local log_file="$2"
  local value

  shift 2
  if ! browser_e2e_log_audit_phase_is_valid "$phase"; then
    browser_e2e_log_audit_report_scan_failure "UNKNOWN" "PHASE"
    return 1
  fi
  if [[ ! -f "$log_file" || -L "$log_file" ]]; then
    browser_e2e_log_audit_report_scan_failure "$phase" "INPUT"
    return 1
  fi
  if (($# == 0)); then
    browser_e2e_log_audit_report_scan_failure "$phase" "PROTECTED_VALUE_INPUT"
    return 1
  fi

  for value in "$@"; do
    browser_e2e_log_audit_fixed_value "$phase" "$log_file" "$value" || return 1
  done

  browser_e2e_log_audit_regex \
    "$phase" "$log_file" "POSTGRESQL_URL" \
    'postgresql(\+psycopg)?://' || return 1
  browser_e2e_log_audit_regex \
    "$phase" "$log_file" "BEARER_CREDENTIAL" \
    '(^|[^[:alnum:]_])Bearer[[:space:]]' || return 1
  browser_e2e_log_audit_regex \
    "$phase" "$log_file" "JWT_COMPACT" \
    'eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' || return 1
  browser_e2e_log_audit_regex \
    "$phase" "$log_file" "STRIPE_WEBHOOK_SECRET_PREFIX" \
    'whsec_' || return 1
  browser_e2e_log_audit_regex \
    "$phase" "$log_file" "STRIPE_SECRET_KEY_PREFIX" \
    'sk_(live|test)_' || return 1
  browser_e2e_log_audit_regex \
    "$phase" "$log_file" "STRIPE_SIGNATURE" \
    'stripe-signature' || return 1
  browser_e2e_log_audit_regex \
    "$phase" "$log_file" "ORDER_ACCESS_HEADER" \
    'x-order-access-token' || return 1
  browser_e2e_log_audit_regex \
    "$phase" "$log_file" "ORDER_ACCESS_TOKEN_OR_CAPABILITY_TEXT" \
    'order[_ -]?access[_ -]?(token|capability)' || return 1
  browser_e2e_log_audit_regex \
    "$phase" "$log_file" "STRIPE_URL" \
    'https?://([^/]+\.)?(stripe\.com|stripe\.network|stripeassets\.com|stripecdn\.com|stripepayments\.com)([:/]|$)' || return 1
  browser_e2e_log_audit_regex \
    "$phase" "$log_file" "TRACEBACK" \
    'Traceback' || return 1
  browser_e2e_log_audit_http_5xx "$phase" "$log_file" || return 1
}

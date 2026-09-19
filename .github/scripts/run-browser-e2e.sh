#!/usr/bin/env bash

set -euo pipefail

IFS=$'\n\t'
umask 077

readonly SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIRECTORY/../.." && pwd -P)"

RUNNER_TEMP_ROOT=""
WORK_DIRECTORY=""
PLAYWRIGHT_OUTPUT_DIRECTORY=""
ENV_FILE=""
CONFIG_FILE=""
LOG_FILE=""
COMMAND_LOG_FILE=""
PROJECT_NAME=""
RUN_ID=""
FRONTEND_PORT=""
VOLUME_NAME=""
BACKEND_IMAGE=""
FRONTEND_IMAGE=""
STACK_TOUCHED=0
LOGS_AUDITED=0
COMPOSE=()

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "E2E_REQUIRED_COMMAND_MISSING"
}

random_hex() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(Number(process.argv[1])).toString('hex'))" "$1"
}

choose_loopback_port() {
  node <<'NODE'
const net = require('node:net');

const server = net.createServer();
server.unref();
server.on('error', () => {
  process.stderr.write('E2E_PORT_ALLOCATION_FAILED\n');
  process.exitCode = 1;
});
server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
  const address = server.address();
  if (typeof address === 'string' || address === null) {
    process.stderr.write('E2E_PORT_ALLOCATION_FAILED\n');
    process.exitCode = 1;
    server.close();
    return;
  }
  process.stdout.write(String(address.port));
  server.close();
});
NODE
}

assert_port_available() {
  node - "$FRONTEND_PORT" <<'NODE'
const net = require('node:net');

const port = Number(process.argv[2]);
const server = net.createServer();
server.unref();
server.on('error', () => {
  process.stderr.write('E2E_FRONTEND_PORT_UNAVAILABLE\n');
  process.exitCode = 1;
});
server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
  server.close();
});
NODE
}

mask_value() {
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::add-mask::%s\n' "$1"
  fi
}

container_id() {
  local service="$1"
  local include_stopped="${2:-false}"

  if [[ "$include_stopped" == "true" ]]; then
    "${COMPOSE[@]}" ps --all --quiet "$service" 2>/dev/null
  else
    "${COMPOSE[@]}" ps --quiet "$service" 2>/dev/null
  fi
}

inspect_value() {
  local container="$1"
  local template="$2"

  docker inspect --format "$template" "$container" 2>/dev/null
}

project_resources_absent() {
  local containers
  local networks

  containers="$(docker ps --all --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME" 2>/dev/null)" || return 1
  networks="$(docker network ls --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME" 2>/dev/null)" || return 1
  [[ -z "$containers" && -z "$networks" ]]
}

retained_volume_is_exact() {
  local project_label
  local volume_label
  local environment_label
  local run_label

  docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 || return 1
  project_label="$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$VOLUME_NAME" 2>/dev/null)" || return 1
  volume_label="$(docker volume inspect --format '{{index .Labels "com.docker.compose.volume"}}' "$VOLUME_NAME" 2>/dev/null)" || return 1
  environment_label="$(docker volume inspect --format '{{index .Labels "com.restaurant-ordering-analytics.environment"}}' "$VOLUME_NAME" 2>/dev/null)" || return 1
  run_label="$(docker volume inspect --format '{{index .Labels "com.restaurant-ordering-analytics.e2e-run-id"}}' "$VOLUME_NAME" 2>/dev/null)" || return 1

  [[ "$project_label" == "$PROJECT_NAME" &&
    "$volume_label" == "postgres_data" &&
    "$environment_label" == "e2e" &&
    "$run_label" == "$RUN_ID" ]]
}

audit_logs() {
  local value

  : >"$LOG_FILE" || return 1
  chmod 600 "$LOG_FILE" || return 1
  if ! "${COMPOSE[@]}" logs --no-color >"$LOG_FILE" 2>"$COMMAND_LOG_FILE"; then
    return 1
  fi

  for value in \
    "$POSTGRES_PASSWORD" \
    "$E2E_AUTH_JWT_SECRET" \
    "$E2E_STRIPE_WEBHOOK_SECRET" \
    "$E2E_ADMIN_PASSWORD" \
    "$E2E_PROMOTEE_PASSWORD" \
    "$E2E_CUSTOMER_A_PASSWORD" \
    "$E2E_CUSTOMER_B_PASSWORD" \
    "$E2E_ADMIN_EMAIL" \
    "$E2E_PROMOTEE_EMAIL" \
    "$E2E_CUSTOMER_A_EMAIL" \
    "$E2E_CUSTOMER_B_EMAIL"; do
    if grep -Fq -- "$value" "$LOG_FILE"; then
      printf '%s\n' 'E2E_LOG_VALUE_LEAK_DETECTED' >&2
      return 1
    fi
  done

  if grep -Eiq -- \
    'postgresql(\+psycopg)?://|(^|[^[:alnum:]_])Bearer[[:space:]]|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|whsec_|sk_(live|test)_|stripe-signature|x-order-access-token|order[_ -]?access[_ -]?(token|capability)|https?://([^/]+\.)?(stripe\.com|stripe\.network|stripeassets\.com|stripecdn\.com|stripepayments\.com)([:/]|$)|Traceback|"[^"]* HTTP/[0-9.]+"[[:space:]]+5[0-9]{2}([[:space:]]|$)' \
    "$LOG_FILE"; then
    printf '%s\n' 'E2E_LOG_SECURITY_PATTERN_DETECTED' >&2
    return 1
  fi

  LOGS_AUDITED=1
}

remove_owned_work_directory() {
  [[ -n "$WORK_DIRECTORY" ]] || return 0
  [[ -d "$WORK_DIRECTORY" && ! -L "$WORK_DIRECTORY" ]] || return 1
  case "$WORK_DIRECTORY" in
    "$RUNNER_TEMP_ROOT"/roa-stage19-e2e.*) ;;
    *) return 1 ;;
  esac

  rm -f -- "$ENV_FILE" "$CONFIG_FILE" "$LOG_FILE" "$COMMAND_LOG_FILE"
  rmdir -- "$WORK_DIRECTORY"
  [[ ! -e "$WORK_DIRECTORY" ]]
}

remove_owned_playwright_output() {
  [[ -n "$PLAYWRIGHT_OUTPUT_DIRECTORY" ]] || return 0
  [[ "$PLAYWRIGHT_OUTPUT_DIRECTORY" == "$RUNNER_TEMP_ROOT/roa-stage18-playwright-$RUN_ID" ]] || return 1
  [[ ! -L "$PLAYWRIGHT_OUTPUT_DIRECTORY" ]] || return 1
  if [[ -e "$PLAYWRIGHT_OUTPUT_DIRECTORY" ]]; then
    [[ -d "$PLAYWRIGHT_OUTPUT_DIRECTORY" ]] || return 1
    rm -rf -- "$PLAYWRIGHT_OUTPUT_DIRECTORY"
  fi
  [[ ! -e "$PLAYWRIGHT_OUTPUT_DIRECTORY" ]]
}

cleanup() {
  local original_status=$?
  local cleanup_failed=0

  trap - EXIT INT TERM HUP
  set +e

  if ((STACK_TOUCHED == 1)); then
    if ((LOGS_AUDITED == 0)); then
      audit_logs || cleanup_failed=1
    fi
    if ! "${COMPOSE[@]}" down --remove-orphans >"$COMMAND_LOG_FILE" 2>&1; then
      cleanup_failed=1
    fi
    project_resources_absent || cleanup_failed=1
    retained_volume_is_exact || cleanup_failed=1
  fi

  unset \
    AUTH_JWT_SECRET \
    E2E_ADMIN_EMAIL \
    E2E_ADMIN_PASSWORD \
    E2E_AUTH_JWT_SECRET \
    E2E_CUSTOMER_A_EMAIL \
    E2E_CUSTOMER_A_PASSWORD \
    E2E_CUSTOMER_B_EMAIL \
    E2E_CUSTOMER_B_PASSWORD \
    E2E_POSTGRES_PASSWORD \
    E2E_PROMOTEE_EMAIL \
    E2E_PROMOTEE_PASSWORD \
    E2E_STRIPE_WEBHOOK_SECRET \
    POSTGRES_PASSWORD \
    STRIPE_WEBHOOK_SECRET

  remove_owned_playwright_output || cleanup_failed=1
  remove_owned_work_directory || cleanup_failed=1

  if ((cleanup_failed != 0)); then
    printf '%s\n' 'E2E_CLEANUP_FAILED' >&2
    if ((original_status == 0)); then
      original_status=1
    fi
  fi

  exit "$original_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

require_command bash
require_command chmod
require_command curl
require_command docker
require_command grep
require_command mktemp
require_command node
require_command rm
require_command rmdir
require_command sed
require_command sleep
require_command sort
require_command touch

[[ -n "${RUNNER_TEMP:-}" ]] || fail "E2E_RUNNER_TEMP_MISSING"
[[ "$RUNNER_TEMP" == /* ]] || fail "E2E_RUNNER_TEMP_INVALID"
[[ -d "$RUNNER_TEMP" && ! -L "$RUNNER_TEMP" && -w "$RUNNER_TEMP" ]] || fail "E2E_RUNNER_TEMP_INVALID"
RUNNER_TEMP_ROOT="$(cd -- "$RUNNER_TEMP" && pwd -P)"
[[ "$RUNNER_TEMP_ROOT" == /* ]] || fail "E2E_RUNNER_TEMP_INVALID"
export TMPDIR="$RUNNER_TEMP_ROOT"

WORK_DIRECTORY="$(mktemp -d "$RUNNER_TEMP_ROOT/roa-stage19-e2e.XXXXXXXX")"
[[ -d "$WORK_DIRECTORY" && ! -L "$WORK_DIRECTORY" ]] || fail "E2E_TEMP_SETUP_FAILED"
chmod 700 "$WORK_DIRECTORY"

ENV_FILE="$WORK_DIRECTORY/compose.env"
CONFIG_FILE="$WORK_DIRECTORY/compose.json"
LOG_FILE="$WORK_DIRECTORY/compose.log"
COMMAND_LOG_FILE="$WORK_DIRECTORY/command.log"
touch "$ENV_FILE" "$CONFIG_FILE" "$LOG_FILE" "$COMMAND_LOG_FILE"
chmod 600 "$ENV_FILE" "$CONFIG_FILE" "$LOG_FILE" "$COMMAND_LOG_FILE"

RUN_ID="$(random_hex 8)"
[[ "$RUN_ID" =~ ^[0-9a-f]{16}$ ]] || fail "E2E_RUN_ID_INVALID"
PLAYWRIGHT_OUTPUT_DIRECTORY="$RUNNER_TEMP_ROOT/roa-stage18-playwright-$RUN_ID"
PROJECT_NAME="roa-stage18-e2e-$RUN_ID"
VOLUME_NAME="$PROJECT_NAME-postgres-data"
BACKEND_IMAGE="roa-stage18-backend:$RUN_ID"
FRONTEND_IMAGE="roa-stage18-frontend:$RUN_ID"

while :; do
  FRONTEND_PORT="$(choose_loopback_port)"
  if [[ "$FRONTEND_PORT" =~ ^[1-9][0-9]{3,4}$ ]] &&
    ((FRONTEND_PORT <= 65535)) &&
    [[ "$FRONTEND_PORT" != "5173" && "$FRONTEND_PORT" != "5432" && "$FRONTEND_PORT" != "5433" ]]; then
    break
  fi
done

POSTGRES_PASSWORD="$(random_hex 32)"
E2E_AUTH_JWT_SECRET="$(random_hex 32)"
E2E_STRIPE_WEBHOOK_SECRET="$(random_hex 32)"
E2E_ADMIN_PASSWORD="$(random_hex 24)"
E2E_PROMOTEE_PASSWORD="$(random_hex 24)"
E2E_CUSTOMER_A_PASSWORD="$(random_hex 24)"
E2E_CUSTOMER_B_PASSWORD="$(random_hex 24)"
E2E_ADMIN_EMAIL="stage18-admin-$RUN_ID@example.com"
E2E_PROMOTEE_EMAIL="stage18-promotee-$RUN_ID@example.com"
E2E_CUSTOMER_A_EMAIL="stage18.customer.a.$RUN_ID@example.com"
E2E_CUSTOMER_B_EMAIL="stage18.customer.b.$RUN_ID@example.com"

for value in \
  "$POSTGRES_PASSWORD" \
  "$E2E_AUTH_JWT_SECRET" \
  "$E2E_STRIPE_WEBHOOK_SECRET" \
  "$E2E_ADMIN_PASSWORD" \
  "$E2E_PROMOTEE_PASSWORD" \
  "$E2E_CUSTOMER_A_PASSWORD" \
  "$E2E_CUSTOMER_B_PASSWORD" \
  "$E2E_ADMIN_EMAIL" \
  "$E2E_PROMOTEE_EMAIL" \
  "$E2E_CUSTOMER_A_EMAIL" \
  "$E2E_CUSTOMER_B_EMAIL"; do
  mask_value "$value"
done
mask_value "postgresql+psycopg://e2e_app:$POSTGRES_PASSWORD@postgres:5432/restaurant_ordering_analytics_e2e"

export POSTGRES_DB="restaurant_ordering_analytics_e2e"
export POSTGRES_USER="e2e_app"
export POSTGRES_PASSWORD
export POSTGRES_HOST_PORT="5433"
export STRIPE_SECRET_KEY=""
export STRIPE_WEBHOOK_SECRET="$E2E_STRIPE_WEBHOOK_SECRET"
export STRIPE_SUCCESS_URL="http://127.0.0.1:$FRONTEND_PORT/orders/{public_order_number}/payment-return"
export STRIPE_CANCEL_URL="http://127.0.0.1:$FRONTEND_PORT/orders/{public_order_number}/checkout-cancelled"
export AUTH_JWT_SECRET="$E2E_AUTH_JWT_SECRET"
export AUTH_ACCESS_TOKEN_EXPIRE_MINUTES="30"
export E2E_MODE="isolated"
export E2E_PROJECT_NAME="$PROJECT_NAME"
export E2E_RUN_ID="$RUN_ID"
export E2E_FRONTEND_PORT="$FRONTEND_PORT"
export E2E_PUBLIC_ORIGIN="http://127.0.0.1:$FRONTEND_PORT"
export E2E_POSTGRES_PASSWORD="$POSTGRES_PASSWORD"
export E2E_AUTH_JWT_SECRET
export E2E_STRIPE_WEBHOOK_SECRET
export E2E_ADMIN_EMAIL
export E2E_ADMIN_PASSWORD
export E2E_PROMOTEE_EMAIL
export E2E_PROMOTEE_PASSWORD
export E2E_CUSTOMER_A_EMAIL
export E2E_CUSTOMER_A_PASSWORD
export E2E_CUSTOMER_B_EMAIL
export E2E_CUSTOMER_B_PASSWORD
export E2E_BASE_URL="http://127.0.0.1:$FRONTEND_PORT"
export COMPOSE_DISABLE_ENV_FILE="1"
unset COMPOSE_ENV_FILES COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME
unset DATABASE_URL TEST_DATABASE_URL

{
  printf 'POSTGRES_DB=%s\n' "$POSTGRES_DB"
  printf 'POSTGRES_USER=%s\n' "$POSTGRES_USER"
  printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD"
  printf 'POSTGRES_HOST_PORT=%s\n' "$POSTGRES_HOST_PORT"
  printf 'STRIPE_SECRET_KEY=\n'
  printf 'STRIPE_WEBHOOK_SECRET=%s\n' "$STRIPE_WEBHOOK_SECRET"
  printf 'STRIPE_SUCCESS_URL=%s\n' "$STRIPE_SUCCESS_URL"
  printf 'STRIPE_CANCEL_URL=%s\n' "$STRIPE_CANCEL_URL"
  printf 'AUTH_JWT_SECRET=%s\n' "$AUTH_JWT_SECRET"
  printf 'AUTH_ACCESS_TOKEN_EXPIRE_MINUTES=%s\n' "$AUTH_ACCESS_TOKEN_EXPIRE_MINUTES"
  printf 'E2E_MODE=%s\n' "$E2E_MODE"
  printf 'E2E_PROJECT_NAME=%s\n' "$E2E_PROJECT_NAME"
  printf 'E2E_RUN_ID=%s\n' "$E2E_RUN_ID"
  printf 'E2E_FRONTEND_PORT=%s\n' "$E2E_FRONTEND_PORT"
  printf 'E2E_PUBLIC_ORIGIN=%s\n' "$E2E_PUBLIC_ORIGIN"
  printf 'E2E_POSTGRES_PASSWORD=%s\n' "$E2E_POSTGRES_PASSWORD"
  printf 'E2E_AUTH_JWT_SECRET=%s\n' "$E2E_AUTH_JWT_SECRET"
  printf 'E2E_STRIPE_WEBHOOK_SECRET=%s\n' "$E2E_STRIPE_WEBHOOK_SECRET"
  printf 'E2E_ADMIN_EMAIL=%s\n' "$E2E_ADMIN_EMAIL"
  printf 'E2E_ADMIN_PASSWORD=%s\n' "$E2E_ADMIN_PASSWORD"
} >"$ENV_FILE"
chmod 600 "$ENV_FILE"

COMPOSE=(
  docker compose
  --project-name "$PROJECT_NAME"
  --project-directory "$REPOSITORY_ROOT"
  --env-file "$ENV_FILE"
  -f "$REPOSITORY_ROOT/compose.yaml"
  -f "$REPOSITORY_ROOT/compose.e2e.yaml"
)

project_resources_absent || fail "E2E_PROJECT_COLLISION"
docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 && fail "E2E_VOLUME_COLLISION"
docker network inspect "$PROJECT_NAME-app" >/dev/null 2>&1 && fail "E2E_NETWORK_COLLISION"
docker network inspect "$PROJECT_NAME-data" >/dev/null 2>&1 && fail "E2E_NETWORK_COLLISION"
docker image inspect "$BACKEND_IMAGE" >/dev/null 2>&1 && fail "E2E_IMAGE_COLLISION"
docker image inspect "$FRONTEND_IMAGE" >/dev/null 2>&1 && fail "E2E_IMAGE_COLLISION"
assert_port_available

if ! "${COMPOSE[@]}" config --quiet >"$COMMAND_LOG_FILE" 2>&1; then
  fail "E2E_COMPOSE_CONFIG_INVALID"
fi
if ! "${COMPOSE[@]}" config --format json >"$CONFIG_FILE" 2>"$COMMAND_LOG_FILE"; then
  fail "E2E_COMPOSE_CONFIG_INVALID"
fi

node - "$CONFIG_FILE" "$ENV_FILE" "$PROJECT_NAME" "$RUN_ID" "$FRONTEND_PORT" <<'NODE'
const fs = require('node:fs');

try {
  const [configPath, envPath, projectName, runId, frontendPort] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const env = Object.fromEntries(
    fs
      .readFileSync(envPath, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator < 1) throw new Error('invalid');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const services = config.services ?? {};
  const exactKeys = (value, expected) =>
    JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...expected].sort());
  const assert = (condition) => {
    if (!condition) throw new Error('invalid');
  };
  const serviceNames = ['postgres', 'migrate', 'backend', 'frontend'];
  assert(config.name === projectName);
  assert(exactKeys(services, serviceNames));
  assert(exactKeys(config.networks, ['app', 'data']));
  assert(exactKeys(config.volumes, ['postgres_data']));
  assert(config.networks.app.name === `${projectName}-app`);
  assert(config.networks.data.name === `${projectName}-data`);
  assert(config.networks.data.internal === true);
  assert(config.volumes.postgres_data.name === `${projectName}-postgres-data`);
  assert(env.POSTGRES_DB === 'restaurant_ordering_analytics_e2e');
  assert(env.POSTGRES_USER === 'e2e_app');
  assert(env.POSTGRES_PASSWORD === env.E2E_POSTGRES_PASSWORD);
  assert(env.AUTH_JWT_SECRET === env.E2E_AUTH_JWT_SECRET);
  assert(env.STRIPE_WEBHOOK_SECRET === env.E2E_STRIPE_WEBHOOK_SECRET);
  assert(env.STRIPE_SECRET_KEY === '');
  assert(env.E2E_RUN_ID === runId);
  assert(env.E2E_PROJECT_NAME === projectName);
  assert(env.E2E_FRONTEND_PORT === frontendPort);
  assert(env.E2E_PUBLIC_ORIGIN === `http://127.0.0.1:${frontendPort}`);

  const networkKeys = (service) => Object.keys(service.networks ?? {}).sort();
  assert(JSON.stringify(networkKeys(services.postgres)) === JSON.stringify(['data']));
  assert(JSON.stringify(networkKeys(services.migrate)) === JSON.stringify(['data']));
  assert(JSON.stringify(networkKeys(services.backend)) === JSON.stringify(['app', 'data']));
  assert(JSON.stringify(networkKeys(services.frontend)) === JSON.stringify(['app']));

  for (const name of ['postgres', 'migrate', 'backend']) {
    assert((services[name].ports ?? []).length === 0);
  }
  const ports = services.frontend.ports ?? [];
  assert(ports.length === 1);
  assert(Number(ports[0].target) === 8080);
  assert(String(ports[0].published) === frontendPort);
  assert(ports[0].host_ip === '127.0.0.1');

  assert(services.backend.image === `roa-stage18-backend:${runId}`);
  assert(services.migrate.image === `roa-stage18-backend:${runId}`);
  assert(services.frontend.image === `roa-stage18-frontend:${runId}`);
  assert(services.backend.environment.STRIPE_SECRET_KEY === '');
  assert(!Object.hasOwn(services.backend.environment, 'E2E_ADMIN_EMAIL'));
  assert(!Object.hasOwn(services.backend.environment, 'E2E_ADMIN_PASSWORD'));
  assert(services.migrate.environment.E2E_ADMIN_EMAIL === env.E2E_ADMIN_EMAIL);
  assert(services.migrate.environment.E2E_ADMIN_PASSWORD === env.E2E_ADMIN_PASSWORD);

  for (const name of ['migrate', 'backend', 'frontend']) {
    const service = services[name];
    assert(service.read_only === true);
    assert((service.cap_drop ?? []).includes('ALL'));
    assert((service.security_opt ?? []).includes('no-new-privileges:true'));
    assert((service.tmpfs ?? []).some((entry) => String(entry).startsWith('/tmp:')));
  }

  for (const name of ['migrate', 'backend']) {
    const mounts = services[name].volumes ?? [];
    assert(mounts.length === 1);
    assert(mounts[0].type === 'bind');
    assert(
      String(mounts[0].source).replaceAll('\\', '/').endsWith('/backend/e2e_harness.py'),
    );
    assert(mounts[0].target === '/opt/restaurant/backend/e2e_harness.py');
    assert(mounts[0].read_only === true);
    assert(
      mounts[0].bind?.create_host_path === false ||
        mounts[0].bind?.create_host_path === undefined,
    );
  }
} catch {
  process.stderr.write('E2E_COMPOSE_CONFIG_INVALID\n');
  process.exit(1);
}
NODE

printf '%s\n' 'E2E Compose configuration validated.'

if ! "${COMPOSE[@]}" build --pull backend frontend; then
  fail "E2E_IMAGE_BUILD_FAILED"
fi
docker image inspect "$BACKEND_IMAGE" >/dev/null 2>&1 || fail "E2E_BACKEND_IMAGE_MISSING"
docker image inspect "$FRONTEND_IMAGE" >/dev/null 2>&1 || fail "E2E_FRONTEND_IMAGE_MISSING"

assert_port_available
STACK_TOUCHED=1
if ! "${COMPOSE[@]}" up --detach --no-build frontend >"$COMMAND_LOG_FILE" 2>&1; then
  fail "E2E_STACK_START_FAILED"
fi

deadline=$((SECONDS + 180))
while ((SECONDS < deadline)); do
  postgres_id="$(container_id postgres)"
  migrate_id="$(container_id migrate true)"
  backend_id="$(container_id backend)"
  frontend_id="$(container_id frontend)"

  if [[ -n "$migrate_id" ]] &&
    [[ "$(inspect_value "$migrate_id" '{{.State.Status}}')" == "exited" ]] &&
    [[ "$(inspect_value "$migrate_id" '{{.State.ExitCode}}')" != "0" ]]; then
    fail "E2E_MIGRATION_FAILED"
  fi

  if [[ -n "$postgres_id" && -n "$migrate_id" && -n "$backend_id" && -n "$frontend_id" ]] &&
    [[ "$(inspect_value "$postgres_id" '{{.State.Health.Status}}')" == "healthy" ]] &&
    [[ "$(inspect_value "$migrate_id" '{{.State.Status}}')" == "exited" ]] &&
    [[ "$(inspect_value "$migrate_id" '{{.State.ExitCode}}')" == "0" ]] &&
    [[ "$(inspect_value "$backend_id" '{{.State.Health.Status}}')" == "healthy" ]] &&
    [[ "$(inspect_value "$frontend_id" '{{.State.Health.Status}}')" == "healthy" ]]; then
    break
  fi
  sleep 2
done

[[ -n "${postgres_id:-}" && -n "${migrate_id:-}" && -n "${backend_id:-}" && -n "${frontend_id:-}" ]] || fail "E2E_STACK_TIMEOUT"
[[ "$(inspect_value "$postgres_id" '{{.State.Health.Status}}')" == "healthy" ]] || fail "E2E_STACK_TIMEOUT"
[[ "$(inspect_value "$migrate_id" '{{.State.Status}}')" == "exited" ]] || fail "E2E_STACK_TIMEOUT"
[[ "$(inspect_value "$migrate_id" '{{.State.ExitCode}}')" == "0" ]] || fail "E2E_MIGRATION_FAILED"
[[ "$(inspect_value "$backend_id" '{{.State.Health.Status}}')" == "healthy" ]] || fail "E2E_STACK_TIMEOUT"
[[ "$(inspect_value "$frontend_id" '{{.State.Health.Status}}')" == "healthy" ]] || fail "E2E_STACK_TIMEOUT"

container_count="$(docker ps --all --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME" | grep -c . || true)"
[[ "$container_count" == "4" ]] || fail "E2E_CONTAINER_SET_INVALID"

for container in "$postgres_id" "$migrate_id" "$backend_id" "$frontend_id"; do
  [[ "$(inspect_value "$container" '{{.RestartCount}}')" == "0" ]] || fail "E2E_CONTAINER_RESTARTED"
  [[ "$(inspect_value "$container" '{{.HostConfig.Privileged}}')" == "false" ]] || fail "E2E_CONTAINER_PRIVILEGED"
  [[ "$(inspect_value "$container" '{{.HostConfig.RestartPolicy.Name}}')" == "no" ]] || fail "E2E_RESTART_POLICY_INVALID"
done

assert_hardened_service() {
  local container="$1"
  local expected_user="$2"
  local tmpfs_options

  [[ "$(inspect_value "$container" '{{.Config.User}}')" == "$expected_user" ]] || fail "E2E_CONTAINER_USER_INVALID"
  [[ "$(inspect_value "$container" '{{.HostConfig.ReadonlyRootfs}}')" == "true" ]] || fail "E2E_READ_ONLY_ROOTFS_DISABLED"
  [[ "$(inspect_value "$container" '{{json .HostConfig.CapDrop}}')" == *'"ALL"'* ]] || fail "E2E_CAP_DROP_INVALID"
  [[ "$(inspect_value "$container" '{{json .HostConfig.SecurityOpt}}')" == *'"no-new-privileges:true"'* ]] || fail "E2E_SECURITY_OPT_INVALID"
  tmpfs_options="$(inspect_value "$container" '{{index .HostConfig.Tmpfs "/tmp"}}')"
  for option in rw nosuid nodev noexec size=16m; do
    [[ ",$tmpfs_options," == *",$option,"* ]] || fail "E2E_TMPFS_INVALID"
  done
}

assert_hardened_service "$migrate_id" "10001:10001"
assert_hardened_service "$backend_id" "10001:10001"
assert_hardened_service "$frontend_id" "101:101"

for container in "$postgres_id" "$migrate_id" "$backend_id"; do
  [[ -z "$(docker port "$container" 2>/dev/null)" ]] || fail "E2E_PRIVATE_PORT_PUBLISHED"
done
[[ "$(docker port "$frontend_id" 8080/tcp 2>/dev/null)" == "127.0.0.1:$FRONTEND_PORT" ]] || fail "E2E_FRONTEND_PORT_INVALID"
[[ "$(docker port "$frontend_id" 2>/dev/null | grep -c . || true)" == "1" ]] || fail "E2E_FRONTEND_PORT_INVALID"

network_names() {
  inspect_value "$1" '{{range $key, $_ := .NetworkSettings.Networks}}{{$key}}{{"\n"}}{{end}}' | sed '/^$/d' | sort
}

[[ "$(network_names "$postgres_id")" == "$PROJECT_NAME-data" ]] || fail "E2E_NETWORK_MEMBERSHIP_INVALID"
[[ "$(network_names "$migrate_id")" == "$PROJECT_NAME-data" ]] || fail "E2E_NETWORK_MEMBERSHIP_INVALID"
[[ "$(network_names "$backend_id")" == $PROJECT_NAME-app$'\n'$PROJECT_NAME-data ]] || fail "E2E_NETWORK_MEMBERSHIP_INVALID"
[[ "$(network_names "$frontend_id")" == "$PROJECT_NAME-app" ]] || fail "E2E_NETWORK_MEMBERSHIP_INVALID"
[[ "$(docker network inspect --format '{{.Internal}}' "$PROJECT_NAME-data" 2>/dev/null)" == "true" ]] || fail "E2E_DATA_NETWORK_INVALID"
[[ "$(docker network inspect --format '{{.Internal}}' "$PROJECT_NAME-app" 2>/dev/null)" == "false" ]] || fail "E2E_APP_NETWORK_INVALID"

postgres_mount="$(inspect_value "$postgres_id" '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}|{{.RW}}|{{.Type}}{{end}}{{end}}')"
[[ "$postgres_mount" == "$VOLUME_NAME|true|volume" ]] || fail "E2E_DATABASE_VOLUME_INVALID"
for container in "$migrate_id" "$backend_id"; do
  harness_mount="$(inspect_value "$container" '{{range .Mounts}}{{if eq .Destination "/opt/restaurant/backend/e2e_harness.py"}}{{.RW}}|{{.Type}}{{end}}{{end}}')"
  [[ "$harness_mount" == "false|bind" ]] || fail "E2E_HARNESS_MOUNT_INVALID"
done
retained_volume_is_exact || fail "E2E_DATABASE_VOLUME_INVALID"

curl --fail --silent --show-error --connect-timeout 5 --max-time 10 --output /dev/null "$E2E_BASE_URL/healthz" || fail "E2E_FRONTEND_HEALTH_FAILED"
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 --output /dev/null "$E2E_BASE_URL/ready" || fail "E2E_BACKEND_READY_FAILED"
legacy_login_status="$(curl --silent --show-error --connect-timeout 5 --max-time 10 --output /dev/null --write-out '%{http_code}' --request POST "$E2E_BASE_URL/api/v1/admin/auth/login")"
legacy_me_status="$(curl --silent --show-error --connect-timeout 5 --max-time 10 --output /dev/null --write-out '%{http_code}' "$E2E_BASE_URL/api/v1/admin/auth/me")"
[[ "$legacy_login_status" == "404" && "$legacy_me_status" == "404" ]] || fail "E2E_LEGACY_AUTH_BOUNDARY_FAILED"

printf '%s\n' 'E2E stack health and runtime boundaries validated.'

(
  cd -- "$REPOSITORY_ROOT/frontend"
  npx playwright test \
    e2e/runtime.e2e.ts \
    e2e/auth-account.e2e.ts \
    e2e/guest-order-admin.e2e.ts \
    e2e/responsive-accessibility.e2e.ts \
    --workers=1 \
    --retries=0
)

if ! "${COMPOSE[@]}" exec -T backend python -m alembic current --check-heads >"$COMMAND_LOG_FILE" 2>&1; then
  fail "E2E_ALEMBIC_HEAD_INVALID"
fi

if ! database_state="$("${COMPOSE[@]}" exec -T postgres sh -ec \
  'exec psql --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>"$COMMAND_LOG_FILE" <<'SQL'
SELECT CASE WHEN
    current_database() = 'restaurant_ordering_analytics_e2e'
    AND current_user = 'e2e_app'
    AND (SELECT count(*) FROM alembic_version WHERE version_num = '0009_add_portfolio_demo_origin_and_payment_provider') = 1
    AND (SELECT count(*) FROM users) = 4
    AND (SELECT count(*) FROM users WHERE role = 'customer') = 2
    AND (SELECT count(*) FROM users WHERE role = 'admin') = 1
    AND (SELECT count(*) FROM users WHERE role = 'super_admin') = 1
    AND (SELECT count(*) FROM categories) = 5
    AND (SELECT count(*) FROM menu_items) = 15
    AND (SELECT count(*) FROM orders) = 3
    AND (SELECT count(*) FROM orders WHERE customer_user_id IS NULL) = 1
    AND (SELECT count(*) FROM orders WHERE customer_user_id IS NOT NULL) = 2
    AND (SELECT count(*) FROM orders WHERE status = 'created') = 2
    AND (SELECT count(*) FROM orders WHERE status = 'completed') = 1
    AND (SELECT count(*) FROM order_items) = 3
    AND (SELECT count(*) FROM order_status_history) = 7
    AND (SELECT count(*) FROM payments WHERE status = 'succeeded') = 1
    AND (SELECT count(*) FROM stripe_events) = 1
  THEN 'PASS'
  ELSE 'FAIL'
END;
SQL
)"; then
  fail "E2E_DATABASE_STATE_INVALID"
fi
[[ "$database_state" == "PASS" ]] || fail "E2E_DATABASE_STATE_INVALID"

audit_logs || fail "E2E_LOG_AUDIT_FAILED"

printf '%s\n' 'E2E database and secret-safe log audits passed.'

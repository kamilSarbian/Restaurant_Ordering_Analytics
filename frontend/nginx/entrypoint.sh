#!/bin/sh
set -eu

fail() {
    printf '%s\n' 'Frontend startup aborted: invalid runtime configuration.' >&2
    exit 1
}

valid_port() {
    case "$1" in
        ''|*[!0-9]*)
            return 1
            ;;
    esac

    [ "${#1}" -le 5 ] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

valid_ipv4() {
    address=$1
    case "$address" in
        ''|.*|*.|*..*|*[!0-9.]*)
            return 1
            ;;
    esac

    previous_ifs=$IFS
    IFS=.
    set -- $address
    IFS=$previous_ifs
    [ "$#" -eq 4 ] || return 1

    for octet in "$@"; do
        case "$octet" in
            ''|*[!0-9]*)
                return 1
                ;;
        esac
        [ "${#octet}" -le 3 ] && [ "$octet" -le 255 ] || return 1
    done
}

valid_hostname() {
    hostname=$1
    [ -n "$hostname" ] && [ "${#hostname}" -le 253 ] || return 1
    case "$hostname" in
        .*|*.|*..*|*[!A-Za-z0-9.-]*)
            return 1
            ;;
    esac

    previous_ifs=$IFS
    IFS=.
    set -- $hostname
    IFS=$previous_ifs
    for label in "$@"; do
        [ "${#label}" -le 63 ] || return 1
        case "$label" in
            ''|-*|*-|*[!A-Za-z0-9-]*)
                return 1
                ;;
        esac
    done
}

PORT=${PORT:-}
BACKEND_UPSTREAM=${BACKEND_UPSTREAM:-}

valid_port "$PORT" || fail
[ "$PORT" -ge 1024 ] || fail

case "$BACKEND_UPSTREAM" in
    *:*)
        upstream_host=${BACKEND_UPSTREAM%:*}
        upstream_port=${BACKEND_UPSTREAM##*:}
        ;;
    *)
        fail
        ;;
esac

case "$upstream_host" in
    *:*)
        fail
        ;;
esac

valid_hostname "$upstream_host" || fail
valid_port "$upstream_port" || fail

DNS_RESOLVER=''
[ -r /etc/resolv.conf ] || fail
if ! {
    while :; do
        directive=''
        value=''
        remainder=''
        if ! read -r directive value remainder; then
            [ -n "$directive$value$remainder" ] || break
        fi
        if [ "$directive" = 'nameserver' ] && valid_ipv4 "$value"; then
            DNS_RESOLVER=$value
            break
        fi
    done
} 2>/dev/null < /etc/resolv.conf; then
    fail
fi
[ -n "$DNS_RESOLVER" ] || fail

export PORT BACKEND_UPSTREAM DNS_RESOLVER
umask 077
rendered_config="/tmp/nginx-default.conf.$$"
cleanup() {
    rm -f "$rendered_config" 2>/dev/null || :
}
trap cleanup EXIT
trap fail HUP INT TERM
if ! {
    envsubst '${PORT} ${BACKEND_UPSTREAM} ${DNS_RESOLVER}' \
        < /etc/nginx/default.conf.template \
        > "$rendered_config"
} 2>/dev/null; then
    fail
fi
if ! mv "$rendered_config" /tmp/nginx-default.conf 2>/dev/null; then
    fail
fi
trap - EXIT HUP INT TERM

if ! nginx -t >/dev/null 2>&1; then
    fail
fi

exec nginx -g 'daemon off;'

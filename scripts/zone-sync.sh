#!/bin/sh
#
# Pull zone data from the priv-dns control plane and install it where the local
# resolver reads it. Safe to run from cron as often as you like: an unchanged
# zone costs one 304 response.
#
# POSIX sh on purpose - OPNsense and most appliance firmware have no bash.
#
# Two output formats:
#
#   FORMAT=unbound  Unbound `local-data` include file.
#                   Consumers: Unbound, OPNsense, pfSense.
#   FORMAT=hosts    Hosts file (`IP name`). CNAMEs are flattened to addresses.
#                   Consumers: dnsmasq addn-hosts, Pi-hole, AdGuard Home,
#                   /etc/hosts.
#   FORMAT=bind     RFC1035 zone file.
#                   Consumers: CoreDNS, BIND, NSD, Knot, PowerDNS.
#
# The first two are ADDITIVE overlays: names present are answered locally,
# everything else falls through to normal recursion, so public names in the
# same zone keep resolving without being mirrored here. `bind` is
# AUTHORITATIVE: anything absent gets NXDOMAIN, so the zone must be a complete
# view of the namespace for its clients.
#
# A failed fetch NEVER truncates the data already on disk. If the control plane
# or the WAN link is unavailable the resolver keeps serving the last good copy
# indefinitely - it simply stops receiving updates until the link is back.
#
# Usage:
#   PRIVDNS_URL=https://dns-cp.example.net \
#   CF_ACCESS_CLIENT_ID=...  CF_ACCESS_CLIENT_SECRET=... \
#   ZONES="example.net" FORMAT=unbound \
#   ZONE_DIR=/var/unbound/etc \
#   PERSIST_DIR=/usr/local/etc/unbound.opnsense.d \
#   /usr/local/bin/priv-dns-sync.sh

set -eu

: "${PRIVDNS_URL:?set PRIVDNS_URL to the Worker base URL}"
: "${ZONES:?set ZONES to a space-separated list of origins}"

FORMAT="${FORMAT:-bind}"
ZONE_DIR="${ZONE_DIR:-/var/lib/coredns}"
STATE_DIR="${STATE_DIR:-$ZONE_DIR/.priv-dns-state}"
UNBOUND_CONF="${UNBOUND_CONF:-/var/unbound/unbound.conf}"
# Unbound runs chrooted, so the file it actually reads lives beside its config.
# ZONE_DIR is that live directory. PERSIST_DIR is the platform's own include
# directory (OPNsense: /usr/local/etc/unbound.opnsense.d), which survives a
# reconfigure and is copied back into the chroot by the platform - set both so
# the change is live now AND after the next GUI apply.
PERSIST_DIR="${PERSIST_DIR:-}"
RELOAD_CMD="${RELOAD_CMD:-}"

# Authentication. Access service tokens are the supported path: once a
# Cloudflare Access application fronts the hostname it intercepts every
# request, and a plain bearer token gets a redirect to the SSO login rather
# than reaching the Worker at all. PRIVDNS_TOKEN still works for a deployment
# with no Access application in front of it.
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  set -- --header "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
         --header "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
elif [ -n "${PRIVDNS_TOKEN:-}" ]; then
  set -- --header "Authorization: Bearer $PRIVDNS_TOKEN"
else
  echo "priv-dns: set CF_ACCESS_CLIENT_ID/SECRET, or PRIVDNS_TOKEN" >&2
  exit 1
fi

mkdir -p "$ZONE_DIR" "$STATE_DIR"

FMT_QUERY=""
[ "$FORMAT" != "bind" ] && FMT_QUERY="?format=$FORMAT"

# Run unbound-checkconf from the config's own directory: modules are referenced
# by relative path (the DNSBL python module on OPNsense) and the check fails
# spuriously from anywhere else.
check_unbound() {
  ( cd "$(dirname "$UNBOUND_CONF")" && unbound-checkconf "$UNBOUND_CONF" ) >/dev/null 2>&1
}

# Copy the installed file into the platform's persistent include directory, so
# a later GUI apply does not silently revert to the previous data.
persist() {
  [ -n "$PERSIST_DIR" ] || return 0
  [ -d "$PERSIST_DIR" ] || return 0
  cp "$1" "$PERSIST_DIR/$(basename "$1")" 2>/dev/null \
    || echo "priv-dns: could not persist $2 to $PERSIST_DIR" >&2
}

changed=0

for zone in $ZONES; do
  case "$FORMAT" in
    unbound) target="$ZONE_DIR/priv-dns-$zone.conf" ;;
    hosts)   target="$ZONE_DIR/priv-dns-$zone.hosts" ;;
    *)       target="$ZONE_DIR/$zone.zone" ;;
  esac
  tmp="$(mktemp "$STATE_DIR/$zone.XXXXXX")"
  etag_file="$STATE_DIR/$zone.etag"

  if [ -f "$etag_file" ]; then
    status="$(curl --silent --show-error --location --max-time 30 \
      --retry 2 --retry-delay 3 "$@" \
      --etag-compare "$etag_file" --etag-save "$etag_file" \
      --output "$tmp" --write-out '%{http_code}' \
      "$PRIVDNS_URL/zone/$zone$FMT_QUERY" || echo 000)"
  else
    status="$(curl --silent --show-error --location --max-time 30 \
      --retry 2 --retry-delay 3 "$@" \
      --etag-save "$etag_file" \
      --output "$tmp" --write-out '%{http_code}' \
      "$PRIVDNS_URL/zone/$zone$FMT_QUERY" || echo 000)"
  fi

  case "$status" in
    304)
      rm -f "$tmp"
      continue
      ;;
    200) ;;
    301|302)
      echo "priv-dns: $zone got an Access login redirect - the service token is" \
           "missing, wrong, or not allowed by a policy; keeping existing data" >&2
      rm -f "$tmp" "$etag_file"
      continue
      ;;
    *)
      echo "priv-dns: fetch of $zone failed (HTTP $status); keeping existing data" >&2
      # Drop the cached etag so the next run re-fetches rather than trusting a
      # 304 against a body we never stored.
      rm -f "$tmp" "$etag_file"
      continue
      ;;
  esac

  # Refuse to install anything that is not recognisably the right shape. This
  # is the guard that stops an error page or a truncated transfer from
  # replacing working DNS data.
  sane=1
  case "$FORMAT" in
    unbound) grep -q '^[[:space:]]*local-zone:' "$tmp" || sane=0 ;;
    hosts)   grep -qE '^[0-9a-fA-F].*[[:space:]]' "$tmp" || sane=0 ;;
    *)       grep -qE '^[[:space:]]*@?[^;]*IN[[:space:]]+SOA' "$tmp" || sane=0 ;;
  esac
  if [ ! -s "$tmp" ] || [ "$sane" -eq 0 ]; then
    echo "priv-dns: $zone response is not a valid $FORMAT payload; refusing to install" >&2
    rm -f "$tmp" "$etag_file"
    continue
  fi

  if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
    rm -f "$tmp"
    continue
  fi

  # Validate before committing. For Unbound this is not optional: a syntax
  # error in an included file stops the daemon from starting, which would take
  # DNS down for the whole site. Stage the candidate at the real path so the
  # include glob picks it up, and roll back if the config does not validate.
  if [ "$FORMAT" = "unbound" ] && command -v unbound-checkconf >/dev/null 2>&1; then
    backup=""
    if [ -f "$target" ]; then
      backup="$STATE_DIR/$zone.rollback"
      cp "$target" "$backup"
    fi
    cp "$tmp" "$target"
    # mktemp creates 0600; the daemon runs as an unprivileged user and must be
    # able to read its own include, or it fails to start.
    chmod 0644 "$target"
    if ! check_unbound; then
      echo "priv-dns: $zone would break the Unbound config; rolling back" >&2
      if [ -n "$backup" ]; then cp "$backup" "$target"; else rm -f "$target"; fi
      rm -f "$tmp" "$etag_file"
      continue
    fi
    rm -f "$tmp"
    [ -n "$backup" ] && rm -f "$backup"
    persist "$target" "$zone"
    echo "priv-dns: updated $zone"
    changed=1
    continue
  fi

  if [ "$FORMAT" != "unbound" ] && command -v named-checkzone >/dev/null 2>&1; then
    if ! named-checkzone "$zone" "$tmp" >/dev/null 2>&1; then
      echo "priv-dns: $zone failed named-checkzone; refusing to install" >&2
      rm -f "$tmp" "$etag_file"
      continue
    fi
  fi

  chmod 0644 "$tmp"
  mv -f "$tmp" "$target"   # atomic within the same filesystem
  persist "$target" "$zone"
  echo "priv-dns: updated $zone"
  changed=1
done

[ "$changed" -eq 1 ] || exit 0

# RELOAD_CMD is the escape hatch for any consumer not handled below - e.g.
#   RELOAD_CMD="pihole restartdns reload"
#   RELOAD_CMD="systemctl reload dnsmasq"
#   RELOAD_CMD="docker exec adguard /opt/adguardhome/AdGuardHome -s reload"
if [ -n "$RELOAD_CMD" ]; then
  eval "$RELOAD_CMD"
elif [ "$FORMAT" = "hosts" ]; then
  # dnsmasq re-reads addn-hosts on SIGHUP; harmless if it is not running.
  if pgrep -x dnsmasq >/dev/null 2>&1; then
    kill -HUP "$(pgrep -x dnsmasq | head -1)"
  else
    echo "priv-dns: hosts file updated; set RELOAD_CMD to reload your resolver" >&2
  fi
elif [ "$FORMAT" = "unbound" ]; then
  # SIGHUP is what actually works on OPNsense: unbound-control is disabled by
  # default (control-enable: no), the rc script checks a pidfile OPNsense does
  # not use, and `configctl unbound reload` does not pick up hand-placed
  # include files.
  if check_unbound; then
    pid="$(pgrep -x unbound 2>/dev/null | head -1 || true)"
    if [ -n "$pid" ]; then
      kill -HUP "$pid"
    else
      unbound-control reload >/dev/null 2>&1 \
        || echo "priv-dns: could not reload unbound; data lands on next restart" >&2
    fi
  else
    echo "priv-dns: unbound config invalid after install; NOT reloading" >&2
  fi
fi
# CoreDNS's `reload` plugin re-reads on an SOA serial change by itself, so the
# bind format needs no reload step.

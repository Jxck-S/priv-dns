#!/usr/bin/env bash
#
# Populate a locally running priv-dns with a realistic multi-site zone so the
# dashboard has something to show. Targets the local dev server only.
#
#   npm run dev:local     # in one terminal
#   npm run seed          # in another
#
# Set PRIVDNS_TOKEN if the dev server is running with auth enabled.

set -euo pipefail

BASE="${PRIVDNS_URL:-http://localhost:8787}"
ORIGIN="${ORIGIN:-example.net}"
AUTH=()
[ -n "${PRIVDNS_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $PRIVDNS_TOKEN")

case "$BASE" in
  http://localhost:*|http://127.0.0.1:*) ;;
  *) echo "refusing to seed a non-local target: $BASE" >&2; exit 1 ;;
esac

if ! curl -sf "${AUTH[@]}" "$BASE/health" >/dev/null; then
  echo "no dev server on $BASE - start it with: npm run dev:local" >&2
  exit 1
fi

post() {
  curl -s -o /tmp/privdns-seed.json -w '%{http_code}' \
    -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d "$2" "$1"
}

echo "seeding $ORIGIN on $BASE"

code=$(post "$BASE/api/zones" "{\"origin\":\"$ORIGIN\",\"defaultTtl\":300,\"description\":\"internal\"}")
case "$code" in
  201) echo "  created zone $ORIGIN" ;;
  409) echo "  zone $ORIGIN already exists, adding records to it" ;;
  *)   echo "  failed to create zone (HTTP $code)"; cat /tmp/privdns-seed.json; exit 1 ;;
esac

# A small but representative internal namespace: two sites sharing one flat
# zone, plus the record types you are most likely to actually use.
records=(
  '{"name":"vpn","type":"A","data":{"ip":"10.0.0.1"},"comment":"wireguard endpoint"}'
  '{"name":"nas","type":"A","data":{"ip":"10.10.0.20"},"comment":"home - Synology in the rack"}'
  '{"name":"nas","type":"AAAA","data":{"ip":"fd00:10::20"},"comment":"home - Synology v6"}'
  '{"name":"router","type":"A","data":{"ip":"10.10.0.1"},"comment":"home - UDM"}'
  '{"name":"printer","type":"A","data":{"ip":"10.10.0.30"},"comment":"home - the one that jams"}'
  '{"name":"pad-nas","type":"A","data":{"ip":"10.20.0.20"},"comment":"pad - backup target"}'
  '{"name":"pad-router","type":"A","data":{"ip":"10.20.0.1"},"comment":"pad - edge router"}'
  '{"name":"git","type":"A","data":{"ip":"10.10.0.40"},"comment":"forgejo"}'
  '{"name":"www","type":"CNAME","data":{"target":"nas"},"comment":"shared drive UI"}'
  '{"name":"backup","type":"CNAME","data":{"target":"pad-nas"},"comment":"offsite target"}'
  '{"name":"*.lab","type":"A","data":{"ip":"10.10.9.9"},"comment":"catch-all for lab VMs"}'
  '{"name":"mail","type":"MX","data":{"preference":10,"exchange":"nas"},"comment":"internal relay"}'
  '{"name":"_sip._tcp","type":"SRV","data":{"priority":10,"weight":5,"port":5060,"target":"pbx"},"comment":"voip"}'
  '{"name":"@","type":"TXT","data":{"text":"internal zone - managed by priv-dns"}}'
)

added=0
for record in "${records[@]}"; do
  code=$(post "$BASE/api/zones/$ORIGIN/records" "$record")
  name=$(printf '%s' "$record" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
  type=$(printf '%s' "$record" | sed -n 's/.*"type":"\([^"]*\)".*/\1/p')
  case "$code" in
    201) added=$((added + 1)) ;;
    409) echo "  skip $name $type (already present)" ;;
    *)   echo "  FAIL $name $type (HTTP $code): $(cat /tmp/privdns-seed.json)" ;;
  esac
done

rm -f /tmp/privdns-seed.json
echo "  added $added records"
echo
echo "dashboard: $BASE/"
echo "zone file: curl -s $BASE/zone/$ORIGIN"

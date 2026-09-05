# API

All endpoints require authentication (except in local dev mode - see below).
Responses are `{ok: true, data}` or
`{ok: false, error: {code, message, details?, requestId}}`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/zones` | list configured zones |
| POST | `/api/zones` | register a zone |
| GET | `/api/zones/:origin` | canonical JSON + `ETag` |
| PUT | `/api/zones/:origin` | bulk replace (requires `If-Match`) |
| GET | `/api/zones/:origin/records` | record list |
| POST | `/api/zones/:origin/records` | add a record |
| PATCH | `/api/zones/:origin/records/:id` | edit a record (partial body allowed) |
| DELETE | `/api/zones/:origin/records/:id` | remove a record |
| GET | `/zone/:origin` | rendered zone; `?format=unbound\|hosts\|bind` (`ETag`, 304) |
| GET | `/` | dashboard |

Writes are guarded by the R2 object etag. Send `If-Match` from a prior `GET` and
a concurrent edit loses with `409` instead of silently overwriting.

Take the etag from the response **body** (`data.etag`), not the `ETag` header.
Cloudflare rewrites a strong ETag to a weak one (`W/"..."`) whenever it
compresses the response, which it does for any client sending
`Accept-Encoding: gzip`. The Worker normalises both forms when comparing, but
the body value is the one that is never rewritten.

`/zone/:origin` exposes your whole internal topology. It is bearer-only, so in
production narrow it further — an Access **service token** per CoreDNS host (so
hosts are revocable individually) or a Cloudflare Tunnel. One shared secret
guarding every site's network map is the weak point worth spending effort on.

## Security

- **Auth**: Access JWT (RS256 verified against the team's published keys, with
  `iss`/`aud`/`exp` checked) or a bearer token compared in constant time. Both
  failures return the same flat `401`.
- **Validation** is reject-by-default. Names, targets and origins are rejected
  outright if they contain whitespace, `;`, `"`, `(`, `)`, `\` or a newline —
  the characters that would break out of a zone-file line. IPv4 rejects
  out-of-range octets and octal-looking leading zeros; IPv6 is parsed and
  re-serialised canonically. **Private ranges are allowed** — this is internal
  DNS, so RFC1918 addresses are the normal case, not an error.
- **Comments** are the one free-text field that reaches the zone file, so they
  are scrubbed rather than trusted: non-printable characters and `;` become
  spaces, capped at 200 chars.
- **Semantics**: no CNAME beside another type, no CNAME at the apex, no exact
  duplicates. Round-robin (same name and type, different values) is allowed.
- **The dashboard** inserts every API value with `textContent`, never
  `innerHTML`, and is served under a CSP that forbids all external resources.
  It is responsive: below 760px the record table becomes one card per record
  (column names carried in `data-label`), the add-record form stacks, and the
  filter takes its own row. Zone metadata lives in the footer rather than the
  header - it is reference detail, not something you navigate by.
- **CORS** is off by default (the UI is same-origin). Setting `CORS_ORIGINS`
  echoes only exact allowlist matches — never `*` with credentials.

---

See also: [Deploying](deploying.md) · [Local development](local-development.md)

# Local development

To poke at this on your laptop with no Cloudflare account, no tokens and no
Access app:

```sh
npm install
cp .dev.vars.example .dev.vars   # contains DEV_NO_AUTH=true
npm run dev:local                # terminal 1 - local R2 simulation
npm run seed                     # terminal 2 - 14 sample records
open http://localhost:8787/
```

`DEV_NO_AUTH=true` skips authentication entirely, so `curl` needs no headers:

```sh
curl -s localhost:8787/api/zones
curl -s localhost:8787/zone/example.net
curl -s -X POST localhost:8787/api/zones/example.net/records \
  -H 'Content-Type: application/json' \
  -d '{"name":"test","type":"A","data":{"ip":"10.0.0.9"},"comment":"scratch"}'
```

**This cannot reach production.** It is gated twice:

1. `DEV_NO_AUTH` lives in `.dev.vars`, which is gitignored and which
   `wrangler deploy` never uploads. A deployed Worker cannot see it unless
   someone deliberately adds it as a secret or a `[vars]` entry.
2. Even then, `isDevNoAuth()` requires the request to have arrived on a
   loopback hostname. A request from the internet cannot satisfy that, and the
   Worker logs a warning if the flag is set while requests arrive elsewhere.

`test/auth.test.ts` covers both gates, including near-miss hostnames like
`localhost.evil.com`.

While it is active the dashboard shows an amber banner, every response carries
`X-Priv-Dns-Dev-No-Auth: true`, `/health` reports `devNoAuth: true`, and edits
are attributed to `dev-local`. **Validation is not relaxed** — the same rejection
rules apply, so dev mode is a fair place to test them.

To exercise the real auth path locally instead, comment out `DEV_NO_AUTH` in
`.dev.vars` and pass `-H "Authorization: Bearer dev-token-abc123"`.

## Development

```sh
npm test          # 48 tests: auth gates, validation, escaping, injection, serials
npm run typecheck
npm run dev       # wrangler dev against real Cloudflare resources
```

The rendered output is deterministic — records are sorted — so two sites at the
same serial produce byte-identical files and any drift shows up in a plain diff.

---

See also: [Deploying](deploying.md) · [API reference](api.md)

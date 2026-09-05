# priv-dns

A control plane for **internal** DNS zones. Records live in Cloudflare R2, a
Cloudflare Worker serves an authenticated API and dashboard for editing them,
and every downstream resolver pulls the zone in whatever shape it reads.

Resolver-agnostic by design: the canonical record set is JSON, and the Worker
renders it on demand as an Unbound include, a hosts file, or an RFC1035 zone
file. Adding a consumer is a renderer, not a redesign.

These zones are never delegated publicly. They are served to on-site resolvers
and VPN clients only.

## Why

### Managed internal DNS is an Enterprise product

Cloudflare's own internal DNS is gated behind Enterprise. If you want private
names resolved from a hosted control plane, the options are an Enterprise
contract or running the control plane yourself. This is the second one: R2 for
storage, a Worker for the API, and about 90 KB of code. It runs comfortably
inside Cloudflare's free tier.

### Flat, first-level names

The usual workaround for multi-site DNS is to give every site its own
subdomain — `nas.siteA.example.net`, `nas.siteB.example.net` — so each site's
resolver can own its own subtree without colliding. It works, but it taxes
every name you ever type, and it forces a naming decision on hosts that have
nothing to do with where they happen to live.

Here the flat level is the shared level. `nas.example.net`, `git.example.net`,
`vault.example.net` — one name each, resolvable identically from every site, no
site label required. A host can move between sites without being renamed.

### No copying host overrides between sites

Without this, a name known to one site has to be *taught* to the others: a host
override in each firewall's resolver, or a conditional forwarder pointing at the
site that owns it. Both mean the same record maintained in N places, drifting
independently, and both mean site B's names stop resolving when site A is
unreachable — even for clients that never needed site A for anything else.

Every resolver here pulls the **whole** zone and answers from its own disk. Add
a record once in the dashboard; it appears everywhere on the next pull. Nothing
is copied by hand, and a site that loses its WAN link keeps resolving every
name it already has — it just stops receiving updates until the link returns.

### It composes with per-site delegation

This is not either/or. Keep forwarding `siteA.example.net` from site B to site
A's resolver if you want site-local, dynamic, or DHCP-registered names to stay
site-local — that is exactly the right shape for names that only exist while
you are on that network.

What changes is that the **first level no longer has to work that way**.
Anything at `*.example.net` is served centrally from R2, so it needs no
forwarder, no override, and no dependency on another site being up. Delegated
subtrees and the shared flat namespace sit side by side:

```
example.net                 <- R2, on every resolver, no forwarding
  nas, git, vault, vpn
siteA.example.net           <- forwarded to site A's resolver (DHCP, dynamic)
siteB.example.net           <- forwarded to site B's resolver
```

### One dashboard, one source of truth

Records are edited in one authenticated web UI, not by SSHing into each
firewall and clicking through a different DNS panel per vendor. R2 holds the
canonical JSON; every rendered file is derived from it, so two sites at the
same serial are byte-identical and drift is a `diff` away.

### No site is the master

```
                 ┌──────────────── Cloudflare ────────────────┐
  browser ──SSO──▶ Access ──▶ Worker ──▶ R2 bucket  DNS_ZONES │
  (dashboard)                  │          zones/index.json    │
                               │          zones/<zone>.json   │
  resolver ─────Bearer─────────┘          zones/<zone>.zone   │
    sync loop (pull, ETag)     └── optional webhook push ─────┘
```

R2 is the only source of truth and no resolver is authoritative over another.
Adding a site is: point its resolver at the sync script with a token, and it
inherits the full namespace immediately.

Nothing is hardcoded to a particular domain — zones are configuration in R2, so
one deployment serves as many domains and reverse zones as you like.

## Conventions

- **Flat namespace.** `nas.example.net`, `pad-nas.example.net`. Uniqueness
  is a naming convention; the duplicate check catches collisions at write time.
- **One answer everywhere.** No per-site views. The rendered file is
  byte-identical on every resolver, so drift is a `diff` away.
- **Comments** are first-class. With a flat namespace, the comment is how you
  remember what `pad-nas` actually is.

## Supported consumers

The Worker renders the same canonical zone in three shapes. Pick the one your
resolver reads:

| `FORMAT` | Output | Semantics | Consumers |
|---|---|---|---|
| `unbound` | `local-data` include | **additive** | Unbound, OPNsense, pfSense |
| `hosts` | `IP name` lines | **additive** | dnsmasq, Pi-hole, AdGuard Home, `/etc/hosts` |
| `bind` | RFC1035 zone file | **authoritative** | CoreDNS, BIND, NSD, Knot, PowerDNS |

The distinction that matters is **additive vs authoritative**, not the file
format:

- **Additive** overlays answer for the names they contain and fall through to
  normal recursion for everything else. A public name in the same zone keeps
  working without being mirrored.
- **Authoritative** zone files answer `NXDOMAIN` for anything absent. The zone
  must therefore be a *complete* view of the namespace for its clients -
  including any public names those clients need.

If your internal zone shares a domain with public records, prefer an additive
format. Choosing `bind` there means every public name in that domain becomes
unreachable from inside unless you mirror it - a failure that looks like a
broken resolver rather than a config choice.

`hosts` can only express addresses, so CNAMEs are flattened to the address they
ultimately point at, and anything with no equivalent (MX, SRV, TXT, wildcards)
is listed in a trailing comment rather than dropped silently.

Anything not listed works too, as long as it reads one of these formats from a
file - set `RELOAD_CMD` to whatever reloads it.

## Documentation

| | |
|---|---|
| [Deploying](docs/deploying.md) | Cloudflare setup, Access, service tokens, and wiring up each resolver |
| [API reference](docs/api.md) | Endpoints, concurrency, and the security model |
| [Local development](docs/local-development.md) | Running it on your laptop with no Cloudflare account |

## Quick start

```sh
npm install
cp .dev.vars.example .dev.vars     # contains DEV_NO_AUTH=true
npm run dev:local                  # terminal 1 - local R2 simulation
npm run seed                       # terminal 2 - sample records
open http://localhost:8787/
```

No Cloudflare account, no tokens, no Access app required. See
[Local development](docs/local-development.md) for detail.

## License

MIT - see [LICENSE](LICENSE).

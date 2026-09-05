# Deploying

Prerequisites: a Cloudflare account, a domain already on it (any plan; Access
works on the free tier), and `npx wrangler login`.

There is a deliberate chicken-and-egg here: Access can only protect a hostname
that already serves something, but the Worker needs the Access app's audience
tag to verify tokens. So you deploy twice — first token-only, then again once
Access exists.

## 1. Create the bucket

```sh
npx wrangler r2 bucket create priv-dns-zones
```

Then in the dashboard (R2 → priv-dns-zones → Settings) enable **object
versioning**. A bad write is then recoverable, which matters when the object in
question is every internal name you have.

## 2. Set the route

The Worker must answer on a real hostname — Access policies attach to hostnames,
not to Workers. Uncomment the route block in `wrangler.toml` and set your own:

```toml
[[routes]]
pattern = "dns-cp.example.net"
custom_domain = true
```

`workers_dev = false` is already set, so the `*.workers.dev` URL is not created.
That closes the usual bypass: a Worker reachable on workers.dev is reachable
without passing through the Access policy on your hostname.

## 3. Generate the API token

```sh
openssl rand -base64 32 | npx wrangler secret put API_TOKEN
openssl rand -base64 32 | npx wrangler secret put NOTIFY_SECRET   # only if using push
```

Save the `API_TOKEN` value in your password manager as you generate it —
`wrangler` will not show it again, and each resolver host needs it.

## 4. First deploy (token-only)

Leave `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` empty for now, but set:

```toml
ALLOWED_HOSTS = "dns-cp.example.net"
```

```sh
npm test && npx wrangler deploy
curl -s https://dns-cp.example.net/health          # {"status":"ok","devNoAuth":false}
curl -s https://dns-cp.example.net/api/zones       # 401
curl -s -H "Authorization: Bearer $API_TOKEN" https://dns-cp.example.net/api/zones
```

At this point the API works and the dashboard is reachable by anyone holding the
token. Do not stop here — go to step 5.

## 5. Put Access in front of it

In **Zero Trust → Access → Applications**, add a self-hosted application:

- Domain `dns-cp.example.net`
- A policy allowing your own email (Action: Allow, Include: Emails → yours)
- Copy the **Application Audience (AUD) tag** from the app's Overview tab

Then fill both values in `wrangler.toml` and redeploy:

```toml
ACCESS_TEAM_DOMAIN = "yourteam.cloudflareaccess.com"
ACCESS_AUD = "<the AUD tag>"
```

```sh
npx wrangler deploy
```

Verify in a logged-out browser: `https://dns-cp.example.net/` should bounce
to the Access login, not render the dashboard.

The Worker verifies the Access JWT signature itself rather than trusting the
`Cf-Access-Authenticated-User-Email` header, so this holds even if the Worker is
somehow reached off the Access-fronted path.

## 6. Issue a service token per resolver host

**This step is required, not optional.** Once an Access application covers the
hostname, Access sits in front of *every* path — including `/api/*` and
`/zone/*`. A bearer token alone now gets a `302` to the SSO login and never
reaches the Worker at all, so the pull loop cannot authenticate without
a service token.

In **Zero Trust → Access → Service Auth**, create one token per host, then add a
second policy on the application with Action **Service Auth** and Include →
Service Token → those tokens. Hosts send `CF-Access-Client-Id` /
`CF-Access-Client-Secret`; Access admits them, and the Worker verifies the
resulting JWT exactly as it does a human login.

Each host having its own token is what makes a single machine revocable without
touching the others. Writes are attributed to `service-token:<client-id>` in
`updatedBy`, so the audit trail names the host.

`API_TOKEN` remains configured and is what the Worker checks if the Access app
is ever removed, plus local development. It is not usable from outside while
Access is in front.

## 7. Create your zones

```sh
export CP=https://dns-cp.example.net
export TOKEN=<API_TOKEN>

curl -X POST "$CP/api/zones" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"origin":"example.net","defaultTtl":300}'

# Reverse zones work identically:
curl -X POST "$CP/api/zones" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"origin":"10.in-addr.arpa"}'
```

Then add records through the dashboard at `$CP/`.

## 8. Point each resolver at it

There are two ways to consume the zone, and the choice matters more than it
looks:

| | `FORMAT=unbound` | `FORMAT=bind` |
|---|---|---|
| Semantics | **additive** | **authoritative** |
| Name not in the zone | falls through to public DNS | NXDOMAIN |
| Must mirror public records | no | yes |
| Engine | Unbound `local-data`, hosts file | CoreDNS/NSD/BIND `file` |

Prefer **unbound** for split-horizon. If an internal resolver is authoritative
for `example.net`, it answers NXDOMAIN for every public name in that zone -
including the control plane's own hostname, which locks you out of the
dashboard from inside your own network. The additive form has no such failure
mode: it answers for what it has and asks upstream for everything else.

Use **bind** only when the zone is a complete view of the namespace for its
clients.

### Unbound (OPNsense and similar)

```sh
install -m 0755 scripts/zone-sync.sh /usr/local/bin/priv-dns-sync.sh
cat > /usr/local/etc/priv-dns.env <<'EOF'
PRIVDNS_URL=https://dns-cp.example.net
ZONES=example.net
FORMAT=unbound
ZONE_DIR=/var/unbound/etc                        # what Unbound actually reads
PERSIST_DIR=/usr/local/etc/unbound.opnsense.d    # survives a GUI apply
STATE_DIR=/var/db/priv-dns
CF_ACCESS_CLIENT_ID=...
CF_ACCESS_CLIENT_SECRET=...
EOF
chmod 0600 /usr/local/etc/priv-dns.env
```

Both directories matter. Unbound runs chrooted and reads `/var/unbound/etc`;
the platform's own include directory is what survives a reconfigure and gets
copied back in. Writing only the latter means the change never goes live;
writing only the former means it is silently reverted by the next GUI apply.

The script validates with `unbound-checkconf` before committing and rolls back
if the config would not parse - a syntax error in an included file stops
Unbound from starting, which takes DNS down for the whole site. It reloads with
`SIGHUP`, because on OPNsense `unbound-control` is disabled by default, the rc
script checks a pidfile that is not used, and `configctl unbound reload` does
not pick up hand-placed includes.

Cron entry (`/etc/crontab`):

```
*/5 * * * * root . /usr/local/etc/priv-dns.env 2>/dev/null; export PRIVDNS_URL ZONES FORMAT ZONE_DIR PERSIST_DIR STATE_DIR CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET; /usr/local/bin/priv-dns-sync.sh
```

### Platform notes: OPNsense and pfSense

Both run Unbound, but they differ in two ways that matter. There is no
installer in this repo - these are deliberate manual steps, because getting
them wrong changes firewall configuration.

| | OPNsense | pfSense |
|---|---|---|
| Include | `/var/unbound/etc/*.conf` is globbed automatically | **needs an explicit `include:`** |
| Persistent copy | `/usr/local/etc/unbound.opnsense.d` (copied into the chroot on apply) | not applicable |
| Cron | `/etc/crontab` - a base file, replaced by firmware upgrades | `config.xml` - survives upgrades and backups |
| Reload | `SIGHUP`; `unbound-control` is disabled by default | same |

**On pfSense, add the include first.** Services → DNS Resolver → Custom
options:

```
server:
include: /var/unbound/priv-dns/*.conf
```

Without it the sync writes files Unbound never reads. Nothing errors; DNS
simply never changes, which is a genuinely unpleasant thing to debug.

Then set `ZONE_DIR=/var/unbound/priv-dns` in the env file, and add the cron job
through Services → Cron (it is stored in `config.xml`, so it survives upgrades).

**On OPNsense** the chroot directory is already globbed, so set
`ZONE_DIR=/var/unbound/etc` and `PERSIST_DIR=/usr/local/etc/unbound.opnsense.d`
- the first is what Unbound reads now, the second is what survives a GUI apply.
Writing only one of them either never takes effect or is silently reverted.

Its cron entry lives in `/etc/crontab`, which firmware upgrades replace, so
re-add it after upgrading. Nothing on OPNsense is stored in `config.xml`, so
none of this appears in a configuration backup - worth a note in your runbook.

### dnsmasq, Pi-hole, AdGuard Home (hosts file)

```sh
install -m 0755 scripts/zone-sync.sh /usr/local/bin/priv-dns-sync.sh
cat > /usr/local/etc/priv-dns.env <<'EOF'
PRIVDNS_URL=https://dns-cp.example.net
ZONES=example.net
FORMAT=hosts
ZONE_DIR=/etc/priv-dns
CF_ACCESS_CLIENT_ID=...
CF_ACCESS_CLIENT_SECRET=...
EOF
```

Point your resolver at the generated file and reload it:

```
# dnsmasq
addn-hosts=/etc/priv-dns/priv-dns-example.net.hosts
```

The script sends `SIGHUP` to dnsmasq automatically. For anything else set
`RELOAD_CMD`, e.g. `RELOAD_CMD="pihole restartdns reload"`.

Remember this format is additive and address-only: CNAMEs are flattened, and
MX/SRV/TXT records cannot be carried. Check the trailing comment block in the
generated file to see what was left out.

### CoreDNS, BIND, NSD and other authoritative servers

Install the sync script and give it a token:

```sh
sudo install -m 0755 scripts/zone-sync.sh /usr/local/bin/priv-dns-sync.sh
sudo install -d -o coredns -g coredns /var/lib/coredns
printf 'PRIVDNS_URL=https://dns-cp.example.net\nPRIVDNS_TOKEN=...\nZONES=example.net 10.in-addr.arpa\n' \
  | sudo tee /etc/priv-dns.env >/dev/null
sudo chmod 0600 /etc/priv-dns.env
```

`/etc/systemd/system/priv-dns-sync.service`:

```ini
[Unit]
Description=Pull DNS zones from priv-dns
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/priv-dns.env
ExecStart=/usr/local/bin/priv-dns-sync.sh
```

`/etc/systemd/system/priv-dns-sync.timer`:

```ini
[Unit]
Description=Pull DNS zones from priv-dns every 5 minutes

[Timer]
OnBootSec=30s
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now priv-dns-sync.timer
sudo systemctl start priv-dns-sync.service   # run once now
journalctl -u priv-dns-sync -n 20
```

Corefile:

```
example.net {
    file /var/lib/coredns/example.net.zone
    reload 30s
    log
}

10.in-addr.arpa {
    file /var/lib/coredns/10.in-addr.arpa.zone
    reload 30s
}

. {
    forward . 1.1.1.1 9.9.9.9
    cache
}
```

Repeat on every site. Each host ends up with a full copy of every zone, which is
the whole point — no site depends on another to resolve.

## 9. Verify it actually works

```sh
# On one host
dig @localhost nas.example.net +short

# Edit a record in the dashboard, wait for the timer, then confirm it landed
dig @localhost nas.example.net +short

# Two sites must be byte-identical
ssh site-a 'md5sum /var/lib/coredns/example.net.zone'
ssh site-b 'md5sum /var/lib/coredns/example.net.zone'

# The failure mode that matters: pull the WAN on one site, confirm it still
# answers for OTHER sites' names from its on-disk copy
dig @localhost pad-nas.example.net +short
```

Last, point your clients (DHCP option 6, or the VPN's pushed DNS) at these
resolvers.

---

See also: [API reference](api.md) · [Local development](local-development.md)

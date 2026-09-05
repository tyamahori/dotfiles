---
name: orbstack-dev
description: Load when working in a Dockerized project on this machine, debugging a container-only failure, or when a *.local domain 404s or stops resolving. OrbStack gotchas.
---

# orbstack-dev

Containers on this machine run under OrbStack. These are the failures that
recur.

## node_modules ping-pong

In projects that bind-mount `node_modules` between host and container, running
the package manager from **both** sides destroys the install each time: the
store directories differ, so each side rebuilds `node_modules` from scratch and
breaks the other.

Run installs on whichever side the project designates, and only there.

## Container-only build failures

If a build fails inside the container but succeeds on the host, suspect an
environment difference first — architecture, Node/PHP version, native module,
missing system package — not a code bug. Compare the two environments before
editing code.

## `*.local` domains stop resolving

OrbStack registers dev domains from the `dev.orbstack.domains` label. That
registration can drop while every container still reports healthy — commonly
after an OrbStack daemon restart or after the machine sleeps.

Diagnose:

```sh
dscacheutil -q host -a name <domain>   # empty output = not registered
dns-sd -Q <domain> A                   # "No Such Record" = registration lost
```

Fix by restarting the container that serves the domain:

```sh
docker restart <container>
```

This is a registration problem, not a DNS config or `/etc/hosts` problem — do
not start editing resolver settings.

---
name: orbstack-dev
description: Use for OrbStack machines, Dockerfiles/builds, Docker Compose development, container networking/storage, or container-only failures. Choose native Docker/Compose features and diagnose OrbStack domains; not Kubernetes or production deployment.
---

# orbstack-dev

Use the project's existing Dockerfile, Compose files, scripts, and lockfiles.
Do not add another runtime, proxy, watcher, or wait script when the existing
platform covers the requirement. References below are official documentation;
check installed CLI help before using a version-dependent option.

## Establish the target before changing anything

```sh
orb version                 # on the OrbStack Mac host; skip on plain Linux
docker version
docker context show
docker context ls
docker compose version
docker buildx ls
```

Inspect `DOCKER_HOST`, `DOCKER_CONTEXT`, `COMPOSE_FILE`, and
`COMPOSE_PROJECT_NAME` without dumping the whole environment. `DOCKER_CONTEXT`
overrides `DOCKER_HOST` and the saved context; explicit CLI flags take
precedence. Use `docker --context <name> …` for an operation rather than
silently changing the user's default with `docker context use`.

On macOS, OrbStack's engine normally uses the `orbstack` context. A project's
`devvm` runs its own Docker Engine **inside the Linux machine**; do not run
that project's containers on the Mac engine instead. On a remote daemon, bind
mount paths refer to the daemon host, not the CLI's filesystem.

Docker context (daemon), build context (input files), and Buildx builder
(build backend) are different. A selected custom builder can target a
different engine; inspect it before building.

## Choose the feature

| Need | Use | Boundary |
| --- | --- | --- |
| App and database lifecycle | Existing `docker compose` project | Keep the same `-f`, `-p`, profiles and env-file selection for every command. Give scratch projects/worktrees distinct project names. |
| Linux distro, systemd, or project VM | OrbStack machine; use existing `devvm` workflow in this dotfiles setup | Not a reason to replace an app's Compose stack. Read the repo's `README.md` → OrbStack VM before provisioning. |
| Edit source on the host | Bind mount, or Compose Watch when selective sync/rebuild is needed | Do not sync host native dependencies into Linux. |
| Persist database/container-owned data | Named volume | Removing a container is not removing its volume. |
| Reach another service | Service DNS name and container port on the Compose network | No published port is needed; `localhost` inside a container is itself. |
| Reach a Mac service from OrbStack containers | `host.docker.internal` | Generic Linux Engine needs its own host-gateway setup; a VM/remote daemon's host is not necessarily the Mac. |
| Reach a web service from the Mac | OrbStack domain and automatic HTTPS | Applies to OrbStack-managed containers; do not assume nested VM Docker gets the same domain/proxy integration. |
| Publish a local-only port | Explicit loopback binding, e.g. `127.0.0.1:8080:80` | Omitted host address publishes broadly. OrbStack also has an “Expose ports to LAN” setting. |

Host networking is supported by OrbStack, but removes network isolation and
ignores published-port mappings. Do not use it as a generic DNS fix or apply
Docker Desktop-specific enablement instructions to OrbStack.

## Compose: validate, start, inspect, then change

Run from the intended project with its actual file/override selection:

```sh
docker compose config --quiet
docker compose config --services
docker compose up --wait --wait-timeout 120
docker compose ps --all
docker compose logs --no-color --since 10m --tail 200 <service>
```

`config --quiet` validates without dumping resolved values. Full `config`,
`config --environment`, logs, and unfiltered `inspect` can expose secrets;
scope fields and redact before sharing. `.env` supplies interpolation, not
automatic injection into every service. Require mandatory inputs with
`${VAR:?message}`; use `$$` when the container, not Compose, must expand `$`.

`up --wait` implies detached mode. It waits for **healthy** when a healthcheck
exists, otherwise merely **running**. Use an application-relevant healthcheck
and `depends_on` with `condition: service_healthy` for readiness, or
`service_completed_successfully` for a one-shot prerequisite. Startup order
alone is not readiness. `depends_on.<service>.restart: true` follows explicit
Compose operations, not every runtime crash/restart.

| Intent | Command / behavior |
| --- | --- |
| Restart the same configuration | `docker compose restart <service>`; does not apply changed environment or Compose settings. |
| Apply config/image changes | `docker compose up -d <service>`; add `--build` for changed build inputs. Do not force-recreate everything by default. |
| Run in an existing container | `docker compose exec -T --interactive=false <service> <command>` for unattended commands needing no stdin. |
| Run a one-off task | `docker compose run --rm -T <service> <command>`; creates a new container, may start dependencies, shares configured volumes, and does not publish service ports by default. |
| Optional debug/admin tools | `profiles`; explicitly targeting a service runs it without enabling every service in that profile. Keep core services unprofiled. |
| Stop / tear down | `stop` keeps containers; `down` removes project containers/networks but normally preserves named volumes. |

`down -v` deletes declared named volumes and attached anonymous volumes;
never make it routine cleanup. Anonymous volumes left by ordinary `down` are
not automatically reused by the next `up`. `run --rm` is not data isolation.
Ask before deleting user data or removing orphans.

### Development sync and multiple files

- Keep simple working bind mounts. For `develop.watch`, choose `sync` for
  hot-reloaded source, `rebuild` for dependency/build inputs, and
  `sync+restart` for configuration requiring restart. Run `docker compose up
  --watch`, or `docker compose watch --no-up` for an already-started project.
  Avoid watching a path already covered by a bind mount. Exclude
  `node_modules` and other platform-specific artifacts; targets must be
  writable and the image must provide `stat`, `mkdir`, and `rmdir`.
- Watch requires Compose 2.22+, `sync+restart` 2.23+. Check both local and CI
  versions; a newer local binary does not establish project compatibility.
- Use ordered `-f` overrides for variations of one application. Relative
  paths are based on the first file, and sequences such as ports can merge
  rather than replace: inspect the resolved model before starting it.
  `!override` (2.24.4+) replaces a value; `!reset` removes it.
- Use `include` (2.20+) only for independently maintained subprojects whose
  paths should resolve relative to their own files. Do not modularize a
  small Compose file merely because the feature exists.
- Follow this repo's long/mapping syntax for ports, mounts, dependencies,
  environment and build. Do not add obsolete top-level `version`.

## Docker builds and storage

BuildKit is already the Linux build backend; a new custom builder is not
required to enable it. Keep the existing builder for ordinary local builds.
`docker build` defaults to the engine builder; `docker buildx build` honors
the selected builder. For a custom builder, choose output deliberately:
`--load` for a local runnable image when supported, `--push` only with
publication authorization. A successful cache-only build is not a local image.

- Order layers around stable dependency manifests, limit the build context
  with `.dockerignore`, and use `RUN --mount=type=cache` for package downloads.
  Use external cache for ephemeral/shared builders, not automatically.
- Use multi-stage builds to keep build tools out of the runtime image.
  An independent test stage is not run unless the selected target depends on
  it or it is built explicitly.
- Build credentials belong in BuildKit secret or SSH mounts, never Dockerfile
  `ARG`/`ENV` or copied layers. Mounts do not stop a command from logging or
  copying secrets. Rotating a secret does not itself invalidate the cache.
- Runtime Compose secrets grant files to selected services; they are not an
  encrypted vault. The application must read the file; `*_FILE` works only
  for images that implement it. Do not commit secret source files.
- Prefer native architecture. Use `--platform linux/amd64` only for an actual
  target requirement; do not globally force emulation to hide build failures.
- Prefer explicit bind mounts, read-only where possible. For runtime
  `docker run --mount`, a missing source fails instead of silently creating
  a directory as `-v` can. Mounts can hide files baked into an image.

For host/container install conflicts, keep package-manager installs on the
side the project designates. Sharing `node_modules` between macOS and Linux
can invalidate stores/native modules; use the project's container-owned
dependency volume or in-image install rather than alternating installers.
For container-only failures, compare architecture, runtime versions, native
modules, mounts, permissions and system packages before editing app code.

## OrbStack domains: distinguish DNS, routing, and TLS

Default domains are `<container>.orb.local` or
`<service>.<project>.orb.local`. Custom names use `dev.orbstack.domains`
(only `.local`); an explicit `dev.orbstack.http-port` selects the backend
port when automatic detection picks incorrectly. Prefer native HTTPS before
adding another proxy or certificate tool. The app must listen on a
container-reachable address, not only its loopback.

Start with bounded probes; substitute the actual hostname:

```sh
dscacheutil -q host -a name <domain>
curl -v --max-time 10 https://<domain>/
```

- **Name lookup fails:** check the container, project name, domain labels and
  “Allow access to container domains & IPs” in OrbStack Network settings.
  Empty resolver output is a symptom, not proof that registration was lost.
- **Name resolves but connection fails:** inspect the listening address/port,
  container state and proxy target. Compare direct HTTP with the actual port
  against HTTPS on the domain; failure on port 80 alone is not DNS failure.
- **HTTP 404:** a server answered. Inspect the route, Host header, app base URL
  and proxy target; do not treat this as missing DNS.
- **TLS failure:** inspect certificate/CA trust and the actual client.
  OrbStack supplies HTTPS and normally injects its CA into containers
  (`dev.orbstack.add-ca-certificates=false` opts out). Do not disable TLS
  verification as the fix or silently approve certificate installation.

Lost registration after sleep/restart is only one hypothesis. If evidence
supports it, restart only the affected service, with interruption approval
when needed. Apply changed labels with `compose up -d`, not `restart`.
Do not edit `/etc/hosts`, reset OrbStack, or restart every project speculatively.
`dns-sd -Q` is a streaming diagnostic: bound it or stop it explicitly.

## Machines, isolation, and safe recovery

For new machines in this environment, preserve the local policy:

```sh
orb create --isolated --isolate-network ubuntu:24.04 <machine>
orb -m <machine> uname -a
```

Use existing `devvm`/cloud-init automation for project environments.
`--isolated` disables normal host filesystem/integration access;
`--isolate-network` additionally blocks other machines and host IPs while
keeping internet. Add `--forward-ssh-agent` or selective `--mount` only for
an explicit need: they grant access to credentials or host files.
Changing machine isolation settings requires restarting the running machine.
OrbStack machines share a kernel; use a separate-kernel VM for actively
malicious code. Do not promise a hard sandbox from machine isolation.

Inspect `docker system df -v` and the intended builder's `docker buildx du`
before proposing disk cleanup. Never default to global `prune`, `down -v`,
`orb reset`, or engine restarts. `orb logs docker` diagnoses engine problems;
`orb debug <container>` can inspect minimal/read-only containers without
adding tools to their image, but requires OrbStack Pro.

Verify a change through the consumer path (HTTP response, command exit code,
data persistence), not merely a “running” container. Use a uniquely named
scratch project for probes; remove only its owned containers, network and
volumes afterward. Do not test destructive recovery against existing data.

## Official references

- OrbStack: [Docker](https://docs.orbstack.dev/docker/),
  [networking](https://docs.orbstack.dev/docker/network),
  [domains](https://docs.orbstack.dev/docker/domains),
  [HTTPS](https://docs.orbstack.dev/features/https),
  [isolated machines](https://docs.orbstack.dev/machines/isolated),
  [machine commands](https://docs.orbstack.dev/machines/commands).
- Docker: [CLI/context overrides](https://docs.docker.com/reference/cli/docker/#environment-variables),
  [builders](https://docs.docker.com/build/builders/),
  [cache](https://docs.docker.com/build/cache/optimize/),
  [build secrets](https://docs.docker.com/build/building/secrets/),
  [multi-stage](https://docs.docker.com/build/building/multi-stage/),
  [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/),
  [volumes](https://docs.docker.com/engine/storage/volumes/),
  [published ports](https://docs.docker.com/engine/network/port-publishing/).
- Compose: [up](https://docs.docker.com/reference/cli/docker/compose/up/),
  [startup order](https://docs.docker.com/compose/how-tos/startup-order/),
  [Watch](https://docs.docker.com/compose/how-tos/file-watch/),
  [develop version gates](https://docs.docker.com/reference/compose-file/develop/),
  [profiles](https://docs.docker.com/compose/how-tos/profiles/),
  [merge](https://docs.docker.com/reference/compose-file/merge/),
  [include](https://docs.docker.com/reference/compose-file/include/),
  [runtime secrets](https://docs.docker.com/compose/how-tos/use-secrets/),
  [down](https://docs.docker.com/reference/cli/docker/compose/down/).

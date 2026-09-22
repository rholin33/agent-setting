---
name: compose-start
description: Explicitly start and reconcile the current project's Docker Compose stack, discover its services and dependencies, and rebuild or restart services when required. Invoke with $compose-start.
---

# Compose Startup and Reconciliation

Explicit invocation authorizes starting the selected project's services and applying necessary application rebuilds or restarts. Discover the deployment from the current repository and running containers; do not assume paths, project names, service names, ports, middleware, or development versus production mode.

## Discover the Deployment

1. Read applicable project instructions and maintained startup/deployment documentation. Find Compose files, Dockerfiles, environment-file examples, package/task scripts, and wrapper commands. Prefer the project's established startup command.
2. Determine the effective Compose invocation: working/project directory, ordered `-f` files, project name, environment files, and profiles. Respect user-specified choices. Avoid combining every discovered override: development, production, testing, and GPU files may be mutually exclusive.
3. Inspect existing Compose projects and containers, including labels `com.docker.compose.project`, `com.docker.compose.project.working_dir`, `com.docker.compose.project.config_files`, and `com.docker.compose.service`. Match them to this repository. Reuse the correct project identity so existing volumes, networks, and containers remain associated. Do not adopt a project merely because its name matches the directory basename.
4. If multiple plausible deployments cannot be distinguished from instructions or running state, ask one concise question about the desired deployment. Continue independent inspection while awaiting the answer.
5. Resolve service names, build contexts, images, dependencies, profiles, published ports, health checks, volumes, networks, and external resources from the effective Compose model. Treat external databases or APIs as external; do not install substitutes or switch persistence modes.
6. Check Docker daemon and Compose availability. A missing/stopped daemon is a prerequisite issue. Start an installed desktop daemon only when appropriate to the platform and authorized startup workflow; launch Windows helpers hidden. Wait at most 120 seconds for readiness.

## Inspect Without Exposing Secrets

Use the discovered Compose arguments consistently for every operation.

- Run `docker compose <args> config --quiet` to validate interpolation and syntax.
- Use `config --services`, `config --profiles`, and `ps --all --format json` for targeted inventory.
- When structured effective configuration or container inspection is necessary, parse it in memory and emit only required non-secret fields. Do not print full interpolated config, environment files, credential-bearing URLs, or complete container environments.
- Inspect host-port ownership before creating services. Identify the owning project or process; do not stop unrelated listeners. Do not silently replace established ports.
- An explicit startup request includes the normal application stack and its declared middleware dependencies. Do not activate every profile or execute maintenance, migration, seed, destructive, or one-shot services merely because they are present. Follow the documented default profile and dependency graph.
- If startup includes schema migration or another separately controlled operation, apply the repository's authorization requirements before that operation.

## Decide What Needs Updating

| Evidence | Action |
|---|---|
| Service is absent | Create it with the effective Compose configuration |
| Existing service is stopped and current | Start it, or reconcile with `up` if configuration may have changed |
| Service is healthy and proven current | Leave it running |
| Baked-in source, build arguments, Dockerfile, dependencies, or copied assets changed | Build the affected service, then reconcile its container |
| Environment, command, port, mount, network, or other effective container configuration changed | Recreate the affected container with `up`; `restart` does not apply these changes |
| Built image differs from running container image | Reconcile the affected service |
| Bind-mounted source changed | Determine whether the existing development process hot-reloads it; restart only if required |
| Health fails with unchanged code/config | Inspect the service and dependencies; attempt one targeted restart when evidence supports it |
| Build currentness cannot be established | Use a cached build for local build services, then let Compose reconcile |

Git status and container uptime do not establish image currentness. Build inputs can live outside a service directory, in shared contexts or additional contexts. Use the Dockerfiles and effective model to identify them.

For image-only services, use the declared pull policy and the repository's release procedure. Do not automatically pull newer mutable middleware tags or perform upgrades as a side effect of startup. Missing images may be pulled as required by normal startup.

Avoid global `--force-recreate`, `--no-cache`, and blanket restarts. Use targeted force-recreation only when ordinary reconciliation leaves a demonstrably stale container.

## Protect In-Flight Work and Persistence

Before stopping or recreating a working application, inspect its documented readiness/activity endpoints or operational status. Account for background workers, queues, uploads, scheduled work, and model-processing jobs separately from HTTP health.

- Healthy does not mean idle. A completed parent task may still have active child processing.
- When active work is detected, wait for a safe point or use the application's documented graceful drain. Poll at reasonable intervals and keep the user informed. If safe draining cannot be established, ask before interrupting work.
- If the application has no activity introspection, use documented shutdown/drain behavior and configured stop grace periods. Do not assume idleness solely from missing status endpoints.
- Preserve persistent volumes, bind-mounted data, credentials, project identity, and external resource ownership.
- Do not use `down -v`, volume deletion, prune, database reset, orphan removal, or unrelated container/process cleanup.
- Do not edit environment files, Compose files, or infrastructure configuration merely to make health checks pass. Surface required configuration changes for approval under project rules.
- Retain existing application availability if a replacement build fails.

## Execute the Selected Actions

Build required application images before stopping healthy instances. Then apply the smallest necessary reconciliation using the same discovered project/files/env/profiles throughout.

Representative commands, with placeholders replaced from discovery:

```text
docker compose <args> build <changed-build-services>
docker compose <args> up -d <selected-services>
docker compose <args> restart <unchanged-but-unhealthy-service>
```

Use `up` with normal dependency handling when dependencies must start. Use `--no-deps` only after verifying those dependencies are already ready. Keep healthy middleware running unless its own state/configuration requires intervention.

Use Compose `--wait` and a bounded `--wait-timeout` when supported. Otherwise poll container health and application readiness. Account for dependencies that are expected to complete successfully rather than remain running. A running container without a health check still needs a service-specific readiness check.

After replacing a backend, verify its proxy path. Some proxies resolve upstream container addresses only when configuration loads. If a stale upstream is demonstrated, validate and reload/restart only the relevant proxy using its actual configuration. Do not assume every frontend is Nginx.

If part of the application is intentionally managed outside Compose, follow the repository's documented manager. Do not silently migrate standalone containers, local processes, or remote services into Compose.

For transient startup failures, inspect the cause and attempt at most one targeted recovery restart per service. Do not repeat unchanged failed actions. If a concrete fix requires a configuration decision or destructive action, preserve working services and report the blocker.

## Verify the Usable Stack

Verify actual endpoints and dependencies from discovered configuration:

- Selected long-running services are running and health checks pass.
- One-shot dependencies required by the documented startup completed successfully.
- Backend readiness and frontend entry point respond as expected.
- Frontend-to-backend proxy/API routing works; HTML HTTP 200 alone is insufficient.
- Declared local middleware responds using its native readiness probe.
- Existing persistent state remains accessible when a read-only check is available.
- A rebuilt frontend receives a browser smoke check when browser tooling is available; otherwise state the narrower HTTP verification performed.

Never create business tasks, invoke paid external model jobs, send messages, or modify business data as a startup smoke test unless separately requested.

Report usable URLs, selected Compose project/profile, services started/rebuilt/recreated/restarted, verification results, and concrete blockers. Do not claim success from a build or container-start response alone.

This skill reconciles the stack only when explicitly invoked. It does not install a watcher or restart services automatically after every code edit.

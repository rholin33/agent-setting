# Production deployment memory

- deploy owns explicitly authorized production inspection, backup, upgrade, rollback and verification; loader owns local development services.
- Resolve host, user, SSH port, key reference, service root and Compose path from protected local configuration. Never export credentials or machine-specific deployment configuration.
- Historical deployment authorization does not authorize a new deployment. Require an explicit task and a fixed published image tag or digest.
- Inspect runtime reality before mutation; preserve existing credentials, data, ingress and rollback artifacts. Never infer ownership for legacy records.
- Keep backups in restricted locations. Never prune volumes or discard production data. Report failed checks and unresolved limitations accurately.

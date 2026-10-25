# Storage service (Go)

Sign-in (Firebase) and private saved buildings (PostgreSQL). The website renders buildings; this
service saves, lists, loads, replaces and deletes their JSON documents. Optional: without it the site
works and says sign-in isn't available.

How to run it locally: [docs/running-locally.md](../docs/running-locally.md). Its routes:
[docs/storage-service-api.md](../docs/storage-service-api.md). The saved document:
[contracts/STORAGE.md](../contracts/STORAGE.md).

## What's where

| Path | What it is |
|---|---|
| `cmd/api/` | The API server. |
| `cmd/migrate/` | Applies the database migrations. |
| `migrations/` | The SQL migrations, in order. |
| `internal/server/` | Routes, middleware (CORS, limits) and their tests. |
| `internal/auth/` | Checking Firebase sign-in tokens (or the local emulator's). |
| `internal/building/` | Saved buildings: the handlers and the checks on a saved document. |
| `internal/user/` | Users and profiles. |
| `internal/database/` | The Postgres connection and queries. |
| `internal/config/` | Settings from the environment (`.env`). |
| `internal/httpx/` | Small HTTP helpers: JSON replies and errors. |
| `internal/testutil/` | Test helpers (a dedicated test database). |

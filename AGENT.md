# Backend guidance

Scope: Firebase authentication and private JSON building storage in one Go API.
See [BACKEND.md](BACKEND.md) for setup and [docs/api.md](docs/api.md) for routes.

- Leave README.md unchanged unless explicitly requested.
- Store renderer documents as flexible JSONB; keep the marked frontend/module TODOs
  until their interfaces are known. Do not invent a scene schema or add services.
- Derive ownership from the authenticated user and scope every building query to it.
  Client identity/role fields must never grant access.
- Keep applied migrations immutable and preserve existing data. Legacy tables,
  including the unused role column, stay for compatibility with existing databases.
- Emulator mode is local development/test only, with a demo- project and loopback
  addresses. Production must reject it. Never add authentication bypasses.
- Keep credentials, ID tokens, and building documents out of logs/version control.
- Run go vet and go test -race from backend/. Set TEST_DATABASE_URL to a dedicated
  PostgreSQL/PostGIS database to include SQL persistence and ownership tests.
- Keep backend docs aligned with actual routes and report which checks ran.

# Tests

| Command | What it runs | Needs a database |
|---|---|---|
| `npm test` | Unit specs next to the code (`src/**/*.spec.ts`): services, guards, strategies, filter, helpers, controllers. Prisma is a `jest.fn()` mock. | no |
| `npm run test:e2e` | `test/*.e2e-spec.ts`: boots the real `AppModule` with the same prefix, pipes, filter and CORS as production (`configureApp`) and calls it over HTTP with supertest. **Prisma is replaced by mocks.** | no |

## What the e2e suite proves, and what it cannot

It proves the HTTP layer: `/v1` routing, authentication, `403 TENANT_MISMATCH` when a token's tenant differs from the URL, `403 TENANT_SUSPENDED`, the role matrix (`INSUFFICIENT_ROLE`, `OWNER_REQUIRED`, `LAST_OWNER`), error body shape, pagination envelope and limits, request ids, CORS and the OpenAPI document. It also asserts which `where` clause each route sends to Prisma, so a missing `tenantId` shows up as a failing test.

It does **not** run SQL, so unique constraints, foreign keys and migrations are not covered here. The CI job `migrations` (see `.github/workflows/ci.yml`) covers part of that: it applies every migration to a throwaway Postgres and fails when `prisma/schema.prisma` has changes that no migration contains.

### Adding database-backed e2e later
If a real-database suite is wanted (recommended before Phase 3):
1. Start a throwaway Postgres (for example `docker run -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16`) and point `DATABASE_URL` at **that** instance, never at the shared development database.
2. Run `npx prisma migrate deploy` against it.
3. Build the app with `Test.createTestingModule({ imports: [AppModule] })` without overriding `PrismaService`, and truncate the tables between tests.

Never use `prisma migrate reset` or `db push` for this: the development database is shared with the AI engine project.

## Helpers
- `utils/prisma-mock.ts`: `createPrismaMock()` and `prismaError('P2002')` (a real `PrismaClientKnownRequestError`).
- `utils/test-app.ts`: `createTestApp()` returns the app, the Prisma mock and token helpers (`staffToken`, `platformToken`).
- `setup-env.ts`: sets `JWT_SECRET` and friends before `AppModule` is imported (env validation runs at import time).

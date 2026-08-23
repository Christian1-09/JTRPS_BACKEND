# Trip Ticket Backend

Node.js + Express + PostgreSQL (via Prisma) backend for the Trip Ticket app,
serving 4 role-based interfaces (Admin, Head Driver, Driver, Instructor) plus
passenger accounts, all through **one API** with JWT role-based access control.

## Stack
- Node.js + Express
- PostgreSQL 16 (Docker)
- Prisma ORM
- JWT (access + refresh tokens)
- Docker Compose

## 1. Setup

```bash
cp .env.example .env
```

Edit `.env` and change `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` to random strings.

## 2. Run everything with Docker

```bash
docker compose up --build
```

This starts:
- `postgres` on port `5432`
- `api` on port `4000` (auto-runs `prisma migrate deploy` on boot)
- `pgadmin` on port `5050` (optional DB inspector — login with the email/password in docker-compose.yml)

## 3. Create your first migration

The `api` container runs `prisma migrate deploy`, which applies *existing*
migrations but won't generate new ones. The first time you set up the schema
(or whenever you change `prisma/schema.prisma`), generate a migration locally:

```bash
npm install
npx prisma migrate dev --name init
```

This creates the migration files in `prisma/migrations/` and applies them to
your running Postgres container (make sure `docker compose up` is running,
or point DATABASE_URL at localhost when running this outside Docker).

## 4. Explore the database (optional)

```bash
npx prisma studio
```

## API overview

| Method | Endpoint              | Auth              | Description                  |
|--------|------------------------|-------------------|-------------------------------|
| POST   | /api/auth/register     | none              | Create a user with a role     |
| POST   | /api/auth/login        | none              | Returns access + refresh token|
| POST   | /api/auth/refresh      | refresh token     | Returns new access token      |
| POST   | /api/auth/logout       | refresh token     | Invalidates refresh token     |
| GET    | /api/me                | access token      | Returns decoded user identity |
| GET    | /api/admin/dashboard        | ADMIN                        | Example protected route |
| GET    | /api/head-driver/dashboard  | ADMIN, HEAD_DRIVER            | Example protected route |
| GET    | /api/driver/dashboard       | ADMIN, HEAD_DRIVER, DRIVER     | Example protected route |
| GET    | /api/instructor/dashboard   | ADMIN, INSTRUCTOR              | Example protected route |

### Example: register + login

```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@tripticket.com","password":"secret123","fullName":"Admin User","role":"ADMIN"}'

curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@tripticket.com","password":"secret123"}'
```

Use the returned `accessToken` as `Authorization: Bearer <token>` on protected routes.

## Data model (first draft — see prisma/schema.prisma)

- **User** — role: ADMIN | HEAD_DRIVER | DRIVER | INSTRUCTOR | PASSENGER
- **Vehicle** — assigned to a driver
- **Route** — origin/destination
- **Trip** — a scheduled run of a route on a specific vehicle/driver
- **Booking** — a passenger's seat reservation on a trip
- **TrainingRecord** — instructor evaluations of drivers
- **RefreshToken** — persisted refresh tokens (enables logout/revocation)

This is a starting point — adjust fields/relations as your real business
rules (fare pricing, seat maps, driver shift limits, etc.) become clearer.

## Next steps
1. Run the register/login flow and confirm tokens work.
2. Flesh out CRUD routes for Vehicles, Routes, Trips, Bookings (one
   controller/service/route file per resource, same pattern as `auth`).
3. Lock down CORS in `src/app.js` to your actual Flutter web origin(s).
4. Add request validation (e.g. `zod` or `joi`) once routes stabilize.
5. Wire the Flutter app's `LoginScreen`/`RegisterScreen` to `/api/auth/*`,
   and route each interface (Admin/HeadDriver/Driver/Instructor) based on
   the `role` returned from `/api/me`.

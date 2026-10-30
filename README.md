# Banku

Banku is a local learning project for a small banking-style application. It is not a real bank and does not handle real money or financial data.

The project includes a React and TypeScript web app, a Node.js and Express API, PostgreSQL persistence through Prisma, customer and merchant accounts, internal transfers, an append-only double-entry ledger, and a local simulator for three partner banks.

It contains a web app for users, merchant systems, a third party bank simulator, financial security constraints, account manipulation constraints, DB-level constraints.

## Stack

- Node.js 24+ and npm
- React 19, TypeScript, and Vite 8
- Express 5
- PostgreSQL 18
- Prisma 7

Exact package versions are recorded in the root and `frontend` lockfiles.

## Repository layout

```text
src/                    Express API, business modules, database client, workers
frontend/               React application and Vite configuration
chaos-bank/              Local partner-bank simulator; development only
prisma/                  Prisma schema and all database migrations
instructions.md          Project goals and design notes
example_prompts/         Optional UI reference screenshots
```

## Requirements

- Node.js 24 or newer with npm
- PostgreSQL 18 running locally
- A PostgreSQL database named `banku_main`

Create the database in pgAdmin or with `createdb banku_main` if that command is on your PATH.

## First-time setup (PowerShell)

From the repository root, install both applications’ dependencies:

```powershell
npm ci
Set-Location frontend
npm ci
Set-Location ..
```

Create the local environment file and edit it:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `DATABASE_URL` to the local `banku_main` connection. Replace the JWT secret, each bank API key, and each webhook secret with distinct random values. Generate a secret with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Never commit `.env` or share real credentials. `.env.example` contains placeholders only.

Apply migrations, generate Prisma Client, and seed the demo treasury:

```powershell
npx prisma migrate deploy
npx prisma generate
npm run db:seed
```

The seed creates the non-login `Banku_King` system account with `$100,000.00`. A successful signup receives a `$100.00` promotional transfer from that account. Signup requires an adult date of birth and does not currently use email verification. Amounts are stored as integer cents.

## Run locally

Start each process in its own terminal from the repository root, except the frontend command:

```powershell
npm run dev
```

```powershell
npm run dev:bank-simulator
```

```powershell
Set-Location frontend
npm run dev
```

The API listens on `127.0.0.1:3000` by default. The partner simulator listens on `127.0.0.1:4001`. Vite prints its frontend URL and proxies `/api` requests to the API.

`BANK_SIMULATOR_MODE` can simulate `success`, `reject`, `delay`, `http_500`, `duplicate_webhook`, and `out_of_order`. Set it in `.env`, then restart the API and simulator. Simulator payout records are in memory and disappear when it restarts; Banku uses its own database-backed outbox and stops for reconciliation when an earlier send may have happened but the partner lookup returns no record.

Partner outcomes are authenticated and recorded, but a signature proves message origin, not real-world settlement. A disputed or ambiguous payout remains reserved for review. This project does not yet include an operator reconciliation interface or an independent bank-statement feed.

## Database changes

The Prisma schema and migration history live in `prisma/`. For a development schema change, create and review a migration:

```powershell
npx prisma migrate dev --name describe_change
npx prisma generate
```

Apply checked-in migrations with `npx prisma migrate deploy`. The database migration enforces positive transfer and ledger amounts, balanced immutable ledger batches, and ledger currency/reference rules.

## Build and lint

```powershell
npm run build
Set-Location frontend
npm run build
npm run lint
```

An automated test suite is not configured yet.

## Items remaining
Login security and rate limiting
3rd party bank simulator accounts

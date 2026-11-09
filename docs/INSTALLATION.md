# Installation

Install Node.js 24, npm, Git, and PostgreSQL 16. OpenSSL is useful for generating development keys. Android contributors also need JDK 21, Android SDK Platform 36, and an emulator or device.

## PostgreSQL

Provision an instance dedicated to this checkout. This Docker example binds only to loopback. Export a unique disposable password in the shell's `POSTGRES_PASSWORD` variable before running it.

```sh
docker run --rm --name mawared-dev-postgres \
  -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=mawared_dev -e POSTGRES_DB=mawared_dev \
  -e POSTGRES_PASSWORD -d postgres:16
```

For a native installation, create a `mawared_dev` login role and a `mawared_dev` database owned by that role.

## Backend

```sh
cd backend
cp .env.example .env
npm ci
```

Edit `.env` locally. Set both Prisma URLs to your dedicated database. URL-encode password characters when needed. Generate two independent signing secrets with `openssl rand -hex 32` and a fresh MFA key with `openssl rand -base64 32`. Set `MAWARED_DEV_SEED_PASSWORD` to a unique development-only password of 20 to 72 bytes.

```sh
npm run db:migrate
npm run seed
npm run dev
```

The API listens at `http://127.0.0.1:3000`. The seed creates a synthetic `CMP-DEMO` company. Its admin is `admin@demo.example.test` and uses your seed password. Protected accounts can require MFA enrollment. Other sample users receive random passwords and serve as workflow records.

For a separate local platform principal, set `PLATFORM_BOOTSTRAP_EMAIL`, `PLATFORM_BOOTSTRAP_NAME`, and `PLATFORM_BOOTSTRAP_PASSWORD` with unique local values, then run `npm run bootstrap:platform-local`. The platform-principal table must be empty.

## Web

```sh
cd web
cp .env.example .env
npm ci
npm run dev
```

Open the Vite address, normally `http://localhost:5173`. `VITE_API_BASE_URL` is the API origin. Add custom frontend origins to the backend's `CORS_ORIGINS`.

## Android

Open the root project in Android Studio and select `debug`. The default emulator URL is `http://10.0.2.2:3000/`.

```sh
./gradlew :app:assembleDebug :app:testDebugUnitTest
```

On Windows, use `gradlew.bat`. For a reachable HTTPS API, set `-PmawaredApiBaseUrl` to your own HTTPS URL with a trailing slash. Debug cleartext is limited to the local emulator exception. Verified recovery App Links require `-PmawaredRecoveryHost` and Digital Asset Links for the application ID and signing certificate. The default recovery host is a reserved placeholder.

Keep SDK paths and signing credentials outside version control.

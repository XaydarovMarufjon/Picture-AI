# Picture-AI

A NestJS/TypeScript API that crawls website images, sends selected images to
moderation providers, and stores scan results in PostgreSQL through Prisma.
Socket.IO broadcasts progress while a scan is running. This repository contains
the backend, not the dashboard.

## Before starting the application

**Starting the app also enables scheduled scans.**
[cron.service.ts](src/scan/cron.service.ts) scans a hard-coded list of real sites
at the start of every hour (`0 */1 * * *`, server time zone). There is currently
no environment switch to disable the schedule. Do not start the full application
just to run unit tests. Review the targets and obtain permission before enabling
network access or leaving a development instance running. Scans download pages
and images, send image URLs (and sometimes image bytes) to external providers,
and can consume provider quota or incur charges.

Use an isolated development environment and a disposable database. Keep inbound
access restricted externally to trusted clients: the app does not explicitly bind
to loopback and has no authentication or rate-limiting guard. HTTP CORS defaults
to `*`; the Socket.IO gateway separately allows `*` and broadcasts to every
connected client. CORS is not an access-control or SSRF protection mechanism.
The crawler launches Chromium with its sandbox disabled. Do not expose this
application to untrusted scan requests or give its environment access to sensitive
internal services. Read [Known limitations](#known-limitations) before live use.

## Project setup

### Requirements

- Node.js and npm. The lockfile includes dependencies requiring Node >=20.18.1;
  this is a dependency minimum, not a guarantee that all runtime paths work on
  that version. Build and unit checks for this documentation were run on Node
  24.19.0. The repository does not pin Node or npm.
- PostgreSQL for full application startup. Prisma connects during module
  initialization; the schema uses `DATABASE_URL`.
- At least one moderation provider: a Hugging Face token, or both Sightengine
  credentials. Without either, `ModerationService` throws during construction.
- For live crawling, Puppeteer's compatible browser and its OS libraries.
  Dependency installation normally downloads the browser. Skipping that download
  is suitable for build/unit-test work, but does not prepare live crawling.

Install the locked dependencies from the repository root:

```bash
npm ci
```

For build/unit-test-only work without a browser download:

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm ci
```

### Environment

Nest's global `ConfigModule` loads `.env` from the repository root. No `.env`
file is provided. Create one locally, keep it out of Git, and supply only the
credentials for the provider(s) you intend to use. These are placeholders:

```dotenv
DATABASE_URL="postgresql://USER:PASSWORD@127.0.0.1:5432/picture_ai_dev?schema=public"
PORT=3000
CORS_ORIGIN=http://localhost:5173

# Hugging Face option
HF_TOKEN=REPLACE_WITH_YOUR_TOKEN
HF_MODEL=Falconsai/nsfw_image_detection

# Sightengine option (both values required if this provider is used)
# SIGHTENGINE_USER=REPLACE_WITH_YOUR_USER
# SIGHTENGINE_SECRET=REPLACE_WITH_YOUR_SECRET
```

`PORT` defaults to `3000`; `CORS_ORIGIN` defaults to `*` and affects HTTP only.
`HF_MODEL` defaults to `Falconsai/nsfw_image_detection`. Remove `HF_TOKEN` if
using only Sightengine. Never use placeholder credentials for a live scan or
commit real tokens, passwords, or `.env` files.

Provider routing is implemented in
[moderation.service.ts](src/scan/moderation/moderation.service.ts):

- With only Sightengine configured, requests go directly to Sightengine
- When Hugging Face is configured, it runs first; an `nsfw` result is retained
- An empty/error Hugging Face result falls back to Sightengine when configured
- Other Hugging Face results with a score **greater than 0.2** also use
  Sightengine when configured; this is the current rule, not a calibrated
  probability-of-harm threshold

The [Hugging Face adapter](src/scan/moderation/moderators/huggingface.moderator.ts)
tries the image URL and then image bytes on request failure. It targets
`api-inference.huggingface.co`; endpoint/model availability and account access
must be checked separately before live use. The
[Sightengine adapter](src/scan/moderation/moderators/sightengine.moderator.ts)
sends the image URL and requests `nudity,wad,gore`, but its returned label uses
only the nudity score. Provider responses are stored in `ScanItem.raw`.

### Database preparation

Generate the client after dependency installation:

```bash
npx prisma generate
```

For a **new, empty, disposable development database** configured in `.env`,
apply the checked-in migrations:

```bash
npx prisma migrate deploy
```

Review [the migration history](prisma/migrations) before using any existing
database: it contains table drops and required-column additions. Do not point
these commands at production data or use reset commands as a troubleshooting
shortcut. Database creation, PostgreSQL installation, and live migration
execution are not verified by the build/unit checks described here.

## Compile and run the project

Build without starting the server, scheduler, database connection, or crawler:

```bash
npm run build
```

Only after the setup and safety review above, the available server commands are:

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode (requires a successful build first)
$ npm run start:prod
```

The script name `start:prod` does not establish production readiness.

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Validation notes

For a single non-watch unit run, use `npm test -- --runInBand`. The current
unit suites cover the root greeting and construction of `PrismaService`; they
do not start the full application or prove a live scan works.

The current default-branch e2e test imports `AppModule` without isolating its
external dependencies. It is **not** an offline smoke test: once its import
problems are resolved it needs provider/database setup and initializes scheduled
work. On the reviewed default branch, CommonJS Jest fails on the ESM-only
`p-limit` import before tests execute. Full-project `tsc --noEmit` also reports
the namespace Supertest import in that test. Draft
[PR #8](https://github.com/XaydarovMarufjon/Picture-AI/pull/8) proposes an isolated
HTTP integration suite; it is not included here.

`npm run lint` includes `--fix` and can modify source files. For read-only lint:

```bash
npx eslint "{src,apps,libs,test}/**/*.ts"
```

The reviewed baseline has existing lint errors. A passing build or unit run does
not mean the aggregate checks pass, nor does it verify PostgreSQL migrations,
browser launch, provider availability, moderation accuracy, or deployed behavior.

## HTTP API and progress

Routes have no `/api` prefix. See [scan.controller.ts](src/scan/scan.controller.ts)
and [scan.service.ts](src/scan/scan.service.ts) for the current contract.

| Method | Route                   | Behavior                                                                                                                                      |
| ------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                     | Returns `Hello World!`; not a dependency health check                                                                                         |
| POST   | `/scan`                 | JSON body `{ "url": "https://your-authorized-site.example/gallery" }`; waits for the scan, then returns `{ scanId, total, processed, saved }` |
| GET    | `/scan/latest?limit=25` | Newest scans without items; HTTP default limit is 500                                                                                         |
| GET    | `/scan?url=...`         | Exact stored site-URL match, newest first, with items; URL-encode the query value                                                             |
| GET    | `/scan/detail?id=42`    | Scan with items; ID must parse as an integer                                                                                                  |
| GET    | `/scan/42/progress`     | `{ status, total, done }`; ID must parse as an integer                                                                                        |

POST validation uses `IsUrl({ require_tld: true })` and a controller HTTP-prefix
check. There is no background job acknowledgement: the POST remains pending
until scanning finishes or fails. `total` is the number of discovered unique
image URLs, `processed` is the selected image count (at most 200), and `saved`
is the number of moderation results before persistence, **not** a confirmed count
of newly inserted database rows. `limit` is converted to a number without an
explicit positive-integer/range validator.

Listen for the Socket.IO event `scan-progress` on the same server. Stages are
`start`, `crawl`, `filter`, `dedup`, `moderation`, and `finished`. Most payloads
have no scan ID; broadcasts from concurrent scans can interleave. Moderation
progress emits every fifth completed image, not after every image. The HTTP
progress endpoint uses `Scan.progress` as the selected-image total and counts
associated stored items as `done`; it does not return a percentage.

## Known limitations

- The crawler visits up to 20 pages, then filters images by URL substrings and
  HEAD content length (under 5 KiB or missing length is excluded), deduplicates
  downloaded bytes by MD5, ranks URL keywords, and selects at most 200 images.
  It is not an exhaustive website audit. The page-link prefix check is not a
  reliable same-origin boundary; redirects and image hosts also need independent
  network restrictions. See [crawler.service.ts](src/scan/crawler.service.ts).
- `ScanItem.hash` is globally unique. Upserting repeated content updates the old
  record's result/timestamp without changing its `scanId`, `imageUrl`, or
  `provider`. A later scan can therefore have fewer associated items than its
  selected count. See [schema.prisma](prisma/schema.prisma) and `saveResults`.
- A failure after creating a scan can leave it marked `running`; there is no
  general failure-finalization handler. The cron overlap guard is local to one
  service instance, not a distributed lock.
- Current provider parsers can classify malformed/empty responses as `safe`.
  Labels are model outputs, not safety guarantees. Review provider errors and
  raw results rather than treating a finished scan as a clean bill of health.
- There is no authenticated per-user event stream, durable job queue, or
  production deployment configuration in this repository. Open draft fixes and
  tests are proposals, not features available on the default branch.

## License

`package.json` declares this project `UNLICENSED`. The upstream Nest framework's
license does not grant a license to this application's code.

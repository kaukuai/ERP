# ERP development

## Working location

- The owner requests that future implementation run in Codex Cloud against `kaukuai/ERP`, with the repository as the shared source of truth. Read `docs/CLOUD_HANDOFF.md` before continuing.
- Do not depend on the original Windows machine, its local checkout paths, company database, credentials, or backups. Use an isolated cloud checkout and generated test/demo data.
- Confirm the actual execution environment before reporting a migration as completed. GitHub uploads, remote CI, ChatGPT Work, and Codespaces configuration alone do not prove that a Codex coding task is running in a published cloud environment.

## Project rules

- Keep README and release/update notes neutral: do not include customer, demo-business or reference-vendor company names. Technical platform/product identifiers needed for configuration may remain in deployment documentation.
- Vercel runs only the gateway in api/index.mjs. The SQLite backend requires a persistent disk and separate HTTPS hosting. Preserve authenticated proxy headers, exact allowed hosts, secure cookies and the setup key; never silently fall back to an ephemeral production database. See docs/雲端部署.md.

- Runtime: Node.js 24; ES modules; SQLite through `node:sqlite`. No npm runtime dependencies. The vendored bwip-js files must remain accompanied by their notices.
- Run `npm run verify` before handing off code. The suite uses independent in-memory or temporary databases. Never run experiments against `data/company.sqlite`.
- `npm run dev` launches the fictional demo. `npm run dev:company` launches the current development environment's company database. `npm start` and `npm run demo` retain the standard server entry points.
- Do not commit database files, `data/`, backups, environment secrets, research downloads, or vendor manual PDFs. `.gitignore` is not a substitute for checking staged files.
- Preserve transaction atomicity, integer money/quantity precision, immutable stock/accounting/audit ledgers, version conflict checks, permission checks, CSRF protection, and idempotency.
- Additive database migrations must preserve existing data and be tested on a copy. Use backup and verification steps documented in `docs/v0.3操作與升級.md` before upgrading an existing company environment.
- Keep Traditional Chinese product text and user documentation. Company needs: replace the old system, quotation/order yellow slips, about 20 users, extensible warehouses, no own manufacturing.
- Multi-company workspaces use separate SQLite databases, users, cookies and CSRF tokens. Preserve explicit summary grants and never fall back to another database for an unknown company. Read `docs/v0.4操作與升級.md` before changing company, billing, tracking or POS behavior.
- POS terminal/device configuration does not prove hardware, payment API or official invoice integration. Keep E08/X10 limitations explicit until real provider/device evidence exists.
- Feature status is recorded in `src/capabilities.mjs`; update only when the stated acceptance behavior actually works. Regenerate reports with `npm run capabilities`. Do not represent incomplete or unconnected external modules as completed.
- Codespaces preview ports should remain private. Development forwarding is configured by `scripts/dev.mjs` with exact hosts; do not disable origin, host, session, or permission checks to make a preview work.

# CHENG ERP development

- Runtime: Node.js 24; ES modules; SQLite through `node:sqlite`. No npm runtime dependencies. The vendored bwip-js files must remain accompanied by their notices.
- Run `npm run verify` before handing off code. The suite uses independent in-memory or temporary databases. Never run experiments against `data/company.sqlite`.
- `npm run dev` launches the fictional demo. `npm run dev:company` launches the current development environment's company database. `npm start` and `npm run demo` retain the standard server entry points.
- Do not commit database files, `data/`, backups, environment secrets, research downloads, or vendor manual PDFs. `.gitignore` is not a substitute for checking staged files.
- Preserve transaction atomicity, integer money/quantity precision, immutable stock/accounting/audit ledgers, version conflict checks, permission checks, CSRF protection, and idempotency.
- Additive database migrations must preserve existing data and be tested on a copy. Use backup and verification steps documented in `docs/v0.3操作與升級.md` before upgrading an existing company environment.
- Keep Traditional Chinese product text and user documentation. Company needs: replace the old system, quotation/order yellow slips, about 20 users, extensible warehouses, no own manufacturing.
- Feature status is recorded in `src/capabilities.mjs`; update only when the stated acceptance behavior actually works. Regenerate reports with `npm run capabilities`. Do not represent incomplete or unconnected external modules as completed.
- Codespaces preview ports should remain private. Development forwarding is configured by `scripts/dev.mjs` with exact hosts; do not disable origin, host, session, or permission checks to make a preview work.

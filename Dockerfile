FROM node:24.22.0-bookworm-slim

ENV NODE_ENV=production ERP_HOST=0.0.0.0 PORT=4320 \
    ERP_DB=/var/lib/erp/company.sqlite ERP_SECURE_COOKIE=1 ERP_REQUIRE_SETUP_KEY=1
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node vendor ./vendor
COPY --chown=node:node scripts/healthcheck.mjs ./scripts/healthcheck.mjs
COPY --chmod=755 deploy/entrypoint.sh /usr/local/bin/erp-entrypoint
RUN mkdir -p /var/lib/erp && chown node:node /var/lib/erp
USER root
VOLUME ["/var/lib/erp"]
EXPOSE 4320
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
ENTRYPOINT ["erp-entrypoint"]
CMD ["node", "src/server.mjs"]

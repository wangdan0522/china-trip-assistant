FROM node:22.22.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    INBOUND_DATA_DIR=/app/runtime
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/db-backup.js ./scripts/db-backup.js
COPY --chown=node:node data/i18n ./data/i18n
COPY --chown=node:node data/countries.json data/policy-registry.json data/places.json data/sources.json ./data/
RUN mkdir -p /app/runtime && chown node:node /app/runtime
USER node
VOLUME ["/app/runtime"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]

FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
ENV PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "server.mjs"]

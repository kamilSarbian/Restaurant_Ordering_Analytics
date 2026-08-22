# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS builder

WORKDIR /home/node/app
RUN chown 1000:1000 /home/node/app

COPY --chown=1000:1000 package.json package-lock.json ./

USER 1000:1000
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY --chown=1000:1000 index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY --chown=1000:1000 src ./src

RUN npm run build \
    && test -z "$(find dist -type f -name '*.map' -print -quit)" \
    && ! grep -R -I -E 'sourceMappingURL=|sourcesContent' dist


FROM nginxinc/nginx-unprivileged:1.31.3-alpine3.24-slim@sha256:d61d7ef52430df468e74ed6ee6e914429b80e20ba988e3176278a73165f876cf AS runtime

USER root
RUN rm -rf /usr/share/nginx/html/* \
    && apk del --no-network apk-tools

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /home/node/app/dist/ /usr/share/nginx/html/

RUN nginx -t

USER 101:101

EXPOSE 8080

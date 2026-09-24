# Pinned by digest, not just tag -- a tag is mutable and can be repointed at
# different bytes at any time. Same rule as the Python services.
#
# To bump: change the tag, then re-resolve the digest with
#   docker buildx imagetools inspect <image>:<tag> --format '{{.Manifest.Digest}}'
FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Dependencies first, so editing source does not re-resolve the whole tree.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
WORKDIR /app
# HOSTNAME=0.0.0.0 explicitly: the standalone server otherwise binds the
# container hostname only, which works through the compose DNS name but not
# through 127.0.0.1 -- surprising the first time something health-checks it.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0

# `output: "standalone"` bundles only the modules the server actually loads,
# so nothing from the build stage -- toolchain, dev dependencies, sources --
# reaches the runtime image.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

RUN useradd --system --no-create-home --uid 10002 webuser && chown -R webuser /app
USER webuser

EXPOSE 3000
CMD ["node", "server.js"]

# Production image for the app (backend + SPA). Two ways in:
#
#   docker compose -f docker-compose.prod.yml up --build     # builds from source
#   .github/workflows/build.yml                              # builds in CI, target: release-ci
#
# The default target is `release`, which compiles everything inside the image
# and needs the framework submodule checked out. CI instead builds backend and
# frontend on the runner and only packages the result (`release-ci`), which is
# what gets pushed to the registry (IMAGE_PREFIX).
FROM oven/bun:1 AS build
WORKDIR /src
COPY backend/package.json backend/bun.lock ./backend/
RUN cd backend && bun install --frozen-lockfile
COPY frontend/package.json frontend/bun.lock ./frontend/
RUN cd frontend && bun install --frozen-lockfile
COPY backend ./backend
COPY frontend ./frontend
# framework submodule must be checked out on the host (git submodule update --init)
RUN test -f backend/framework/package.json || (echo "backend/framework is empty: run git submodule update --init --recursive" && exit 1)
RUN cd frontend && bun run build-only
RUN cd backend && bun run build

# Shared runtime: drizzle-kit runs both migration sets at container start.
FROM oven/bun:1 AS runtime
WORKDIR /usr/src/app
ENV BUN_INSTALL=/root/.bun
ENV NODE_PATH=/root/.bun/install/global/node_modules
RUN bun i -g drizzle-orm pg drizzle-kit
EXPOSE 3000
CMD ["sh", "-c", "bun run framework:migrate && bun run app:migrate && exec bun ./dist/index.js"]

# CI image: the build jobs in .github/workflows/build.yml assemble ./dist with
# the backend bundle, the migrations/config both migrate steps need, and the
# SPA under static/app. This stage only packages it.
FROM runtime AS release-ci
COPY dist ./

# Source build (the default target).
FROM runtime AS release
COPY --from=build /src/backend/dist ./dist
COPY --from=build /src/backend/public ./public
COPY --from=build /src/backend/static ./static
COPY --from=build /src/frontend/dist/static/app ./static/app
COPY --from=build /src/backend/drizzle-sql ./drizzle-sql
COPY --from=build /src/backend/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /src/backend/src/db ./src/db
COPY --from=build /src/backend/framework/drizzle.config.ts ./framework/drizzle.config.ts
COPY --from=build /src/backend/framework/drizzle-sql ./framework/drizzle-sql
COPY --from=build /src/backend/framework/src/lib/db ./framework/src/lib/db
COPY --from=build /src/backend/package.json ./package.json

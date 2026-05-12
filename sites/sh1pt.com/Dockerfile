# syntax=docker/dockerfile:1.6
# Dockerfile for sh1pt.com — built from the monorepo root.
# Reason for existing: Railpack's auto-generated COPY-per-workspace-package
# exceeds BuildKit's mount-options length limit (~344 workspace packages).
# A single bulk COPY sidesteps that.

FROM node:20-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile=false --filter "sh1pt-dot-com..."
RUN pnpm --filter sh1pt-dot-com build

FROM node:20-bookworm-slim AS runner

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production
RUN corepack enable

WORKDIR /app

COPY --from=build /app /app

EXPOSE 8080
CMD ["pnpm", "--filter", "sh1pt-dot-com", "start"]

# Multi-stage build: the test suite gates every image (Reviewer, worker #3).
#
#   base        Node + Debian's ffmpeg — the SAME ffmpeg the worker runs with
#   test        all dependencies + test fixtures; runs `npm test` under that
#               ffmpeg. Any failure fails the build, so `fly deploy` stops.
#   (final)     production dependencies only; the app files are copied FROM
#               the test stage, so the image can't be built unless the tests
#               passed (BuildKit skips stages nothing depends on). No tests,
#               fixtures or dev dependencies end up in the running worker.

FROM node:20-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS test
COPY package.json package-lock.json ./
RUN npm ci
COPY index.js ./
COPY lib ./lib
COPY test ./test
RUN ffmpeg -version | head -1 && npm test

FROM base
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# the app files, from the stage that passed its tests
COPY --from=test /app/index.js ./index.js
COPY --from=test /app/lib ./lib

EXPOSE 3001
CMD ["node", "index.js"]

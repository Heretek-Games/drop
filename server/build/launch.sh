#!/bin/bash

# This file starts up the Drop server by running migrations and then starting the executable
#
# Invoke the globally installed prisma CLI directly: corepack is built with
# COREPACK_ENABLE_NETWORK=0 to keep builds reproducible, so `pnpm prisma ...`
# cannot fetch pnpm at runtime and silently fails on fresh databases, leaving
# Drop to boot against a schema with no tables applied.
echo "[Drop] performing migrations..."
prisma migrate deploy
echo "[Drop] migrations applied."

# Actually start the application
node /app/app/server/index.mjs

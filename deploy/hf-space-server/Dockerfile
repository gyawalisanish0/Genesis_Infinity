FROM node:22-bookworm

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src
COPY examples ./examples

EXPOSE 7860
# Run tsx directly via node's --import loader rather than `npx tsx`. On a
# non-root Space container, npx can stall before ever exec'ing tsx (writing its
# cache under a non-writable HOME, or waiting on a "need to install?" stdin
# prompt with no TTY) — the process then produces no output and never binds the
# port, so the Space hangs at "starting". Invoking node directly avoids npx
# entirely.
CMD ["node", "--import", "tsx", "src/server/cli.ts"]

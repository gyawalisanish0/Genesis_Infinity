FROM node:22-bookworm

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src
COPY examples ./examples

EXPOSE 7860
CMD ["npx", "tsx", "src/server/cli.ts"]

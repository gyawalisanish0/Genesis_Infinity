FROM node:22-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src
COPY examples ./examples
COPY deploy ./deploy

RUN mkdir -p models && \
    curl -L --retry 4 --retry-delay 5 -o models/Llama-3.2-3B-Instruct-Q4_K_M.gguf \
    "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf"

EXPOSE 7860
CMD ["node", "deploy/run.mjs"]

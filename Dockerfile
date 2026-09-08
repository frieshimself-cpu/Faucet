# The runner: claim from the Pons fee escrow, buy, burn; every N seconds, forever.
#
#   docker build -t faucet-runner .
#   docker run --env-file .env -e FAUCET_DEV_WALLET_KEY=... faucet-runner
#
# The key is passed at run time, never baked into the image.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY engine ./engine
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev
# The runner writes the ledger and site data here; mount a volume to keep it.
RUN mkdir -p site/data
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["run", "--every", "180"]

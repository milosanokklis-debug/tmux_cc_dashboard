# Browser tests for the ccdash test stack. The base tag and the npm `playwright` version in
# package.json must be the same release (the image ships that release's browsers).
# Build: tar -C tests/playwright -c . | docker build -t ccdash-playwright:ccdashtest-c -
FROM mcr.microsoft.com/playwright:v1.65.0-noble
WORKDIR /t
COPY package.json package-lock.json ./
RUN npm ci
COPY specs ./specs
CMD ["npm", "test"]

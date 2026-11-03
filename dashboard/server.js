'use strict';
const { createApp } = require('./lib/app');

const app = createApp();
const server = app.createServer();
server.listen(7690, '0.0.0.0', () => console.log('ccdash dashboard listening on 0.0.0.0:7690'));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));

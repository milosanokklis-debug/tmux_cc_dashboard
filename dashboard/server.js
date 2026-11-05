'use strict';
const { createApp } = require('./lib/app');
const { startOpsSweeper } = require('./lib/tmux');

const app = createApp();
// Best effort: the hidden _ops session is also created on demand before each clone.
app.services.tmux.ensureOps().catch((e) => console.error('could not create _ops yet:', e.message));
app.services.reconciler.start(); // conversation status every CCDASH_RECONCILE_MS (5 s)
startOpsSweeper(); // stale ccd-ops .rc/.log files from jobs that never got collected
const server = app.createServer();
server.listen(7690, '0.0.0.0', () => console.log('ccdash dashboard listening on 0.0.0.0:7690'));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));

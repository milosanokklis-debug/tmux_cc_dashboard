#!/usr/bin/env node
'use strict';
// Sets the single dashboard login. Run as the `web` user: `ccd passwd`.
// Writes /var/lib/ccdash-web/auth.json (0600) and ends every existing session.
const authstore = require('./lib/authstore');
const totp = require('./lib/totp');
const qr = require('./lib/qr');

function ask(prompt, { echo }) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (fn) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); fn(); };
    function onData(chunk) {
      if (chunk.startsWith('\x1b')) return; // arrow keys etc.
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(() => resolve(buf));
        if (ch === '\u0003') return done(() => reject(new Error('cancelled')));
        if (ch === '\u007f' || ch === '\b') { buf = [...buf].slice(0, -1).join(''); if (echo) stdout.write('\b \b'); continue; }
        buf += ch;
        if (echo) stdout.write(ch);
      }
    }
    stdin.on('data', onData);
  });
}

// Repeat check + write (setCredentials validates username/password), separate from the TTY prompts so tests can call it.
async function applyPassword({ username, password, repeat, dir, hashOptions }) {
  if (password !== repeat) throw new Error('passwords do not match');
  return authstore.setCredentials({ dir, username, password, hashOptions });
}

// `--totp`: new secret, URI + QR, one valid code from the user, then store and print recovery codes once.
// `askCode()` and `out()` are injectable for tests.
async function enrollTotp({ dir, askCode, out = console.log, now = Date.now, hashOptions }) {
  const auth = authstore.readAuth(dir);
  if (!auth) throw new Error('set a password first (ccd passwd)');
  const secret = totp.generateSecret();
  const uri = totp.otpauthUri({ secret, account: auth.username });
  out(`Scan this QR code with your authenticator app:\n\n${qr.terminal(uri)}\n\n${uri}\n`);
  const step = totp.verify(secret, await askCode('Enter the current 6-digit code: '), now());
  if (step === null) throw new Error('that code is not valid; nothing was changed');
  const codes = await authstore.enableTotp({ dir, secret, step, rotate: true, hashOptions });
  out(`TOTP enabled. All existing sessions are ended.\nRecovery codes (each works once, shown only now):\n${codes.map((c) => `  ${c}`).join('\n')}`);
  return codes;
}

function removeTotp({ dir, out = console.log }) {
  authstore.disableTotp({ dir });
  out('TOTP removed. All existing sessions are ended.');
}

async function main() {
  if (!process.stdin.isTTY) throw new Error('needs an interactive terminal (docker exec -it)');
  const flag = process.argv[2];
  if (flag === '--no-totp') return removeTotp({});
  if (flag === '--totp') return enrollTotp({ askCode: (q) => ask(q, { echo: true }) });
  if (flag) throw new Error('usage: ccd passwd [--totp | --no-totp]');
  const username = (await ask('Username: ', { echo: true })).trim();
  const password = await ask(`Password (min ${authstore.MIN_PASSWORD_LENGTH} characters): `, { echo: false });
  const repeat = await ask('Repeat password: ', { echo: false });
  await applyPassword({ username, password, repeat });
  console.log('Password set. All existing sessions are ended.');
}

module.exports = { applyPassword, enrollTotp, removeTotp };
if (require.main === module) {
  main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}

#!/usr/bin/env node
'use strict';
// Sets the single dashboard login. Run as the `web` user: `ccd passwd`.
// Writes /var/lib/ccdash-web/auth.json (0600) and ends every existing session.
const authstore = require('./lib/authstore');

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

async function main() {
  if (!process.stdin.isTTY) throw new Error('needs an interactive terminal (docker exec -it)');
  const username = (await ask('Username: ', { echo: true })).trim();
  const password = await ask(`Password (min ${authstore.MIN_PASSWORD_LENGTH} characters): `, { echo: false });
  const repeat = await ask('Repeat password: ', { echo: false });
  await applyPassword({ username, password, repeat });
  console.log('Password set. All existing sessions are ended.');
}

module.exports = { applyPassword };
if (require.main === module) {
  main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}

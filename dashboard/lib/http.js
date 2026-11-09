'use strict';
// Small HTTP helpers shared by app.js and api.js.

class HttpError extends Error {
  // `extra` fields (e.g. { log }) are merged into the JSON error body.
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data), ...extra });
  res.end(data);
}

function readJson(req, max = 8 * 1024, emptyOk = false) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        if (emptyOk && text.trim() === '') return resolve({});
        const v = JSON.parse(text);
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v);
      } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', () => reject(new HttpError(400, 'bad request')));
  });
}

module.exports = { HttpError, send, readJson };

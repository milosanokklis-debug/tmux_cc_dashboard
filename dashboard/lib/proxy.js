'use strict';
// Outbound HTTPS through an HTTP CONNECT proxy (the egress proxy), without a dependency. Node's
// global fetch ignores HTTPS_PROXY, so the dashboard's own GitHub calls use fetchViaProxy when
// the variable is set. Web Push uses web-push's own `proxy` option.
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

const proxyUrl = (env = process.env) => env.HTTPS_PROXY || env.https_proxy || null;
const MAX_BODY = 1024 * 1024;

class ConnectAgent extends https.Agent {
  constructor(proxy) { super({ keepAlive: false }); this.proxy = new URL(proxy); }
  createConnection(options, cb) {
    const req = http.request({
      host: this.proxy.hostname, port: this.proxy.port || 80, method: 'CONNECT', path: `${options.host}:${options.port || 443}`,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return cb(new Error(`proxy refused CONNECT (HTTP ${res.statusCode})`)); }
      cb(null, tls.connect({ socket, servername: options.servername || options.host }));
    });
    req.once('error', cb);
    req.end();
  }
}

// A fetch-shaped subset: GET/POST, no redirects; returns { status, json(), text() }.
function fetchViaProxy(url, { headers = {}, method = 'GET', body, signal } = {}, proxy = proxyUrl()) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, agent: new ConnectAgent(proxy), signal }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > MAX_BODY) return req.destroy(new Error('response too large')); chunks.push(c); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text: async () => text, json: async () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { proxyUrl, fetchViaProxy, ConnectAgent };

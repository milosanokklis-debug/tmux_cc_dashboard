'use strict';
// QR rendering (the only QR dependency: qrcode-generator, no transitive deps).
const qrcode = require('qrcode-generator');

function make(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr;
}

const svg = (text) => make(text).createSvgTag({ cellSize: 4, margin: 4, scalable: true });

// Terminal QR using half-block characters (two rows per line), with a quiet zone.
function terminal(text) {
  const qr = make(text);
  const n = qr.getModuleCount();
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -2; r < n + 2; r += 2) {
    let line = '';
    for (let c = -2; c < n + 2; c++) {
      const t = dark(r, c);
      const b = dark(r + 1, c);
      line += t && b ? '█' : t ? '▀' : b ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = { svg, terminal };

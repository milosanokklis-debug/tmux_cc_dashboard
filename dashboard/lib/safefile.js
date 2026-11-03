'use strict';
// Reads from directories that user ccd can write to. A FIFO, symlink or other special
// file planted there must never block the event loop or redirect a read, so the file is
// opened once (no follow, no blocking), the descriptor is checked to be a regular file,
// and all reads go through that descriptor.
const fs = require('node:fs');

const FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;

// First (or, with tail, last) `max` bytes of a regular file as a Buffer plus the file's
// size; null when the path is not a readable regular file.
function readRegular(file, max, { tail = false } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, FLAGS);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(max, st.size);
    const buf = Buffer.alloc(len);
    let pos = tail ? st.size - len : 0;
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, pos + got);
      if (n === 0) break;
      got += n;
    }
    return { buf: buf.subarray(0, got), size: st.size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

module.exports = { readRegular };

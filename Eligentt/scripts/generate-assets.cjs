/**
 * Elligentt — Asset Generator
 * Creates valid PWA icons programmatically.
 * No external dependencies required.
 * Run: node scripts/generate-assets.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PUBLIC = path.resolve(__dirname, '..', 'public');

// ── CRC32 helper ──
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── Generate minimal valid ICO (32x32, solid purple) ──
function generateICO(filePath) {
  const w = 32, h = 32;
  const purple = [0x4f, 0x8e, 0xf7, 0xff]; // #4f8ef7
  const andMask = Buffer.alloc(Math.ceil(w * h / 8), 0xff);

  // BMP info header
  const biSize = 40;
  const biPlanes = 1;
  const biBitCount = 32;
  const biCompression = 0;
  const rowSize = w * 4;
  const imgSize = rowSize * h;
  const fileSize = 14 + biSize + imgSize + andMask.length;

  // BMP pixel data (bottom-up)
  const pixels = Buffer.alloc(imgSize);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = ((h - 1 - y) * w + x) * 4;
      pixels[idx] = purple[2];     // B
      pixels[idx + 1] = purple[1]; // G
      pixels[idx + 2] = purple[0]; // R
      pixels[idx + 3] = purple[3]; // A
    }
  }

  // Build BMP
  const bmp = Buffer.alloc(fileSize);
  let off = 0;
  bmp.writeUInt16LE(0, off); off += 2;      // bfReserved1 (for ICO)
  bmp.writeUInt16LE(1, off); off += 2;       // bfType (1 = ICO)
  bmp.writeUInt8(1, off); off += 1;          // bfCount
  bmp.writeUInt8(w, off); off += 1;          // bWidth
  bmp.writeUInt8(h, off); off += 1;          // bHeight
  bmp.writeUInt8(0, off); off += 1;          // bColorCount
  bmp.writeUInt8(0, off); off += 1;          // bReserved
  bmp.writeUInt16LE(1, off); off += 2;       // wPlanes
  bmp.writeUInt16LE(32, off); off += 2;      // wBitCount
  bmp.writeUInt32LE(imgSize + andMask.length + 40, off); off += 4; // dwBytesInRes

  // Offset to BMP data from start of this entry (22 bytes header)
  bmp.writeUInt32LE(22, off); off += 4;

  // BMP DIB header
  bmp.writeUInt32LE(biSize, off); off += 4;
  bmp.writeInt32LE(w, off); off += 4;
  bmp.writeInt32LE(h * 2, off); off += 4; // height * 2 for ICO
  bmp.writeUInt16LE(biPlanes, off); off += 2;
  bmp.writeUInt16LE(biBitCount, off); off += 2;
  bmp.writeUInt32LE(biCompression, off); off += 4;
  bmp.writeUInt32LE(imgSize, off); off += 4;
  // Leave rest as zeroes
  off = 62; // header is 22 + 40 = 62 bytes

  pixels.copy(bmp, off);
  off += imgSize;
  andMask.copy(bmp, off);

  fs.writeFileSync(filePath, bmp);
}

// ── Generate minimal valid PNG (192x192, purple gradient) ──
function generatePNG(filePath, size) {
  const w = size, h = size;
  const purple = [0x4f, 0x8e, 0xf7];
  const dark = [0x0a, 0x0e, 0x17];

  // RGBA raw pixel data
  const rawData = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      rawData[idx] = 0;     // R (filter byte, PNG uses filter byte per row)
      const cx = w / 2, cy = h / 2;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (w / 2);
      const t = Math.min(1, Math.max(0, dist));
      rawData[idx + 1] = Math.round(purple[0] * (1 - t) + dark[0] * t);
      rawData[idx + 2] = Math.round(purple[1] * (1 - t) + dark[1] * t);
      rawData[idx + 3] = Math.round(purple[2] * (1 - t) + dark[2] * t);
    }
  }

  // Build PNG with filter bytes
  const filtered = Buffer.alloc(h + w * h * 4);
  for (let y = 0; y < h; y++) {
    filtered[y * (1 + w * 4)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const srcIdx = y * w * 4 + x * 4;
      const dstIdx = y * (1 + w * 4) + 1 + x * 4;
      filtered[dstIdx] = rawData[srcIdx + 1];     // R
      filtered[dstIdx + 1] = rawData[srcIdx + 2]; // G
      filtered[dstIdx + 2] = rawData[srcIdx + 3]; // B
      filtered[dstIdx + 3] = 0xff;                // A
    }
  }

  // Compress
  const compressed = zlib.deflateSync(filtered);

  // Build PNG
  const chunks = [];

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(createChunk('IHDR', ihdr));

  // IDAT
  chunks.push(createChunk('IDAT', compressed));

  // IEND
  chunks.push(createChunk('IEND', Buffer.alloc(0)));

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    ...chunks
  ]);

  fs.writeFileSync(filePath, png);
}

function createChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeB, data, crc]);
}

// ── Main ──
function main() {
  console.log('Generating PWA assets...');

  const icoPath = path.join(PUBLIC, 'favicon.ico');
  generateICO(icoPath);
  console.log(`  favicon.ico → ${fs.statSync(icoPath).size} bytes (valid ICO)`);

  const pngPath = path.join(PUBLIC, 'icon-192.png');
  generatePNG(pngPath, 192);
  console.log(`  icon-192.png → ${fs.statSync(pngPath).size} bytes (valid PNG)`);

  console.log('Done.');
}

main();

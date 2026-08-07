// 纯 Node 生成 PNG 图标：应用图标(256) + 托盘图标(32)
// 图案：蓝色渐变圆角方块 + 白色硬币环 + 竖直槽线，寓意“余额/充值”
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const radius = size * 0.22;
  const outerR = size * 0.30;
  const ringT = Math.max(1.2, size * 0.05);
  const slotW = Math.max(1.2, size * 0.05);
  const slotH = size * 0.52;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - c;
      const dy = y - c;

      // 圆角矩形（透明背景）
      const rx = Math.max(Math.abs(dx) - (c - radius), 0);
      const ry = Math.max(Math.abs(dy) - (c - radius), 0);
      if (rx * rx + ry * ry > radius * radius) {
        pixels[i + 3] = 0;
        continue;
      }

      // 渐变底
      const t = y / size;
      const r = Math.round(30 + (59 - 30) * t);
      const g = Math.round(58 + (130 - 58) * t);
      const b = Math.round(138 + (246 - 138) * t);
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;

      // 白色硬币环
      const dist = Math.sqrt(dx * dx + dy * dy);
      const inRing = dist <= outerR && dist >= outerR - ringT;
      // 竖直槽线
      const inSlot = Math.abs(dx) <= slotW / 2 && Math.abs(dy) <= slotH / 2;
      if (inRing || inSlot) {
        pixels[i] = 255;
        pixels[i + 1] = 255;
        pixels[i + 2] = 255;
        pixels[i + 3] = 255;
      }
    }
  }
  return encodePng(size, pixels);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), drawIcon(256));
fs.writeFileSync(path.join(outDir, 'tray.png'), drawIcon(32));
console.log('已生成 assets/icon.png 与 assets/tray.png');

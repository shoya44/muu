// アプリアイコンを生成する。依存なし: SVG と、zlib で自前エンコードした PNG。
// 図柄: 暗い角丸地に、白いレコード風の輪と中心点。実行: node scripts/icon.mjs
import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const BG = [0x21, 0x21, 0x29], RING = [0xe8, 0xe8, 0xee], ACCENT = [0x9a, 0xa3, 0xbd];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#212129"/><circle cx="256" cy="256" r="150" fill="none" stroke="#e8e8ee" stroke-width="28"/><circle cx="256" cy="256" r="40" fill="#9aa3bd"/></svg>\n`;

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size * 112 / 512, cx = size / 2, cy = size / 2;
  const ringR = size * 150 / 512, ringW = size * 28 / 512, dotR = size * 40 / 512;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      // 角丸の外側は透明。
      const dx = Math.max(Math.abs(px - cx) - (size / 2 - radius), 0), dy = Math.max(Math.abs(py - cy) - (size / 2 - radius), 0);
      const outside = Math.hypot(dx, dy) > radius;
      const d = Math.hypot(px - cx, py - cy);
      let color = BG;
      if (Math.abs(d - ringR) <= ringW / 2) color = RING;
      if (d <= dotR) color = ACCENT;
      const at = y * (size * 4 + 1) + 1 + x * 4;
      raw[at] = color[0]; raw[at + 1] = color[1]; raw[at + 2] = color[2]; raw[at + 3] = outside ? 0 : 255;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const table = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buffer) { let c = -1; for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

const out = new URL('../public/', import.meta.url);
await writeFile(new URL('icon.svg', out), svg);
await writeFile(new URL('icon-192.png', out), png(192));
await writeFile(new URL('icon-512.png', out), png(512));
console.log('icons written');

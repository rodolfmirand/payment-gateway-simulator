/**
 * Fake but well-formed payment documents: Pix "copia e cola" code, boleto digitable line, and the
 * PNG/PDF files behind qr_code_url, barcode and pdf. Nothing here can actually be paid.
 */
import { createHash, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { randomDigits } from '../../shared/ids.js';

/** CRC16-CCITT (0x1021, init 0xFFFF), the checksum of the Pix BR Code. */
function crc16(payload: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(payload, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const emv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** Pix BR Code (EMV) pointing to a simulator URL; valid structure and CRC. */
export function pixQrCode(amount: number, merchantName: string): string {
  const account = emv('00', 'br.gov.bcb.pix') + emv('25', `simulator.pagar.me/pix/v2/${randomUUID()}`);
  const payload =
    emv('00', '01') +
    emv('01', '12') +
    emv('26', account) +
    emv('52', '0000') +
    emv('53', '986') +
    emv('54', (amount / 100).toFixed(2)) +
    emv('58', 'BR') +
    emv(
      '59',
      merchantName
        .normalize('NFD')
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, 25)
        .toUpperCase(),
    ) +
    emv('60', 'SAO PAULO') +
    emv('62', emv('05', '***')) +
    '6304';
  return payload + crc16(payload);
}

/** End-to-end id of a Pix payment: E + ISPB + yyyyMMddHHmm + 11 random chars (32 chars). */
export function endToEndId(paidAt: Date): string {
  const stamp = paidAt.toISOString().replace(/\D/g, '').slice(0, 12);
  return `E18236120${stamp}${randomDigits(11)}`.slice(0, 32);
}

/** Days since 1997-10-07, restarting at 1000 after 9999 (FEBRABAN rule from 2025-02-22). */
function dueFactor(dueAt: Date): string {
  const days = Math.floor((dueAt.getTime() - Date.UTC(1997, 9, 7)) / 86_400_000);
  return String(days > 9999 ? ((days - 10_000) % 9000) + 1000 : days).padStart(4, '0');
}

/** Digitable line with the layout of a real one ("34191.75462 24615.781234 41234.510000 3 83840000003090"). */
export function boletoLine(bank: string, amount: number, dueAt: Date): string {
  const head = `${bank.padStart(3, '0').slice(-3)}9${randomDigits(5)}`;
  return [
    `${head.slice(0, 5)}.${head.slice(5)}${randomDigits(1)}`,
    `${randomDigits(5)}.${randomDigits(6)}`,
    `${randomDigits(5)}.${randomDigits(6)}`,
    randomDigits(1),
    `${dueFactor(dueAt)}${String(amount).padStart(10, '0')}`,
  ].join(' ');
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Black-and-white PNG drawn from a boolean matrix, each cell `scale` pixels wide. */
function png(cells: boolean[][], scale: number): Buffer {
  const height = cells.length * scale;
  const width = (cells[0]?.length ?? 0) * scale;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width + 1); // first byte: filter "none"
    const cellRow = cells[Math.floor(y / scale)] ?? [];
    for (let x = 0; x < width; x++) row[x + 1] = cellRow[Math.floor(x / scale)] ? 0 : 255;
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** QR-looking image (not a scannable QR Code): finder squares plus a pattern derived from `seed`. */
export function qrCodePng(seed: string): Buffer {
  const size = 25;
  const bits = createHash('sha256').update(seed).digest();
  const finder = (r: number, c: number) => {
    const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
    return ring !== 2 && ring <= 3;
  };
  const cells = Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => {
      if (r < 7 && c < 7) return finder(r, c);
      if (r < 7 && c >= size - 7) return finder(r, c - (size - 7));
      if (r >= size - 7 && c < 7) return finder(r - (size - 7), c);
      if ((r < 8 && c < 8) || (r < 8 && c >= size - 8) || (r >= size - 8 && c < 8)) return false; // quiet zone
      const index = r * size + c;
      return ((bits[index % bits.length] ?? 0) >> (index % 8)) % 2 === 1;
    }),
  );
  return png(
    [
      [...Array<boolean>(size + 2).fill(false)],
      ...cells.map((row) => [false, ...row, false]),
      [...Array<boolean>(size + 2).fill(false)],
    ],
    8,
  );
}

/** Bars drawn from the digits of the line. */
export function barcodePng(line: string): Buffer {
  const digits = line.replace(/\D/g, '');
  const bars = Array.from({ length: digits.length }, (_, index) => Number(digits.charAt(index))).flatMap(
    (n) => [true, n % 2 === 0, false, n > 4, true, false],
  );
  return png(
    Array.from({ length: 12 }, () => bars),
    2,
  );
}

/** Single page PDF with the boleto data. */
export function boletoPdf(lines: string[]): Buffer {
  const escape = (text: string) =>
    text
      .normalize('NFD')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/[\\()]/g, '\\$&');
  const content = [
    'BT',
    '/F1 12 Tf',
    '50 780 Td',
    '16 TL',
    ...lines.map((text) => `(${escape(text)}) '`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

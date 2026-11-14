import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFlagsInfo, readFlagRows, SOURCE_FLAG } from '../js/fits.js';

test('reads uncompressed big-endian FLAGS image rows', async () => {
  const cards = [
    "XTENSION= 'IMAGE   '", 'BITPIX  =                   32', 'NAXIS   =                    2',
    'NAXIS1  =                    2', 'NAXIS2  =                    2', "EXTNAME = 'FLAGS   '", 'END',
  ];
  const bytes = new Uint8Array(2880 + 16);
  bytes.fill(32, 0, 2880);
  const header = new TextEncoder().encode(cards.map(c => c.padEnd(80)).join(''));
  bytes.set(header);
  const values = new DataView(bytes.buffer, 2880);
  [0, SOURCE_FLAG, 1 << 22, -1].forEach((v, i) => values.setInt32(i * 4, v, false));
  const previous = globalThis.fetch;
  globalThis.fetch = async (_, options) => {
    const [, start, end] = options.headers.Range.match(/bytes=(\d+)-(\d+)/);
    return new Response(bytes.slice(Number(start), Number(end) + 1), { status: 206 });
  };
  try {
    const info = await readFlagsInfo('test', { nextHduStart: 0 });
    assert.equal(info.width, 2);
    assert.equal(info.height, 2);
    assert.deepEqual([...await readFlagRows('test', info, 0, 1)], [0, SOURCE_FLAG, 1 << 22, -1]);
    assert.deepEqual([...await readFlagRows('test', info, 1, 1)], [1 << 22, -1]);
  } finally { globalThis.fetch = previous; }
});

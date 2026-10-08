import { parseExportReason } from '../src/audit/audit-search';
import { allLimited } from '../src/common/concurrency';
import { UNSAFE_TEXT } from '../src/common/text-safety';
import { poolMax } from '../src/db/database';
import { parseBlockReason } from '../src/directory/directory';
import { text } from '../src/stations/stations.schema';
import { parsePull } from '../src/sync/sync';

describe('allLimited', () => {
  it('keeps order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const task = (v: number) => async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return v;
    };
    expect(await allLimited([task(1), task(2), task(3), task(4), task(5), task(6)], 2)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(peak).toBe(2);
  });
});

describe('unsafe text', () => {
  const sneaky = ['a\u202eb', 'a\u2066b', 'a\u200bb', 'a\u200fb', 'a\ufeffb', 'a\u0085b', 'a\u0007b'];
  it.each(sneaky)('refuses %j in reasons and station names', (bad) => {
    expect(UNSAFE_TEXT.test(bad)).toBe(true);
    expect(() => parseExportReason({ reason: `long enough ${bad}` })).toThrow();
    expect(() => parseBlockReason(`long enough ${bad}`)).toThrow();
    expect(() => text('name', bad, 100)).toThrow();
  });
  it('keeps Thai, emoji and ordinary punctuation', () => {
    expect(text('name', 'สถานีทดสอบ 📻 (FM)', 100)).toBe('สถานีทดสอบ 📻 (FM)');
    expect(parseExportReason({ reason: 'ตรวจสอบตามคำขอลูกค้า' })).toBe('ตรวจสอบตามคำขอลูกค้า');
  });
});

describe('sync pull limit', () => {
  it.each(['1e1', '0x10', ' 5', '5.0', '-1', '0', '101'])('refuses %j', (limit) => expect(() => parsePull({ limit })).toThrow());
  it('takes plain digits', () => expect(parsePull({ limit: '42' }).limit).toBe(42));
});

describe('DB_POOL_MAX', () => {
  it('defaults to 20 and accepts 2..200', () => {
    expect(poolMax({})).toBe(20);
    expect(poolMax({ DB_POOL_MAX: '50' })).toBe(50);
    expect(poolMax({ DB_POOL_MAX: '1' })).toBe(20);
    expect(poolMax({ DB_POOL_MAX: 'x' })).toBe(20);
  });
});

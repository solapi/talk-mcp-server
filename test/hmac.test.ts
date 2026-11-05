import { describe, expect, it } from 'vitest';
import { buildHmacAuthorization, generateSignature } from '../src/api/hmac.js';

describe('HMAC 서명', () => {
  const date = '2026-11-04T01:02:03.000Z';
  const salt = '00112233445566778899aabbccddeeff';

  it('signature = hex(HMAC_SHA256(secret, date + salt)) 고정 벡터', () => {
    expect(generateSignature('test-secret', date, salt)).toBe(
      'be746def6b2cf6f9d72d5ba0981a8e888ed7425af6fbcdd62b72c389eaaa559e',
    );
  });

  it('Authorization 헤더 형식', () => {
    expect(buildHmacAuthorization('KEY1', 'test-secret', { date, salt })).toBe(
      `HMAC-SHA256 apiKey=KEY1, date=${date}, salt=${salt}, signature=be746def6b2cf6f9d72d5ba0981a8e888ed7425af6fbcdd62b72c389eaaa559e`,
    );
  });

  it('기본값은 매번 새 salt 와 ISO8601 date', () => {
    const a = buildHmacAuthorization('K', 's');
    const b = buildHmacAuthorization('K', 's');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^HMAC-SHA256 apiKey=K, date=\d{4}-\d{2}-\d{2}T[\d:.]+Z, salt=[0-9a-f]{32}, signature=[0-9a-f]{64}$/);
  });
});

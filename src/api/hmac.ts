import { createHmac, randomBytes } from 'node:crypto';

/** signature = hex(HMAC_SHA256(secret, date + salt)) — SOLAPI API Key 인증 규격 */
export function generateSignature(apiSecret: string, date: string, salt: string): string {
  return createHmac('sha256', apiSecret).update(date + salt).digest('hex');
}

export interface HmacOptions {
  /** ISO8601. 테스트에서 고정값을 넣기 위한 옵션 */
  date?: string;
  /** hex. 테스트에서 고정값을 넣기 위한 옵션 */
  salt?: string;
}

/** Authorization: HMAC-SHA256 apiKey=…, date=<ISO8601>, salt=<hex>, signature=<hex> */
export function buildHmacAuthorization(apiKey: string, apiSecret: string, options: HmacOptions = {}): string {
  const date = options.date ?? new Date().toISOString();
  const salt = options.salt ?? randomBytes(16).toString('hex');
  const signature = generateSignature(apiSecret, date, salt);
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

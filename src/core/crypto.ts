import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class Vault {
  constructor(private key: Buffer) { if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes.'); }
  seal(value: unknown, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [nonce, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
  }
  open<T>(value: string, context: string): T {
    const [nonce, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64url'));
    if (!nonce || !tag || !data) throw new Error('Invalid encrypted value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as T;
  }
}
export const opaque = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
export function verifySlack(raw: string, timestamp: string, signature: string, secret: string, now = Date.now()): boolean {
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

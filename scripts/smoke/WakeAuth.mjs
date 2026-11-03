import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWakeSignature(secret, rawBody, signature) {
  if (typeof secret !== 'string' || secret.length < 32 ||
      typeof signature !== 'string' || !signature.startsWith('sha256=')) {
    return false;
  }

  const actual = signature.slice(7);
  if (!/^[a-f0-9]{64}$/.test(actual)) {
    return false;
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

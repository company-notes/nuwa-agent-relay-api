import { resolve } from 'node:path';

export const addressOrigin = process.env.RELAY_SMOKE_ADDRESS_URL || 'https://address.company-notes.com';
export const relayOrigin = process.env.RELAY_SMOKE_RELAY_URL || 'https://agent-relay.company-notes.com';
export const statePath = resolve(process.env.RELAY_SMOKE_STATE || '.relay-smoke/session.json');

export function assert(condition, description) {
  if (!condition) {
    throw new Error(description);
  }
}

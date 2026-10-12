import dns from 'node:dns';
import net from 'node:net';

/**
 * Outbound connections: try IPv4 first, and give each connection attempt 5s instead of Node's 250ms
 * default, which is too short for a slow first answer.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

export function applyNetworkDefaults(): void {
  dns.setDefaultResultOrder('ipv4first');
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
}

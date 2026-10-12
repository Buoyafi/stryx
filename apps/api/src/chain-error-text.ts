import { BaseError } from 'viem';
import { redactUrls } from '@stryx/utils';

/** A chain client error in one short, URL-free line that keeps the node's own words, which viem puts after the request body. */
export function chainErrorText(err: unknown, max = 300): string {
  const text = redactUrls(raw(err)).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function raw(err: unknown): string {
  if (err instanceof BaseError) {
    const node = err.details?.trim();
    return node && node !== err.shortMessage ? `${err.shortMessage} Node said: ${node}` : err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

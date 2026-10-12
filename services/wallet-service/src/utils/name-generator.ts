/** Generates short, memorable wallet names. */

const ADJECTIVES = [
  'amber', 'onyx', 'cobalt', 'crimson', 'ivory', 'jade', 'slate', 'copper',
  'violet', 'azure', 'ember', 'frost', 'dusk', 'gilded', 'quiet', 'swift',
  'iron', 'lunar', 'solar', 'nimble', 'silent', 'bold', 'hollow', 'bright',
];

const NOUNS = [
  'falcon', 'vault', 'anvil', 'harbor', 'lantern', 'compass', 'quarry', 'ridge',
  'ember', 'summit', 'beacon', 'cipher', 'forge', 'thicket', 'canyon', 'drift',
  'span', 'relay', 'atlas', 'meridian', 'bastion', 'current', 'signal', 'apex',
];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

export function generateWalletName(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

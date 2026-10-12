declare const userIdBrand: unique symbol;

/** ADR-002 §3.3: a wallet owner id, distinct from a plain `string` so it cannot be passed where a wallet id belongs. */
export type UserId = string & { readonly [userIdBrand]: true };

import type { UserId } from '@stryx/wallet-service';

/**
 * ADR-002 §3.11: the reserved operator user. Requests made with the operator token act as this
 * account, so everything made before real accounts existed has an owner.
 */
export const RESERVED_OPERATOR_USER_ID = '00000000-0000-0000-0000-000000000001' as UserId;

import { decodeErrorResult, type Hex } from 'viem';
import { SEADROP_ABI } from './seadrop-abi.js';

/**
 * Best-effort decode of a SeaDrop revert into a readable reason. Undefined when the data matches no
 * known SeaDrop error: fall back to the raw message.
 */
export function decodeSeaDropRevertData(data: Hex): string | undefined {
  try {
    const decoded = decodeErrorResult({ abi: SEADROP_ABI, data });
    const args = decoded.args?.length ? `(${decoded.args.map(String).join(', ')})` : '';
    return `${decoded.errorName}${args}`;
  } catch {
    return undefined;
  }
}

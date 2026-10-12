import { zeroAddress } from 'viem';
import {
  SeaDropTransactionBuilder,
  decodeMintSignedCalldata,
  recoverSignedMintSigner,
  SignedMintDecodeError,
  type SignedMintPayload,
  type SignedMintValidationParams,
  type UnsignedTransactionRequest,
} from '@stryx/nft-engine';

/** Why one wallet's calldata was refused. Each maps to a plain sentence in `detail`. */
export type SignedMintRejection =
  | 'calldata_invalid'
  | 'wrong_contract'
  | 'wrong_minter'
  | 'wrong_quantity'
  | 'unknown_signer'
  | 'outside_signer_bounds'
  | 'fee_recipient_not_allowed'
  | 'price_above_expected';

export interface SignedMintContext {
  chainId: number;
  nftContract: `0x${string}`;
  walletAddress: `0x${string}`;
  quantity: number;
  /** The per-token price the operator saw and accepted when scheduling. The mint is refused above it. */
  maxPriceWei: bigint;
  /** On-chain `getSigners` -> `getSignedMintValidationParams`, read at warm-up. Keys lowercase. */
  signerBounds: ReadonlyMap<string, SignedMintValidationParams>;
  /** On-chain `getAllowedFeeRecipients`, read at warm-up. Lowercase. */
  allowedFeeRecipients: ReadonlySet<string>;
}

export type SignedMintValidation =
  | {
      ok: true;
      tx: UnsignedTransactionRequest;
      payload: SignedMintPayload;
      signer: `0x${string}`;
      /** Set when OpenSea's bytes differ from our canonical rebuild (see check 5): recorded, not a refusal. */
      note: string | null;
    }
  | { ok: false; reason: SignedMintRejection; detail: string };

const builder = new SeaDropTransactionBuilder();
const lower = (a: string) => a.toLowerCase();

/**
 * Decides locally whether calldata OpenSea returned for one wallet is safe to sign: it must be a
 * mintSigned call for this drop, this wallet and this quantity, within the price limit, to an allowed
 * fee recipient, and signed by a signer the contract accepts. Every on-chain value it needs was read
 * at warm-up.
 */
export async function validateSignedMintCalldata(calldata: `0x${string}`, ctx: SignedMintContext): Promise<SignedMintValidation> {
  let payload: SignedMintPayload;
  try {
    payload = decodeMintSignedCalldata(calldata);
  } catch (err) {
    const detail = err instanceof SignedMintDecodeError ? err.message : 'Calldata could not be decoded.';
    return { ok: false, reason: 'calldata_invalid', detail };
  }

  if (lower(payload.nftContract) !== lower(ctx.nftContract)) {
    return { ok: false, reason: 'wrong_contract', detail: `Calldata is for ${payload.nftContract}, not ${ctx.nftContract}.` };
  }
  const minterIsZero = lower(payload.minterIfNotPayer) === lower(zeroAddress);
  if (!minterIsZero && lower(payload.minterIfNotPayer) !== lower(ctx.walletAddress)) {
    return { ok: false, reason: 'wrong_minter', detail: `Calldata mints to ${payload.minterIfNotPayer}, not this wallet.` };
  }
  if (payload.quantity !== ctx.quantity) {
    return { ok: false, reason: 'wrong_quantity', detail: `Calldata is for ${payload.quantity}, this wallet was scheduled for ${ctx.quantity}.` };
  }

  const tx = builder.buildMintSignedTx(
    { nftContract: ctx.nftContract, chainId: ctx.chainId },
    payload.feeRecipient,
    payload.quantity,
    payload.mintParams,
    payload.salt,
    payload.signature,
  );
  const note = minterIsZero ? describeEncodingDifference(lower(calldata), lower(tx.data)) : null;

  let signer: `0x${string}`;
  try {
    signer = await recoverSignedMintSigner(ctx.chainId, ctx.walletAddress, payload);
  } catch {
    return { ok: false, reason: 'unknown_signer', detail: 'The signature is malformed.' };
  }
  const bounds = ctx.signerBounds.get(lower(signer));
  if (!bounds || bounds.maxMaxTotalMintableByWallet === 0) {
    return { ok: false, reason: 'unknown_signer', detail: `Signed by ${signer}, which is not an allowed signer for this contract.` };
  }

  const boundsProblem = checkBounds(payload, bounds);
  if (boundsProblem) return { ok: false, reason: 'outside_signer_bounds', detail: boundsProblem };

  if (!ctx.allowedFeeRecipients.has(lower(payload.feeRecipient))) {
    return { ok: false, reason: 'fee_recipient_not_allowed', detail: `Fee recipient ${payload.feeRecipient} is not allowed for this contract.` };
  }

  if (payload.mintParams.mintPrice > ctx.maxPriceWei) {
    return {
      ok: false,
      reason: 'price_above_expected',
      detail: `Signed price ${payload.mintParams.mintPrice} wei per token is above the ${ctx.maxPriceWei} wei you accepted.`,
    };
  }

  return { ok: true, tx, payload, signer, note };
}

/** Null when identical; otherwise a short, plain description of how OpenSea's bytes differ from ours. */
export function describeEncodingDifference(theirs: string, ours: string): string | null {
  if (theirs === ours) return null;
  const bytes = (hex: string) => (hex.length - 2) / 2;
  if (theirs.startsWith(ours)) {
    const extra = theirs.slice(ours.length);
    return `OpenSea's calldata has ${extra.length / 2} extra trailing bytes (0x${extra.slice(0, 16)}${extra.length > 16 ? '…' : ''}) after the mint arguments; not needed to mint, left out of the signed transaction.`;
  }
  let i = 2;
  while (i < theirs.length && i < ours.length && theirs[i] === ours[i]) i++;
  return `OpenSea's calldata is encoded differently from our canonical rebuild (${bytes(theirs)} vs ${bytes(ours)} bytes, first difference at byte ${Math.floor((i - 2) / 2)}); every decoded field and the signature were checked, and our encoding is what was signed.`;
}

function checkBounds(payload: SignedMintPayload, b: SignedMintValidationParams): string | null {
  const p = payload.mintParams;
  if (p.mintPrice < b.minMintPrice) return `Price ${p.mintPrice} is below the signer minimum ${b.minMintPrice}.`;
  if (p.maxTotalMintableByWallet > b.maxMaxTotalMintableByWallet) {
    return `Per-wallet max ${p.maxTotalMintableByWallet} is above the signer limit ${b.maxMaxTotalMintableByWallet}.`;
  }
  if (p.startTime < b.minStartTime) return `Start ${p.startTime} is before the signer minimum ${b.minStartTime}.`;
  if (p.endTime > b.maxEndTime) return `End ${p.endTime} is after the signer maximum ${b.maxEndTime}.`;
  if (p.maxTokenSupplyForStage > BigInt(b.maxMaxTokenSupplyForStage)) {
    return `Stage supply ${p.maxTokenSupplyForStage} is above the signer limit ${b.maxMaxTokenSupplyForStage}.`;
  }
  if (p.feeBps < b.minFeeBps || p.feeBps > b.maxFeeBps) return `Fee ${p.feeBps} bps is outside ${b.minFeeBps} to ${b.maxFeeBps}.`;
  if (!p.restrictFeeRecipients) return 'Signed mints must restrict fee recipients.';
  return null;
}

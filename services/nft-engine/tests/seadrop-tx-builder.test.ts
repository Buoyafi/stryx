import { describe, expect, it } from 'vitest';
import { decodeFunctionData, getAddress, parseEther, zeroAddress } from 'viem';
import { SeaDropTransactionBuilder } from '../src/service/seadrop-tx-builder.service.js';
import { SEADROP_ADDRESS, SEADROP_ABI } from '../src/utils/seadrop-abi.js';
import type { MintParams, SeaDropMintScope } from '../src/types/seadrop.types.js';

const scope: SeaDropMintScope = {
  nftContract: getAddress('0x1234567890123456789012345678901234567890'),
  chainId: 1,
};
const feeRecipient = getAddress('0x0000a26b00c1f0df003000390027140000faa719');

describe('SeaDropTransactionBuilder', () => {
  it('builds a mintPublic tx that sends to the canonical SeaDrop address', () => {
    const builder = new SeaDropTransactionBuilder();
    const tx = builder.buildMintPublicTx(scope, feeRecipient, 2, parseEther('0.01'));

    expect(tx.to).toBe(SEADROP_ADDRESS);
    expect(tx.value).toBe(parseEther('0.02')); // price * quantity
  });

  it('encodes mintPublic calldata that decodes back to the exact input arguments', () => {
    const builder = new SeaDropTransactionBuilder();
    const tx = builder.buildMintPublicTx(scope, feeRecipient, 3, parseEther('0.005'));

    const decoded = decodeFunctionData({ abi: SEADROP_ABI, data: tx.data });

    expect(decoded.functionName).toBe('mintPublic');
    expect(decoded.args).toEqual([scope.nftContract, feeRecipient, zeroAddress, 3n]);
  });

  it('uses the ZERO address for minterIfNotPayer on a self-mint: regression for the PayerNotAllowed bug', () => {
    // The signing wallet is always both the payer (msg.sender, once broadcast) and the intended
    // recipient in Stryx today: there is no delegated-minting feature.
    const builder = new SeaDropTransactionBuilder();
    const tx = builder.buildMintPublicTx(scope, feeRecipient, 1, parseEther('0.01'));

    const decoded = decodeFunctionData({ abi: SEADROP_ABI, data: tx.data });
    const [, , minterIfNotPayer] = decoded.args as unknown as [string, string, string, bigint];
    expect(minterIfNotPayer).toBe(zeroAddress);
  });

  it('builds a mintAllowList tx with value = mintParams.mintPrice * quantity', () => {
    const builder = new SeaDropTransactionBuilder();
    const mintParams: MintParams = {
      mintPrice: parseEther('0.001'),
      maxTotalMintableByWallet: 5,
      startTime: 1_700_000_000,
      endTime: 1_700_003_600,
      dropStageIndex: 1,
      maxTokenSupplyForStage: 1000n,
      feeBps: 500,
      restrictFeeRecipients: true,
    };
    const proof = [('0x' + 'ab'.repeat(32)) as `0x${string}`];

    const tx = builder.buildMintAllowListTx(scope, feeRecipient, 4, mintParams, proof);

    expect(tx.to).toBe(SEADROP_ADDRESS);
    expect(tx.value).toBe(parseEther('0.004'));
  });

  it('encodes mintAllowList calldata that decodes back to the exact mintParams and proof, with the zero address for minterIfNotPayer', () => {
    const builder = new SeaDropTransactionBuilder();
    const mintParams: MintParams = {
      mintPrice: parseEther('0.002'),
      maxTotalMintableByWallet: 3,
      startTime: 1_700_000_000,
      endTime: 1_700_003_600,
      dropStageIndex: 2,
      maxTokenSupplyForStage: 500n,
      feeBps: 250,
      restrictFeeRecipients: false,
    };
    const proof = [('0x' + 'cd'.repeat(32)) as `0x${string}`, ('0x' + 'ef'.repeat(32)) as `0x${string}`];

    const tx = builder.buildMintAllowListTx(scope, feeRecipient, 1, mintParams, proof);
    const decoded = decodeFunctionData({ abi: SEADROP_ABI, data: tx.data });

    expect(decoded.functionName).toBe('mintAllowList');
    const [decodedContract, decodedFeeRecipient, decodedMinter, decodedQuantity, decodedMintParams, decodedProof] =
      decoded.args as unknown as [string, string, string, bigint, Record<string, unknown>, readonly string[]];

    expect(decodedContract).toBe(scope.nftContract);
    expect(decodedFeeRecipient).toBe(feeRecipient);
    expect(decodedMinter).toBe(zeroAddress);
    expect(decodedQuantity).toBe(1n);
    expect(decodedMintParams['mintPrice']).toBe(mintParams.mintPrice);
    expect(decodedMintParams['dropStageIndex']).toBe(BigInt(mintParams.dropStageIndex));
    expect(decodedMintParams['restrictFeeRecipients']).toBe(false);
    expect(decodedProof).toEqual(proof);
  });
});

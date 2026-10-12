import { describe, expect, it } from 'vitest';
import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  parseEther,
  serializeCompactSignature,
  signatureToCompactSignature,
  parseSignature,
  toHex,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SeaDropTransactionBuilder } from '../src/service/seadrop-tx-builder.service.js';
import { SEADROP_ABI, SEADROP_ADDRESS } from '../src/utils/seadrop-abi.js';
import {
  decodeMintSignedCalldata,
  recoverSignedMintSigner,
  signedMintTypedData,
  SignedMintDecodeError,
} from '../src/utils/signed-mint.js';
import type { MintParams } from '../src/types/seadrop.types.js';

const CHAIN_ID = 4663;
const nftContract = getAddress('0xc62caba0cf5774d8e40e2651e86a0014de8ab768');
const feeRecipient = getAddress('0x0000a26b00c1f0df003000390027140000faa719');
// A throwaway key standing in for OpenSea's signer. Never a real one.
const signer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const minter = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');

const mintParams: MintParams = {
  mintPrice: parseEther('0.001'),
  maxTotalMintableByWallet: 2,
  startTime: 1_790_000_000,
  endTime: 1_790_086_400,
  dropStageIndex: 2,
  maxTokenSupplyForStage: 5000n,
  feeBps: 1000,
  restrictFeeRecipients: true,
};
const salt = 123456789n;

async function signPayload(forMinter = minter) {
  return signer.signTypedData(signedMintTypedData({ chainId: CHAIN_ID, nftContract, minter: forMinter, feeRecipient, mintParams, salt }));
}

/** SeaDrop.sol's `_getDigest`, transcribed from the Solidity independently of the code under test. */
function seaDropDigest(forMinter: `0x${string}`): `0x${string}` {
  const MINT_PARAMS_TYPE =
    'MintParams(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients)';
  const SIGNED_MINT_TYPEHASH = keccak256(
    toHex('SignedMint(address nftContract,address minter,address feeRecipient,MintParams mintParams,uint256 salt)' + MINT_PARAMS_TYPE),
  );
  const MINT_PARAMS_TYPEHASH = keccak256(toHex(MINT_PARAMS_TYPE));
  const DOMAIN_TYPEHASH = keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));

  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [DOMAIN_TYPEHASH, keccak256(toHex('SeaDrop')), keccak256(toHex('1.0')), BigInt(CHAIN_ID), SEADROP_ADDRESS],
    ),
  );
  const mintParamsHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bool' },
      ],
      [
        MINT_PARAMS_TYPEHASH,
        mintParams.mintPrice,
        BigInt(mintParams.maxTotalMintableByWallet),
        BigInt(mintParams.startTime),
        BigInt(mintParams.endTime),
        BigInt(mintParams.dropStageIndex),
        mintParams.maxTokenSupplyForStage,
        BigInt(mintParams.feeBps),
        mintParams.restrictFeeRecipients,
      ],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }],
      [SIGNED_MINT_TYPEHASH, nftContract, forMinter, feeRecipient, mintParamsHash, salt],
    ),
  );
  return keccak256(concat(['0x1901', domainSeparator, structHash]));
}

describe('signed mint (mintSigned) support', () => {
  it('builds EIP-712 typed data whose digest equals SeaDrop.sol _getDigest, computed independently', () => {
    const viaTypedData = hashTypedData(signedMintTypedData({ chainId: CHAIN_ID, nftContract, minter, feeRecipient, mintParams, salt }));
    expect(viaTypedData).toBe(seaDropDigest(minter));
  });

  it('buildMintSignedTx encodes every signed field, zero minterIfNotPayer, value = price * quantity', async () => {
    const signature = await signPayload();
    const tx = new SeaDropTransactionBuilder().buildMintSignedTx({ nftContract, chainId: CHAIN_ID }, feeRecipient, 2, mintParams, salt, signature);

    expect(tx.to).toBe(SEADROP_ADDRESS);
    expect(tx.value).toBe(parseEther('0.002'));
    const decoded = decodeFunctionData({ abi: SEADROP_ABI, data: tx.data });
    expect(decoded.functionName).toBe('mintSigned');
    const args = decoded.args as unknown as unknown[];
    expect(args[2]).toBe(zeroAddress);
    expect(args[5]).toBe(salt);
    expect(args[6]).toBe(signature);
  });

  it('decodes mintSigned calldata back to the exact payload, and our rebuild is byte-identical', async () => {
    const signature = await signPayload();
    const calldata = encodeFunctionData({
      abi: SEADROP_ABI,
      functionName: 'mintSigned',
      args: [
        nftContract,
        feeRecipient,
        zeroAddress,
        2n,
        {
          mintPrice: mintParams.mintPrice,
          maxTotalMintableByWallet: 2n,
          startTime: BigInt(mintParams.startTime),
          endTime: BigInt(mintParams.endTime),
          dropStageIndex: 2n,
          maxTokenSupplyForStage: 5000n,
          feeBps: 1000n,
          restrictFeeRecipients: true,
        },
        salt,
        signature,
      ],
    });

    const payload = decodeMintSignedCalldata(calldata);
    expect(payload).toEqual({ nftContract, feeRecipient, minterIfNotPayer: zeroAddress, quantity: 2, mintParams, salt, signature });

    const rebuilt = new SeaDropTransactionBuilder().buildMintSignedTx(
      { nftContract, chainId: CHAIN_ID },
      payload.feeRecipient,
      payload.quantity,
      payload.mintParams,
      payload.salt,
      payload.signature,
    );
    expect(rebuilt.data).toBe(calldata);
  });

  it('refuses calldata for any other SeaDrop function, and bytes that are not SeaDrop at all', () => {
    const publicCall = new SeaDropTransactionBuilder().buildMintPublicTx({ nftContract, chainId: CHAIN_ID }, feeRecipient, 1, 0n);
    expect(() => decodeMintSignedCalldata(publicCall.data)).toThrow(SignedMintDecodeError);
    expect(() => decodeMintSignedCalldata('0xdeadbeef')).toThrow(SignedMintDecodeError);
  });

  it('recovers the real signer for the minter the signature was issued to', async () => {
    const signature = await signPayload();
    const payload = { nftContract, feeRecipient, minterIfNotPayer: zeroAddress, quantity: 1, mintParams, salt, signature };
    expect(await recoverSignedMintSigner(CHAIN_ID, minter, payload)).toBe(signer.address);
  });

  it('recovers a different (wrong) address when checked against a different minter or chain', async () => {
    const signature = await signPayload();
    const payload = { nftContract, feeRecipient, minterIfNotPayer: zeroAddress, quantity: 1, mintParams, salt, signature };
    const otherMinter = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
    expect(await recoverSignedMintSigner(CHAIN_ID, otherMinter, payload)).not.toBe(signer.address);
    expect(await recoverSignedMintSigner(1, minter, payload)).not.toBe(signer.address);
  });

  it('accepts a 64-byte (EIP-2098) compact signature, as the contract does', async () => {
    const full = await signPayload();
    const compact = serializeCompactSignature(signatureToCompactSignature(parseSignature(full)));
    const payload = { nftContract, feeRecipient, minterIfNotPayer: zeroAddress, quantity: 1, mintParams, salt, signature: compact };
    expect(await recoverSignedMintSigner(CHAIN_ID, minter, payload)).toBe(signer.address);
  });
});

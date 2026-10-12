import { describe, expect, it } from 'vitest';
import { getAddress, parseEther } from 'viem';
import { EligibilityChecker } from '../src/service/eligibility-checker.service.js';
import { SeaDropAllowListTree } from '../src/service/seadrop-allowlist-tree.service.js';
import type { AllowListEntry } from '../src/types/allowlist.types.js';

const minterA = getAddress('0x' + '11'.repeat(20));
const minterOffList = getAddress('0x' + '99'.repeat(20));

const mintParams = {
  mintPrice: parseEther('0.01'),
  maxTotalMintableByWallet: 2,
  startTime: 1_700_000_000,
  endTime: 1_700_003_600,
  dropStageIndex: 1,
  maxTokenSupplyForStage: 1000n,
  feeBps: 500,
  restrictFeeRecipients: true,
};

function buildTree() {
  const entries: AllowListEntry[] = [
    { minter: minterA, mintParams },
    { minter: getAddress('0x' + '22'.repeat(20)), mintParams },
  ];
  return SeaDropAllowListTree.build(entries);
}

describe('EligibilityChecker', () => {
  it('returns eligible=true with a valid proof and mintParams for a wallet on the list, matching the on-chain root', () => {
    const tree = buildTree();
    const checker = new EligibilityChecker();

    const result = checker.checkEligibility(tree, tree.root, minterA);

    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.proof.length).toBeGreaterThan(0);
      expect(result.mintParams.mintPrice).toBe(parseEther('0.01'));
    }
  });

  it('returns not_on_list for a wallet absent from the tree', () => {
    const tree = buildTree();
    const checker = new EligibilityChecker();

    const result = checker.checkEligibility(tree, tree.root, minterOffList);

    expect(result).toEqual({ eligible: false, reason: 'not_on_list' });
  });

  it('returns root_mismatch when the local tree root does not match the on-chain root', () => {
    const tree = buildTree();
    const checker = new EligibilityChecker();
    const staleOnChainRoot = ('0x' + 'ff'.repeat(32)) as `0x${string}`;

    const result = checker.checkEligibility(tree, staleOnChainRoot, minterA);

    expect(result).toEqual({ eligible: false, reason: 'root_mismatch' });
  });

  it('checks root_mismatch BEFORE checking list membership, so a stale list never produces a false eligible', () => {
    const tree = buildTree();
    const checker = new EligibilityChecker();
    const wrongRoot = ('0x' + 'ff'.repeat(32)) as `0x${string}`;

    // minterA IS on this tree's list, but the tree's root doesn't match on-chain: must fail with
    // root_mismatch, never with a false "eligible".
    const result = checker.checkEligibility(tree, wrongRoot, minterA);

    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe('root_mismatch');
    }
  });
});

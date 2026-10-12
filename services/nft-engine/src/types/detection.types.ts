export interface SeaDropDetectionResult {
  /** ERC165 supportsInterface(0x80ac58cd) succeeded and returned true. False if the call reverted or returned false. */
  isErc721: boolean;
  /** Whether the contract responds to ERC165 supportsInterface at all (didn't revert). */
  supportsErc165: boolean;
  /** SeaDrop has a public-stage drop registered for this contract (startTime !== 0). */
  hasConfiguredPublicDrop: boolean;
  /** SeaDrop has a non-zero allow-list Merkle root registered for this contract. */
  hasConfiguredAllowList: boolean;
  /** Whether this contract has any drop (public or allow-list) registered with SeaDrop. */
  hasAnySeaDropConfiguration: boolean;
}

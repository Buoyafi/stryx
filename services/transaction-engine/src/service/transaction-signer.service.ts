import { signTransaction } from 'viem/accounts';
import type { TransactionSerializable } from 'viem';
import { secureZero, type WalletKeyService, type EncryptedPrivateKeyRecord } from '@stryx/key-management';

/** Looks up the encrypted key record for a wallet. */
export interface WalletKeyRecordProvider {
  getRecord(walletId: string): Promise<EncryptedPrivateKeyRecord>;
}

/** How long a record fetched by `prepare` is held for the next signature. */
const PREPARED_RECORD_TTL_MS = 120_000;

/** Signs a transaction using @stryx/key-management's callback-scoped decryption. */
export class TransactionSigner {
  /** Encrypted records fetched ahead by `prepare`, used once by the next `sign` for that wallet. */
  private readonly prepared = new Map<string, { record: EncryptedPrivateKeyRecord; at: number }>();
  /** Data keys unwrapped ahead by `prepare(..., { holdKeyMs })`: with one of these the next `sign` needs no KMS call. */
  private readonly held = new Map<string, { dek: Buffer; record: EncryptedPrivateKeyRecord; timer: ReturnType<typeof setTimeout> }>();
  /** Bumped by `release`, so a `prepare` still waiting on KMS knows not to keep what it gets. */
  private readonly epochs = new Map<string, number>();

  constructor(
    private readonly walletKeyService: WalletKeyService,
    private readonly recordProvider: WalletKeyRecordProvider,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Gets a wallet ready to sign fast: fetches its encrypted record now and makes one throwaway KMS
   * unwrap, so neither is on the critical path.
   */
  async prepare(walletId: string, opts: { holdKeyMs?: number } = {}): Promise<void> {
    // Read before the first await: a release at any point after this call must win.
    const epoch = this.epochs.get(walletId) ?? 0;
    const record = await this.recordProvider.getRecord(walletId);
    if (!opts.holdKeyMs || opts.holdKeyMs <= 0) {
      await this.walletKeyService.warmUnwrap({ walletId }, record);
      this.prepared.set(walletId, { record, at: this.now() });
      return;
    }

    const dek = await this.walletKeyService.unwrapDekForHold({ walletId }, record);
    if ((this.epochs.get(walletId) ?? 0) !== epoch) {
      secureZero(dek); // released while KMS was answering: nobody is waiting for this key
      return;
    }
    this.dropHeld(walletId);
    const timer = setTimeout(() => this.dropHeld(walletId), opts.holdKeyMs);
    timer.unref?.();
    this.held.set(walletId, { dek, record, timer });
  }

  /** Zeroes a wallet's held data key, if any, and stops a `prepare` in flight from keeping one. */
  release(walletId: string): void {
    this.epochs.set(walletId, (this.epochs.get(walletId) ?? 0) + 1);
    this.dropHeld(walletId);
  }

  /** How many wallets have a data key held right now. */
  heldCount(): number {
    return this.held.size;
  }

  private dropHeld(walletId: string): void {
    const entry = this.held.get(walletId);
    if (!entry) return;
    this.held.delete(walletId);
    clearTimeout(entry.timer);
    secureZero(entry.dek);
  }

  async sign(walletId: string, transaction: TransactionSerializable): Promise<`0x${string}`> {
    const held = this.held.get(walletId);
    if (held) {
      // Used once: out of the map before anything can fail, zeroed whatever happens.
      this.held.delete(walletId);
      clearTimeout(held.timer);
      try {
        return await this.walletKeyService.withPrivateKeyFromDek({ walletId }, held.record, held.dek, async (privateKeyBuffer) => {
          const privateKeyHex = `0x${privateKeyBuffer.toString('hex')}` as `0x${string}`;
          return signTransaction({ privateKey: privateKeyHex, transaction });
        });
      } finally {
        secureZero(held.dek);
      }
    }

    const record = this.takePrepared(walletId) ?? (await this.recordProvider.getRecord(walletId));

    return this.walletKeyService.withDecryptedPrivateKey({ walletId }, record, async (privateKeyBuffer) => {
      const privateKeyHex = `0x${privateKeyBuffer.toString('hex')}` as `0x${string}`;
      return signTransaction({ privateKey: privateKeyHex, transaction });
    });
  }

  /** A prepared record, if one is fresh; removed either way, so it is used at most once. */
  private takePrepared(walletId: string): EncryptedPrivateKeyRecord | null {
    const entry = this.prepared.get(walletId);
    if (!entry) return null;
    this.prepared.delete(walletId);
    return this.now() - entry.at <= PREPARED_RECORD_TTL_MS ? entry.record : null;
  }
}

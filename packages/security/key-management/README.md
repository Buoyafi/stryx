# @stryx/key-management

Envelope encryption and the `KeyManagementProvider` abstraction for wallet private key custody.
Implements ADR-001 §3.1–§3.4. **Read that ADR before touching this package**: the design
choices here (why envelope encryption, why the KEK never leaves KMS, why memory is explicitly
zeroed) are explained there, not repeated in full here.

## The three things this package guarantees

1. **No single-layer compromise yields a usable key.** A database leak alone gives you
   `encryptedPrivateKey` + `wrappedDek`: both useless without a live call to the real KMS. An
   app-server compromise alone gives an attacker the ability to *call* KMS through the app's
   scoped IAM identity, but every call is logged and rate-limitable at the KMS layer, and no
   raw key material is ever cached or persisted app-side to steal directly.

2. **Raw key material cannot accidentally leak out of scope.** `withDecryptedPrivateKey()` is a
   scoped callback, not a method that returns a key. The private key Buffer only exists for the
   duration of your callback and is zeroed in a `finally` block, on success, on your callback
   throwing, and on the KMS call itself failing. This is enforced by the type signature, not by
   a comment asking you to remember to clean up.

3. **Tampered or corrupted ciphertext is rejected, not silently decrypted wrong.** AES-256-GCM's
   auth tag is checked on every decrypt; a mismatch throws `DecryptionIntegrityError` rather than
   returning garbage bytes that might get signed into a transaction.

## Usage

### Wallet creation (encrypt once)

```ts
import { WalletKeyService, AwsKeyManagementProvider } from '@stryx/key-management';
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';

const client = new KMSClient({ region: 'us-east-1' });
const kms = new AwsKeyManagementProvider(
  client,
  {
    encryptCommand: (keyId, plaintext) => new EncryptCommand({ KeyId: keyId, Plaintext: plaintext }),
    decryptCommand: (keyId, ciphertext) => new DecryptCommand({ KeyId: keyId, CiphertextBlob: ciphertext }),
  },
  process.env.KMS_KEY_ID!,
);

const walletKeyService = new WalletKeyService(kms, logger);

const record = await walletKeyService.encryptPrivateKeyForStorage(
  { walletId: wallet.id },
  rawPrivateKeyBuffer, // this buffer is zeroed by the time this call returns: don't reuse it
);

// Persist `record` (encryptedPrivateKey, wrappedDek, iv, authTag, keyVersion) to Postgres.
// Never persist anything else.
```

### Signing (Transaction Engine, pre-sign checkpoint)

```ts
const signedTx = await walletKeyService.withDecryptedPrivateKey(
  { walletId },
  encryptedRecordFromDb,
  async (privateKey) => {
    // privateKey is a raw Buffer, valid ONLY inside this callback.
    // Do the minimum here: sign, and return only the signed transaction,
    // never return or cache the private key itself.
    return signTransaction(txPayload, privateKey);
  },
);
// privateKey and the DEK used to decrypt it are already zeroed at this point,
// whether the callback succeeded or threw.
```

### Rotation

```ts
const rotatedRecord = await walletKeyService.rotateKey({ walletId }, currentRecord);
// Atomically persist rotatedRecord and discard currentRecord together,
// see ADR-001 §3.4 for the scheduled-job rotation cadence.
```

## Choosing a KeyManagementProvider

| Provider | When to use |
|---|---|
| `AwsKeyManagementProvider` | Production, if AWS KMS is the chosen provider. Structurally typed against the AWS SDK: pass a real `KMSClient` plus command constructors, no hard SDK dependency baked into this package. |
| `LocalKeyManagementProvider` | Local development and CI **only**. Keeps its "KEK" in process memory: refuses to construct if `NODE_ENV=production`. Does not meet the ADR-001 threat model; this is a convenience, not a deployment option. |
| GCP / Vault implementations | Not yet implemented. Same pattern as `AwsKeyManagementProvider`: implement `KeyManagementProvider`'s two methods (`wrapDek`/`unwrapDek`) against the relevant SDK. |

## Testing

```
npm test         # 12 tests: envelope encryption round-trips, tamper detection,
                  # memory-zeroing on success/throw/KMS-failure, and full rotation
npm run typecheck
```

The most important tests to read if you're modifying this package are the ones that assert
buffer contents are all-zero *after* a callback throws and *after* a simulated KMS outage,
those are what prove the "never persists raw key material" guarantee holds under failure, not
just the happy path.

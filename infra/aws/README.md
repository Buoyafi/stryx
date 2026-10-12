# AWS KMS setup for production custody (ADR-001 §3.3, ADR-002 §3.8)

This directory holds the infra artifacts for the real KMS cutover: the step
that's required before any user who isn't the operator has funds in this
system. `LOCAL_KMS_KEK` (a hex string in `.env`) is acceptable for solo dev
only; it is not a defensible control once other people's money is behind it.

## What `kms-key-policy.json` is

An **identity-based** IAM policy, attached to the IAM role/user the API's
compute identity assumes, not a KMS key resource policy. It grants exactly
two actions, `kms:Encrypt` and `kms:Decrypt`, on exactly one resource: the
KEK's ARN. No `kms:*`, no key management actions (`CreateKey`, `PutKeyPolicy`,
`ScheduleKeyDeletion`, …), no `GenerateDataKey`: the app calls KMS's direct
Encrypt/Decrypt API on wrapped DEK bytes (see
`apps/api/src/kms-provider.ts`), never `GenerateDataKey`, so the policy
matches what the code actually does rather than a generic "KMS access"
grant. This is the exact scoping ADR-001 §3.3 specifies.

## How to apply it

1. **Create the KMS key** (a symmetric CMK) in whatever AWS account will run
   this in production. Do not reuse a key from another system: this key's
   sole purpose is wrapping Stryx's per-wallet DEKs.
2. **Enable automatic annual rotation** on the CMK (ADR-002 §3.9): this is a
   checkbox/one CLI flag at key creation or any time after
   (`aws kms enable-key-rotation --key-id <id>`), and needs no application
   code to take effect; it rotates the underlying key material AWS-side
   while the key ARN/ID stays the same.
3. **Create (or identify) the IAM role** the API's compute identity will
   assume in production: an EC2 instance role, an ECS/Fargate task role, an
   IRSA role for EKS, or equivalent. Avoid a long-lived IAM user with static
   access keys if the compute platform supports role assumption instead.
4. **Replace `REPLACE_WITH_THE_KEK_ARN`** in `kms-key-policy.json` with the
   real key's ARN, then attach the policy to that role (as an inline policy
   or a managed policy, either is fine; inline is simplest for a
   single-purpose grant like this).
5. **Set the app's environment** to `KMS_PROVIDER=aws` and `KMS_KEY_ID=<the
   same ARN or key ID>`. `packages/config` refuses to start with
   `KMS_PROVIDER=local` when `NODE_ENV=production` (and separately,
   `LocalKeyManagementProvider`'s own constructor refuses to run under
   `NODE_ENV=production` even if something tried to construct it directly),
   both are already enforced in code, not just documented, and both have
   test coverage (`packages/config/tests/config.test.ts`,
   `packages/security/key-management/tests/local-key-management-provider.test.ts`).
6. **Run the integration test** against this real key before trusting it in
   production: see the header comment in
   `apps/api/tests/aws-kms.integration.test.ts` for exact steps. It's skipped
   by default (no AWS credentials needed for the normal test suite) and only
   runs when you explicitly set `AWS_KMS_INTEGRATION_TEST_KEY_ID`.
7. **Run the DEK/KEK rotation procedure once, for real, against this key**
   (ADR-001 §3.4 / ADR-002 §3.9) before launch, rotating a single wallet's
   key via the existing `POST /wallets/:id/rotate-key` endpoint is enough to
   prove the whole path works end to end against live AWS. This is
   explicitly called out in the ADR as something that shouldn't be exercised
   for the first time during a real incident.

Steps 1–4 and 7 need real AWS account access and can't be done from a coding
session: they're the actual remaining checklist items before this cutover
is complete. Everything else (the code paths, the tests, this policy
document) is ready.

export * from './types/wallet.types.js';
export * from './types/user-id.js';
export * from './dto/wallet.dto.js';
export type { WalletRepository, WalletListFilter } from './repository/wallet.repository.js';
export { PrismaWalletRepository, type WalletPrismaDelegate } from './repository/prisma-wallet.repository.js';
export {
  WalletService,
  WalletNotFoundError,
  WalletAddressCollisionError,
  InvalidPrivateKeyError,
  WalletDeletionRefusedError,
  BulkCreateInterruptedError,
  type WalletDeletionCheck,
  type WalletDeletionChecker,
  type Logger,
} from './service/wallet.service.js';
export { walletController, type WalletControllerDeps, type AuditableEvent } from './controller/wallet.controller.js';

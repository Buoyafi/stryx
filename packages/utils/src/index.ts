// Shared pure-function utilities with no business logic.
export { withTimeout, TimeoutBudgetExceededError } from './with-timeout.js';
export { isRpcTransportFailure, isInsufficientFundsFailure } from './classify-rpc-error.js';
export { withRetry, isFetchTransportFailure, describeFetchFailure, type WithRetryOptions } from './with-retry.js';
export { redactUrls, redactUrlsKeepDomain, redactUrlsDeep, redactUrlsInKeys, REDACTED_URL } from './redact-urls.js';

// `./private-key` is not re-exported: it must stay free of viem so the dashboard can import it.

/** Shared event bus contract. */
export interface DomainEvent<TPayload = unknown> {
  /** e.g. 'wallet.created', 'mint.detected', 'transaction.confirmed' */
  type: string;
  /** Schema version for this event type: bump on breaking payload changes. */
  version: number;
  payload: TPayload;
  timestamp: string; // ISO 8601
  correlationId: string;
}

export interface EventBus {
  publish<TPayload>(event: DomainEvent<TPayload>): Promise<void>;
  subscribe<TPayload>(
    eventType: string,
    handler: (event: DomainEvent<TPayload>) => Promise<void> | void,
  ): () => void; // returns an unsubscribe function
}

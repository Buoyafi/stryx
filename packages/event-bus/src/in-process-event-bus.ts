import { EventEmitter } from 'node:events';
import type { DomainEvent, EventBus } from './types.js';

/** In-process implementation of EventBus. */
export class InProcessEventBus implements EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One event can fan out to many handlers.
    this.emitter.setMaxListeners(50);
  }

  async publish<TPayload>(event: DomainEvent<TPayload>): Promise<void> {
    this.emitter.emit(event.type, event);
  }

  subscribe<TPayload>(
    eventType: string,
    handler: (event: DomainEvent<TPayload>) => Promise<void> | void,
  ): () => void {
    const wrapped = (event: DomainEvent<TPayload>): void => {
      void Promise.resolve(handler(event)).catch((err: unknown) => {
        // A failing handler is logged, never swallowed.
        console.error(`[event-bus] handler for "${eventType}" threw`, err);
      });
    };
    this.emitter.on(eventType, wrapped);
    return () => this.emitter.off(eventType, wrapped);
  }
}

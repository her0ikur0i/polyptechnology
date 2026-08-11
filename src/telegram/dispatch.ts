import type { TelegramUpdateHandler, UpdateOrigin } from "./poller.js";

// Runs each handler in turn and lets every one decide for itself whether an
// update is its business. Handlers are deliberately not asked "can you handle
// this?" first: that would put the same shape-detection logic in two places,
// and the two would disagree eventually.
//
// A handler that throws does not stop the ones after it. The poller already
// treats a thrown update as failed and advances past it, so swallowing here
// would hide the failure while changing nothing; rethrowing the first error
// after all handlers have run keeps both properties.
export class CompositeUpdateHandler implements TelegramUpdateHandler {
  constructor(
    private readonly handlers: ReadonlyArray<TelegramUpdateHandler>,
  ) {}

  async handle(update: unknown, origin: UpdateOrigin): Promise<void> {
    let firstFailure: unknown;
    for (const handler of this.handlers) {
      try {
        await handler.handle(update, origin);
      } catch (error) {
        firstFailure ??= error;
        console.error(
          JSON.stringify({
            event: "telegram.handler.failed",
            detail: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }
    if (firstFailure !== undefined) throw firstFailure;
  }
}

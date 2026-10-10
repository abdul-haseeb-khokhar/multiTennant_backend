import { EngineError, EngineStreamEvent } from './engine.types';

export interface StreamDeadlines {
  /** Longest wait until the first `token`, `escalated` or `done` event (D7: 5 s). */
  firstTokenMs: number;
  /** Longest total duration of the stream (D7: 30 s). */
  totalMs: number;
}

/**
 * Enforces the D7 timeouts on any engine stream, real or mock, so both behave the same: when the
 * first answer event or the whole stream takes too long, `abort` is called (it cancels the
 * underlying request) and an `EngineError('timeout')` is thrown. `accepted` does not count as the
 * first token: the engine acknowledges at once and may then spend its time in the model.
 */
export async function* withDeadlines(
  source: AsyncIterable<EngineStreamEvent>,
  deadlines: StreamDeadlines,
  abort: () => void,
): AsyncGenerator<EngineStreamEvent> {
  const iterator = source[Symbol.asyncIterator]();
  const startedAt = Date.now();
  let answering = false;
  let finished = false;
  try {
    for (;;) {
      const elapsed = Date.now() - startedAt;
      const remainingTotal = deadlines.totalMs - elapsed;
      const remaining = answering
        ? remainingTotal
        : Math.min(deadlines.firstTokenMs - elapsed, remainingTotal);
      const limitingFirstToken =
        !answering && deadlines.firstTokenMs - elapsed <= remainingTotal;

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            abort();
            reject(
              new EngineError(
                'timeout',
                limitingFirstToken
                  ? `No answer from the engine within ${deadlines.firstTokenMs} ms`
                  : `The engine stream exceeded ${deadlines.totalMs} ms`,
              ),
            );
          },
          Math.max(remaining, 0),
        );
      });
      let step: IteratorResult<EngineStreamEvent>;
      try {
        step = await Promise.race([iterator.next(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (step.done) {
        finished = true;
        return;
      }
      if (step.value.type !== 'accepted') {
        answering = true;
      }
      yield step.value;
      if (step.value.type === 'done') {
        finished = true;
        return;
      }
    }
  } finally {
    if (!finished) {
      // The consumer stopped early or we timed out: make sure the request is cancelled.
      abort();
    }
    // Do not await: a source blocked on a cancelled request settles by itself.
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

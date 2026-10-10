import { EngineError, EngineStreamEvent } from './engine.types';
import { withDeadlines } from './stream-deadlines';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* source(
  steps: Array<{ wait: number; event: EngineStreamEvent }>,
): AsyncGenerator<EngineStreamEvent> {
  for (const step of steps) {
    await sleep(step.wait);
    yield step.event;
  }
}

const accepted: EngineStreamEvent = {
  type: 'accepted',
  messageId: 'm',
  conversationStatus: 'active',
};
const token: EngineStreamEvent = { type: 'token', text: 'x' };
const done: EngineStreamEvent = {
  type: 'done',
  messageId: 'r',
  conversationStatus: 'active',
  aiReply: true,
};

async function run(
  events: AsyncIterable<EngineStreamEvent>,
  deadlines: { firstTokenMs: number; totalMs: number },
  abort = jest.fn(),
) {
  const seen: string[] = [];
  let error: unknown;
  try {
    for await (const event of withDeadlines(events, deadlines, abort)) {
      seen.push(event.type);
    }
  } catch (caught) {
    error = caught;
  }
  return { seen, error, abort };
}

describe('withDeadlines (D7: first token and total)', () => {
  it('passes a prompt stream through and stops at done', async () => {
    const { seen, error, abort } = await run(
      source([
        { wait: 0, event: accepted },
        { wait: 0, event: token },
        { wait: 0, event: done },
      ]),
      { firstTokenMs: 200, totalMs: 1000 },
    );
    expect(seen).toEqual(['accepted', 'token', 'done']);
    expect(error).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });

  it('"accepted" does not count as the first token', async () => {
    const { seen, error, abort } = await run(
      source([
        { wait: 0, event: accepted },
        { wait: 400, event: token },
      ]),
      { firstTokenMs: 100, totalMs: 1000 },
    );
    expect(seen).toEqual(['accepted']);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).kind).toBe('timeout');
    expect((error as EngineError).message).toMatch(/No answer .* 100 ms/);
    expect(abort).toHaveBeenCalled();
  });

  it('after the first token only the total limit applies', async () => {
    const { seen, error } = await run(
      source([
        { wait: 0, event: token },
        { wait: 150, event: token },
        { wait: 150, event: done },
      ]),
      { firstTokenMs: 100, totalMs: 1000 },
    );
    expect(seen).toEqual(['token', 'token', 'done']);
    expect(error).toBeUndefined();
  });

  it('enforces the total even with a steady trickle', async () => {
    const { error, abort } = await run(
      source(Array.from({ length: 20 }, () => ({ wait: 60, event: token }))),
      { firstTokenMs: 500, totalMs: 250 },
    );
    expect((error as EngineError).kind).toBe('timeout');
    expect((error as EngineError).message).toMatch(/exceeded 250 ms/);
    expect(abort).toHaveBeenCalled();
  });

  it('cancels the request when the consumer stops early', async () => {
    const abort = jest.fn();
    for await (const event of withDeadlines(
      source([
        { wait: 0, event: token },
        { wait: 0, event: token },
      ]),
      { firstTokenMs: 500, totalMs: 1000 },
      abort,
    )) {
      void event;
      break;
    }
    expect(abort).toHaveBeenCalled();
  });

  it('passes through an error thrown by the source', async () => {
    async function* broken(): AsyncGenerator<EngineStreamEvent> {
      yield token;
      throw new EngineError('unavailable', 'stream broke');
    }
    const { seen, error } = await run(broken(), {
      firstTokenMs: 200,
      totalMs: 1000,
    });
    expect(seen).toEqual(['token']);
    expect((error as EngineError).message).toBe('stream broke');
  });
});

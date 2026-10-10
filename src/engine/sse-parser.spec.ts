import { EngineError } from './engine.types';
import { readSse, toWireEvent } from './sse-parser';

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

async function read(...chunks: string[]) {
  const out: Array<{ event: string; data: string }> = [];
  for await (const event of readSse(stream(...chunks))) out.push(event);
  return out;
}

describe('readSse', () => {
  it('splits events on blank lines, whatever the chunking', async () => {
    const expected = [
      { event: 'token', data: '{"text":"a"}' },
      { event: 'done', data: '{}' },
    ];
    const text =
      'event: token\ndata: {"text":"a"}\n\nevent: done\ndata: {}\n\n';
    expect(await read(text)).toEqual(expected);
    expect(await read(...text.split(''))).toEqual(expected);
    expect(await read(text.replace(/\n/g, '\r\n'))).toEqual(expected);
  });

  it('joins multi-line data and ignores comments', async () => {
    expect(
      await read(': ping\n\nevent: token\ndata: line1\ndata: line2\n\n'),
    ).toEqual([{ event: 'token', data: 'line1\nline2' }]);
  });

  it('handles multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode(
      'event: token\ndata: {"text":"اردو"}\n\n',
    );
    const out: Array<{ event: string; data: string }> = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 27));
        controller.enqueue(bytes.slice(27));
        controller.close();
      },
    });
    for await (const event of readSse(body)) out.push(event);
    expect(JSON.parse(out[0].data).text).toBe('اردو');
  });

  it('flushes a final event that has no trailing blank line', async () => {
    expect(await read('event: done\ndata: {}')).toEqual([
      { event: 'done', data: '{}' },
    ]);
  });
});

describe('toWireEvent', () => {
  it('types each event of the contract', () => {
    expect(
      toWireEvent({
        event: 'accepted',
        data: '{"messageId":"m1","conversationStatus":"active"}',
      }),
    ).toEqual({
      type: 'accepted',
      messageId: 'm1',
      conversationStatus: 'active',
    });
    expect(toWireEvent({ event: 'token', data: '{"text":"hi"}' })).toEqual({
      type: 'token',
      text: 'hi',
    });
    expect(
      toWireEvent({
        event: 'usage',
        data: '{"messageId":"m2","tokensIn":10.9,"tokensOut":-3,"model":"x"}',
      }),
    ).toEqual({
      type: 'usage',
      messageId: 'm2',
      tokensIn: 10,
      tokensOut: 0,
      model: 'x',
    });
    expect(
      toWireEvent({
        event: 'done',
        data: '{"messageId":null,"conversationStatus":"escalated","aiReply":false}',
      }),
    ).toEqual({
      type: 'done',
      messageId: null,
      conversationStatus: 'escalated',
      aiReply: false,
    });
    expect(
      toWireEvent({ event: 'error', data: '{"code":"X","message":"m"}' }),
    ).toEqual({ type: 'error', code: 'X', message: 'm' });
  });

  it('skips events it does not know (forward compatible)', () => {
    expect(toWireEvent({ event: 'heartbeat', data: '{}' })).toBeNull();
  });

  it('refuses malformed JSON and missing fields as protocol errors', () => {
    for (const raw of [
      { event: 'token', data: 'not json' },
      { event: 'token', data: '[]' },
      { event: 'token', data: '{"text":5}' },
      { event: 'accepted', data: '{"messageId":"m"}' },
    ]) {
      expect(() => toWireEvent(raw)).toThrow(EngineError);
      try {
        toWireEvent(raw);
      } catch (error) {
        expect((error as EngineError).kind).toBe('protocol');
      }
    }
  });
});

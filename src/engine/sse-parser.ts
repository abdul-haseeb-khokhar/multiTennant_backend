import {
  ConversationStatus,
  EngineError,
  EngineWireEvent,
  EscalationReason,
} from './engine.types';

interface RawEvent {
  event: string;
  data: string;
}

/** Splits a byte stream into server-sent events (`event:` / `data:` fields, blank-line separated). */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = findBoundary(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseBlock(block);
        if (event) yield event;
        boundary = findBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    const last = parseBlock(buffer);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

function findBoundary(text: string) {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(text);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseBlock(block: string): RawEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

const KNOWN_EVENTS = new Set([
  'accepted',
  'token',
  'usage',
  'escalated',
  'done',
  'error',
]);

/**
 * Turns one raw event into a typed one. Unknown event names are skipped (the engine may add
 * events later); malformed JSON or a missing field is a `protocol` error.
 */
export function toWireEvent(raw: RawEvent): EngineWireEvent | null {
  if (!KNOWN_EVENTS.has(raw.event)) return null;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.data);
    if (typeof parsed !== 'object' || parsed === null) throw new Error();
    data = parsed as Record<string, unknown>;
  } catch {
    throw new EngineError('protocol', `Malformed "${raw.event}" event`);
  }
  const text = (key: string) => {
    if (typeof data[key] !== 'string') {
      throw new EngineError(
        'protocol',
        `Event "${raw.event}" is missing "${key}"`,
      );
    }
    return data[key];
  };
  const int = (key: string) =>
    typeof data[key] === 'number' && Number.isFinite(data[key])
      ? Math.max(0, Math.trunc(data[key]))
      : 0;
  switch (raw.event) {
    case 'accepted':
      return {
        type: 'accepted',
        messageId: text('messageId'),
        conversationStatus: text('conversationStatus') as ConversationStatus,
      };
    case 'token':
      return { type: 'token', text: text('text') };
    case 'usage':
      return {
        type: 'usage',
        messageId: text('messageId'),
        tokensIn: int('tokensIn'),
        tokensOut: int('tokensOut'),
        ...(typeof data.model === 'string' && { model: data.model }),
        ...(typeof data.latencyMs === 'number' && {
          latencyMs: int('latencyMs'),
        }),
      };
    case 'escalated':
      return {
        type: 'escalated',
        reason: text('reason') as EscalationReason,
        ...(typeof data.summary === 'string' && { summary: data.summary }),
      };
    case 'done':
      return {
        type: 'done',
        messageId: typeof data.messageId === 'string' ? data.messageId : null,
        conversationStatus: text('conversationStatus') as ConversationStatus,
        aiReply: data.aiReply === true,
      };
    default:
      return {
        type: 'error',
        code: typeof data.code === 'string' ? data.code : 'ENGINE_ERROR',
        message: typeof data.message === 'string' ? data.message : '',
      };
  }
}

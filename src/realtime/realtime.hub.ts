import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/** One event on a channel. `id` is what a client sends back as `Last-Event-ID` to resume. */
export interface HubEvent {
  id: string;
  event: string;
  data: Record<string, unknown>;
  /** Staff channel only: deliver to this user's streams alone (for example `notification.created`). */
  userId?: string;
}

export type HubListener = (event: HubEvent) => void;

export interface Subscription {
  /**
   * Events the client missed since `lastEventId` (oldest first), or `resync` when the id is from
   * another run of the server or older than what is remembered: the client must re-read its state.
   */
  replay: HubEvent[] | 'resync';
  unsubscribe: () => void;
}

export const staffChannel = (tenantId: string) => `staff:${tenantId}`;
export const widgetChannel = (tenantId: string, conversationId: string) =>
  `widget:${tenantId}:${conversationId}`;

interface ChannelState {
  seq: number;
  buffer: HubEvent[];
  listeners: Map<HubListener, { userId?: string }>;
  touchedAt: number;
  recentKeys: Set<string>;
}

/** Events remembered per channel for `Last-Event-ID` resume. */
const BUFFER_SIZE = 100;
/** Duplicate suppression window per channel. */
const DEDUPE_KEYS = 200;
const MAX_CHANNELS = 20_000;
/** A channel nobody listens to is forgotten after this long without an event. */
const IDLE_TTL_MS = 15 * 60_000;

/**
 * The in-process fan-out behind the dashboard stream (`GET /v1/tenants/:id/events`) and the widget
 * stream (`GET /v1/widget/events`). One channel per tenant for staff and one per conversation for
 * the customer. It lives in this process's memory: with several backend instances an event reaches
 * only the streams connected to the instance that received it, so a deployment with more than one
 * instance needs a shared bus (Redis pub/sub, Phase 8). Events carry ids, never message text for
 * staff; the widget channel carries the text of staff replies and system lines, which the customer
 * is meant to see.
 *
 * Resume: ids are `<run>-<n>`; `run` is random per process start, so an id from before a restart
 * gets `resync` instead of a gap that looks complete.
 */
@Injectable()
export class RealtimeHub {
  private readonly run = randomBytes(4).toString('hex');
  private readonly channels = new Map<string, ChannelState>();

  /**
   * Publishes to everyone listening on `channel` and remembers it for resume. `dedupeKey` drops a
   * repeat of the same logical event (it is remembered per channel for a while).
   */
  publish(
    channel: string,
    event: string,
    data: Record<string, unknown>,
    options: { userId?: string; dedupeKey?: string } = {},
  ): HubEvent | null {
    const state = this.state(channel);
    if (options.dedupeKey) {
      if (state.recentKeys.has(options.dedupeKey)) return null;
      state.recentKeys.add(options.dedupeKey);
      if (state.recentKeys.size > DEDUPE_KEYS) {
        // Sets iterate in insertion order: drop the oldest key.
        state.recentKeys.delete(state.recentKeys.values().next().value!);
      }
    }
    state.seq += 1;
    const hubEvent: HubEvent = {
      id: `${this.run}-${state.seq}`,
      event,
      data,
      ...(options.userId && { userId: options.userId }),
    };
    state.buffer.push(hubEvent);
    if (state.buffer.length > BUFFER_SIZE) state.buffer.shift();
    state.touchedAt = Date.now();
    for (const [listener, filter] of state.listeners) {
      if (hubEvent.userId && filter.userId !== hubEvent.userId) continue;
      try {
        listener(hubEvent);
      } catch {
        // one broken stream must not stop the others
      }
    }
    this.sweep();
    return hubEvent;
  }

  /**
   * Starts listening. `userId` (staff channel) limits the stream to events addressed to nobody in
   * particular or to that user.
   */
  subscribe(
    channel: string,
    listener: HubListener,
    options: { lastEventId?: string; userId?: string } = {},
  ): Subscription {
    const state = this.state(channel);
    const replay = this.missed(state, options.lastEventId, options.userId);
    state.listeners.set(listener, { userId: options.userId });
    return {
      replay,
      unsubscribe: () => {
        state.listeners.delete(listener);
      },
    };
  }

  /** Number of live listeners on a channel (tests, diagnostics). */
  listenerCount(channel: string) {
    return this.channels.get(channel)?.listeners.size ?? 0;
  }

  channelCount() {
    return this.channels.size;
  }

  // -------------------------------------------------------------------------------------------

  private missed(
    state: ChannelState,
    lastEventId: string | undefined,
    userId: string | undefined,
  ): HubEvent[] | 'resync' {
    if (!lastEventId) return [];
    const match = /^([0-9a-f]+)-(\d+)$/.exec(lastEventId);
    if (!match || match[1] !== this.run) return 'resync';
    const last = Number(match[2]);
    if (last >= state.seq) return [];
    const oldest = state.buffer.length
      ? Number(state.buffer[0].id.split('-')[1])
      : state.seq + 1;
    if (oldest > last + 1) return 'resync';
    return state.buffer.filter(
      (e) =>
        Number(e.id.split('-')[1]) > last && (!e.userId || e.userId === userId),
    );
  }

  private state(channel: string): ChannelState {
    let state = this.channels.get(channel);
    if (!state) {
      state = {
        seq: 0,
        buffer: [],
        listeners: new Map(),
        touchedAt: Date.now(),
        recentKeys: new Set(),
      };
      this.channels.set(channel, state);
    }
    return state;
  }

  /** Forgets channels nobody listens to: by age, and the oldest ones if there are still too many. */
  private sweep() {
    if (this.channels.size <= MAX_CHANNELS) return;
    const now = Date.now();
    for (const [name, state] of this.channels) {
      if (state.listeners.size === 0 && now - state.touchedAt > IDLE_TTL_MS) {
        this.channels.delete(name);
      }
    }
    for (const [name, state] of this.channels) {
      if (this.channels.size <= MAX_CHANNELS) break;
      if (state.listeners.size === 0) this.channels.delete(name);
    }
  }
}

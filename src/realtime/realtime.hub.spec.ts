import { RealtimeHub, staffChannel, widgetChannel } from './realtime.hub';

describe('RealtimeHub', () => {
  let hub: RealtimeHub;
  beforeEach(() => {
    hub = new RealtimeHub();
  });

  it('delivers an event to every listener of that channel and to nobody else', () => {
    const a = jest.fn();
    const b = jest.fn();
    const other = jest.fn();
    hub.subscribe(staffChannel('t1'), a);
    hub.subscribe(staffChannel('t1'), b);
    hub.subscribe(staffChannel('t2'), other);
    hub.publish(staffChannel('t1'), 'conversation.escalated', {
      conversationId: 'c1',
    });
    expect(a).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'conversation.escalated',
        data: { conversationId: 'c1' },
        id: expect.stringMatching(/^[0-9a-f]+-1$/),
      }),
    );
    expect(b).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it('keeps the staff channel of a tenant apart from the widget channel of its conversation', () => {
    const staff = jest.fn();
    const widget = jest.fn();
    hub.subscribe(staffChannel('t1'), staff);
    hub.subscribe(widgetChannel('t1', 'c1'), widget);
    hub.publish(widgetChannel('t1', 'c1'), 'message', { id: 'm1' });
    expect(widget).toHaveBeenCalledTimes(1);
    expect(staff).not.toHaveBeenCalled();
    expect(widgetChannel('t1', 'c1')).not.toBe(widgetChannel('t2', 'c1'));
  });

  it('stops delivering after unsubscribe', () => {
    const listener = jest.fn();
    const { unsubscribe } = hub.subscribe('ch', listener);
    hub.publish('ch', 'a', {});
    unsubscribe();
    hub.publish('ch', 'a', {});
    expect(listener).toHaveBeenCalledTimes(1);
    expect(hub.listenerCount('ch')).toBe(0);
  });

  it('a throwing listener does not stop the others', () => {
    const good = jest.fn();
    hub.subscribe('ch', () => {
      throw new Error('broken stream');
    });
    hub.subscribe('ch', good);
    expect(() => hub.publish('ch', 'a', {})).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  describe('events addressed to one user', () => {
    it('only that user receives them, live and on replay', () => {
      const mine = jest.fn();
      const theirs = jest.fn();
      const first = hub.publish('ch', 'start', {})!;
      hub.subscribe('ch', mine, { userId: 'u1' });
      hub.subscribe('ch', theirs, { userId: 'u2' });
      hub.publish(
        'ch',
        'notification.created',
        { notificationId: 'n1' },
        { userId: 'u1' },
      );
      hub.publish('ch', 'conversation.resolved', { conversationId: 'c1' });
      expect(mine.mock.calls.map(([e]) => e.event)).toEqual([
        'notification.created',
        'conversation.resolved',
      ]);
      expect(theirs.mock.calls.map(([e]) => e.event)).toEqual([
        'conversation.resolved',
      ]);

      const replayFor = (userId: string) => {
        const sub = hub.subscribe('ch', () => undefined, {
          lastEventId: first.id,
          userId,
        });
        return sub.replay === 'resync'
          ? sub.replay
          : sub.replay.map((e) => e.event);
      };
      expect(replayFor('u1')).toEqual([
        'notification.created',
        'conversation.resolved',
      ]);
      expect(replayFor('u2')).toEqual(['conversation.resolved']);
    });
  });

  describe('Last-Event-ID resume', () => {
    it('replays what happened after the given id, oldest first', () => {
      const one = hub.publish('ch', 'one', {})!;
      hub.publish('ch', 'two', {});
      hub.publish('ch', 'three', {});
      const { replay } = hub.subscribe('ch', () => undefined, {
        lastEventId: one.id,
      });
      expect(replay).not.toBe('resync');
      expect((replay as { event: string }[]).map((e) => e.event)).toEqual([
        'two',
        'three',
      ]);
    });

    it('replays nothing when the client is up to date or sends no id', () => {
      const last = hub.publish('ch', 'one', {})!;
      expect(
        hub.subscribe('ch', () => undefined, { lastEventId: last.id }).replay,
      ).toEqual([]);
      expect(hub.subscribe('ch', () => undefined).replay).toEqual([]);
    });

    it('asks for a resync when the id is from another run of the server', () => {
      hub.publish('ch', 'one', {});
      expect(
        hub.subscribe('ch', () => undefined, { lastEventId: 'deadbeef-1' })
          .replay,
      ).toBe('resync');
      const restarted = new RealtimeHub();
      const old = hub.publish('ch', 'two', {})!;
      expect(
        restarted.subscribe('ch', () => undefined, { lastEventId: old.id })
          .replay,
      ).toBe('resync');
    });

    it.each(['garbage', '1', '-1', 'abc-xyz', '12ab-'])(
      'asks for a resync for the malformed id %p',
      (lastEventId) => {
        expect(
          hub.subscribe('ch', () => undefined, { lastEventId }).replay,
        ).toBe('resync');
      },
    );

    it('asks for a resync when the client is older than the 100 events remembered', () => {
      const first = hub.publish('ch', 'first', {})!;
      for (let i = 0; i < 150; i++) hub.publish('ch', 'filler', { i });
      expect(
        hub.subscribe('ch', () => undefined, { lastEventId: first.id }).replay,
      ).toBe('resync');
      // but a client that is only slightly behind can still be caught up
      const recent = hub.publish('ch', 'recent', {})!;
      hub.publish('ch', 'after', {});
      const { replay } = hub.subscribe('ch', () => undefined, {
        lastEventId: recent.id,
      });
      expect((replay as { event: string }[]).map((e) => e.event)).toEqual([
        'after',
      ]);
    });
  });

  describe('duplicate suppression', () => {
    it('drops a repeat of the same logical event but not a different one', () => {
      const listener = jest.fn();
      hub.subscribe('ch', listener);
      expect(
        hub.publish('ch', 'message', { id: 'm1' }, { dedupeKey: 'message:m1' }),
      ).not.toBeNull();
      expect(
        hub.publish('ch', 'message', { id: 'm1' }, { dedupeKey: 'message:m1' }),
      ).toBeNull();
      expect(
        hub.publish('ch', 'message', { id: 'm2' }, { dedupeKey: 'message:m2' }),
      ).not.toBeNull();
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('is per channel', () => {
      expect(hub.publish('a', 'm', {}, { dedupeKey: 'k' })).not.toBeNull();
      expect(hub.publish('b', 'm', {}, { dedupeKey: 'k' })).not.toBeNull();
    });
  });
});

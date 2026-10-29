import {
  REQUEST_STATUSES,
  RequestActor,
  RequestStatus,
  allowedMoves,
  engineMayEdit,
  evaluateMove,
  isRequestStatus,
  staffActionOf,
} from './state-machine';

/** Every (from, to) pair of the workflow, for each actor: the table the service must follow. */
const STAFF: Array<[RequestStatus, RequestStatus, boolean]> = [
  ['requested', 'confirmed', true],
  ['requested', 'cancelled', true],
  ['requested', 'done', false],
  ['confirmed', 'done', true],
  ['confirmed', 'cancelled', true],
  ['confirmed', 'requested', true],
  ['done', 'confirmed', true],
  ['done', 'requested', false],
  ['done', 'cancelled', false],
  ['cancelled', 'requested', true],
  ['cancelled', 'confirmed', false],
  ['cancelled', 'done', false],
];

const ENGINE: Array<[RequestStatus, RequestStatus, boolean]> = [
  ['requested', 'cancelled', true],
  ['requested', 'confirmed', false],
  ['requested', 'done', false],
  ['confirmed', 'cancelled', false],
  ['confirmed', 'requested', false],
  ['confirmed', 'done', false],
  ['done', 'confirmed', false],
  ['done', 'cancelled', false],
  ['cancelled', 'requested', false],
  ['cancelled', 'confirmed', false],
];

describe('request state machine (his B4)', () => {
  it.each(STAFF)('staff: %s -> %s allowed=%s', (from, to, allowed) => {
    expect(evaluateMove('staff', from, to).ok).toBe(allowed);
  });

  it.each(ENGINE)('engine: %s -> %s allowed=%s', (from, to, allowed) => {
    expect(evaluateMove('engine', from, to).ok).toBe(allowed);
  });

  it('covers every ordered pair of different statuses for both actors', () => {
    for (const actor of ['staff', 'engine'] as RequestActor[]) {
      const table = actor === 'staff' ? STAFF : ENGINE;
      for (const from of REQUEST_STATUSES) {
        for (const to of REQUEST_STATUSES) {
          if (from === to) continue;
          const row = table.find(([f, t]) => f === from && t === to);
          // The engine table lists only the pairs worth naming; the rest follows from allowedMoves.
          const expected = row ? row[2] : false;
          expect([actor, from, to, evaluateMove(actor, from, to).ok]).toEqual([
            actor,
            from,
            to,
            expected,
          ]);
        }
      }
    }
  });

  it('exactly his transitions for a person', () => {
    expect(
      Object.fromEntries(
        REQUEST_STATUSES.map((s) => [s, [...allowedMoves('staff', s)].sort()]),
      ),
    ).toEqual({
      requested: ['cancelled', 'confirmed'],
      confirmed: ['cancelled', 'done', 'requested'],
      done: ['confirmed'],
      cancelled: ['requested'],
    });
  });

  it('the engine can only withdraw, and only while the request is requested', () => {
    expect(allowedMoves('engine', 'requested')).toEqual(['cancelled']);
    for (const s of ['confirmed', 'done', 'cancelled'] as RequestStatus[]) {
      expect(allowedMoves('engine', s)).toEqual([]);
    }
  });

  it('a move to the same status is "same" for everyone', () => {
    for (const s of REQUEST_STATUSES) {
      expect(evaluateMove('staff', s, s)).toEqual({
        ok: false,
        reason: 'same',
      });
      expect(evaluateMove('engine', s, s)).toEqual({
        ok: false,
        reason: 'same',
      });
    }
  });

  it('a refused move says why: "not_allowed" for a person, "locked" for the engine', () => {
    expect(evaluateMove('staff', 'requested', 'done')).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(evaluateMove('engine', 'confirmed', 'cancelled')).toEqual({
      ok: false,
      reason: 'locked',
    });
  });

  it('the engine may edit the details only while the request is requested', () => {
    expect(engineMayEdit('requested')).toBe(true);
    expect(engineMayEdit('confirmed')).toBe(false);
    expect(engineMayEdit('done')).toBe(false);
    expect(engineMayEdit('cancelled')).toBe(false);
  });

  it('names the audit action by where the move lands', () => {
    expect(staffActionOf('confirmed')).toBe('confirmed');
    expect(staffActionOf('done')).toBe('done');
    expect(staffActionOf('cancelled')).toBe('cancelled');
    expect(staffActionOf('requested')).toBe('reopened');
  });

  it('recognises a status', () => {
    expect(isRequestStatus('done')).toBe(true);
    expect(isRequestStatus('DONE')).toBe(false);
    expect(isRequestStatus(undefined)).toBe(false);
  });
});

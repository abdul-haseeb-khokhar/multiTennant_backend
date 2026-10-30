/**
 * The workflow of a request (Phase 5B-2, his B4, L1): PURE, no database and no clock, so every move is
 * a row in a table test (`state-machine.spec.ts`). The service applies a move with a conditional update
 * (`UPDATE … WHERE id AND tenant_id AND status = :the status that was read`), so two people acting at
 * once cannot both win. Add or change a move HERE, never inline in a service.
 *
 * The AI never confirms anything (L1): the engine creates a request as `requested`, may change its
 * details while it is still `requested`, and may cancel it for the caller ("forget it") while it is
 * still `requested`. Everything else is a person on the staff screen. The moves are exactly the ones
 * the engine's own stand-in has (docs/handoff-to-backend.md B4).
 */
export const REQUEST_STATUSES = [
  'requested',
  'confirmed',
  'done',
  'cancelled',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * What the AI can take on a call. `order` (a restaurant order: dishes from the owner's menu, pickup or
 * delivery) was added in Phase 5B-3 when the engine built it; the workflow below is the same for every
 * type, and the type-specific content lives in the engine's own `data` document (prices are not in it:
 * the team confirms them with the caller).
 */
export const REQUEST_TYPES = ['appointment', 'callback', 'order'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/** Who is making the move: the AI engine (through the internal routes) or a staff member. */
export type RequestActor = 'engine' | 'staff';

/** Where a person may move a request. A cancelled one can be reopened; nothing skips `confirmed` on the way to `done`. */
const STAFF_MOVES: Record<RequestStatus, readonly RequestStatus[]> = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['done', 'cancelled', 'requested'],
  done: ['confirmed'],
  cancelled: ['requested'],
};

/** Where the engine may move a request: only the caller withdrawing it, and only while nobody acted on it. */
const ENGINE_MOVES: Record<RequestStatus, readonly RequestStatus[]> = {
  requested: ['cancelled'],
  confirmed: [],
  done: [],
  cancelled: [],
};

export function allowedMoves(
  actor: RequestActor,
  from: RequestStatus,
): readonly RequestStatus[] {
  return (actor === 'staff' ? STAFF_MOVES : ENGINE_MOVES)[from];
}

export type MoveVerdict =
  | { ok: true }
  | {
      ok: false;
      /**
       * `same`: the request is already there (a colleague got in first, or a double click);
       * `not_allowed`: the workflow has no such move from this status;
       * `locked`: the ENGINE may not touch the request any more (a person acted on it).
       */
      reason: 'same' | 'not_allowed' | 'locked';
    };

/** May `actor` move a request that is `from` to `to`? */
export function evaluateMove(
  actor: RequestActor,
  from: RequestStatus,
  to: RequestStatus,
): MoveVerdict {
  if (from === to) return { ok: false, reason: 'same' };
  if (allowedMoves(actor, from).includes(to)) return { ok: true };
  // For the engine, "not allowed" has one cause: a person already acted on it (or it was cancelled).
  return { ok: false, reason: actor === 'engine' ? 'locked' : 'not_allowed' };
}

/** May the engine still change the details of a request in this status? Only before a person acted. */
export function engineMayEdit(status: RequestStatus): boolean {
  return status === 'requested';
}

export type StaffAction = 'confirmed' | 'done' | 'cancelled' | 'reopened';

/**
 * The audit name of a staff move, by where it lands: `request.confirmed` (including `done` back to
 * `confirmed`), `request.done`, `request.cancelled`, and `request.reopened` for any move back to
 * `requested`.
 */
export function staffActionOf(to: RequestStatus): StaffAction {
  switch (to) {
    case 'confirmed':
      return 'confirmed';
    case 'done':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    case 'requested':
      return 'reopened';
  }
}

export function isRequestStatus(value: unknown): value is RequestStatus {
  return (
    typeof value === 'string' &&
    (REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

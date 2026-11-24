// Photo moderation as a state machine (PRD P0-6: "pre/post, takedown with undo"). PURE.
//
// An event is moderated one of two ways. `post` (the default): a photo is live the moment it is stored, and someone
// removes it on sight. `pre`: a photo waits, pending, until someone approves it. The mode decides only where a photo
// STARTS; the moves are the same in both, so switching an event's mode strands nothing:
//
//   pending --approve--> live          pending --reject--> removed (from pending)
//   live --take_down--> removed (from live)
//   removed --undo--> whatever it was removed from
//
// A purged photo (its bytes are gone, retention) takes no move. Hiding from the wall and hiding from the album are
// two independent flags on a live photo; neither is a state.

export const MODES = ['pre', 'post'] as const;
export type Mode = (typeof MODES)[number];
export const STATUSES = ['pending', 'live', 'removed'] as const;
export type Status = (typeof STATUSES)[number];
export const ACTIONS = ['approve', 'reject', 'take_down', 'undo'] as const;
export type Action = (typeof ACTIONS)[number];

export type PhotoState = { status: Status; removedFrom: 'pending' | 'live' | null };
export const MODERATION_PROBLEM = {
  'not-pending': 'That photo is not waiting for a decision.',
  'not-live': 'That photo is not on the wall.',
  'not-removed': 'That photo has not been removed.',
  purged: 'That photo has been deleted for good (retention); nothing can be done with it.',
} as const;
export type ModerationProblem = keyof typeof MODERATION_PROBLEM;
export type Moved = { ok: true; next: PhotoState } | { ok: false; code: ModerationProblem };

/** Where a new photo starts. */
export const initialStatus = (mode: Mode): Status => (mode === 'pre' ? 'pending' : 'live');

/** One move. `mode` is an argument so the table is total over (state, action, mode); no move depends on it today. */
export function moderate(state: PhotoState, action: Action, _mode: Mode, purged = false): Moved {
  if (purged) return { ok: false, code: 'purged' };
  switch (action) {
    case 'approve':
      return state.status === 'pending' ? { ok: true, next: { status: 'live', removedFrom: null } } : { ok: false, code: 'not-pending' };
    case 'reject':
      return state.status === 'pending' ? { ok: true, next: { status: 'removed', removedFrom: 'pending' } } : { ok: false, code: 'not-pending' };
    case 'take_down':
      return state.status === 'live' ? { ok: true, next: { status: 'removed', removedFrom: 'live' } } : { ok: false, code: 'not-live' };
    case 'undo':
      return state.status === 'removed' && state.removedFrom ? { ok: true, next: { status: state.removedFrom, removedFrom: null } } : { ok: false, code: 'not-removed' };
  }
}

export type Shown = { status: Status; hiddenFromWall: boolean; hiddenFromAlbum: boolean; purged: boolean };
/** On the wall: live, not hidden from the wall, bytes still there. The album flag plays no part. */
export const onWall = (p: Shown) => p.status === 'live' && !p.hiddenFromWall && !p.purged;
/** In the album (and its download): live, not hidden from the album, bytes still there. The wall flag plays no part. */
export const inAlbum = (p: Shown) => p.status === 'live' && !p.hiddenFromAlbum && !p.purged;

/** The four legal states a stored photo can be in. */
export const STATES: PhotoState[] = [
  { status: 'pending', removedFrom: null },
  { status: 'live', removedFrom: null },
  { status: 'removed', removedFrom: 'pending' },
  { status: 'removed', removedFrom: 'live' },
];

/** The whole table, for fixtures/photos/moderation.json: every state × action × mode, and the purged row of each. */
export function table() {
  return {
    initial: Object.fromEntries(MODES.map((m) => [m, initialStatus(m)])),
    moves: MODES.flatMap((mode) => STATES.flatMap((state) => ACTIONS.flatMap((action) => [false, true].map((purged) => ({ mode, state, action, purged, expect: moderate(state, action, mode, purged) }))))),
    visibility: STATUSES.flatMap((status) => [false, true].flatMap((hiddenFromWall) => [false, true].flatMap((hiddenFromAlbum) => [false, true].map((purged) => {
      const p = { status, hiddenFromWall, hiddenFromAlbum, purged };
      return { ...p, wall: onWall(p), album: inAlbum(p) };
    })))),
  };
}

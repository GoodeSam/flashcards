// 5-box Leitner SRS state machine (v2 plan §4)
// Pure module — no DOM, no storage. State in / state out.

const DAY = 86400 * 1000;
const MIN = 60 * 1000;

// box index → next-due interval (ms). box=1 means "fresh/again".
const BOX_INTERVAL = [null, 1 * DAY, 2 * DAY, 4 * DAY, 8 * DAY, 16 * DAY];
const AGAIN_DELAY = 5 * MIN;
const HARD_DELAY = 1 * DAY;
const GRADUATE_BOX = 5;
const STRETCH_DELAY = 7 * DAY;

// ── Time-scale (testing mode) ───────────────────────────────────────
// 1 = real time. 24 = 1 day compresses to 1 hour (5 min → ~12 s).
// Only new `due` stamps are scaled; already-scheduled cards are not rewritten.
let timeScale = 1;
export function getTimeScale() { return timeScale; }
export function setTimeScale(scale) {
  const n = Number(scale);
  timeScale = Number.isFinite(n) && n >= 1 ? n : 1;
}
function scaled(ms) { return ms / timeScale; }

export const Eval = Object.freeze({
  Again: "Again",
  Hard: "Hard",
  Good: "Good",
  Easy: "Easy",
});

/** Initialize a new card state. */
export function newCardState(now = Date.now()) {
  return {
    box: 0, // 0 = unseen
    due: now,
    history: [],
    graduated: false,
  };
}

/** Apply user evaluation to a card state, returning new state. */
export function applyEval(state, evalKey, now = Date.now()) {
  const s = { ...state, history: [...(state.history || [])] };
  s.history.push({ ts: now, e: evalKey });
  s.lastReviewTs = now;

  switch (evalKey) {
    case Eval.Again:
      s.box = 1;
      s.due = now + scaled(AGAIN_DELAY);
      s.graduated = false;
      break;
    case Eval.Hard:
      s.box = Math.max(s.box, 1);
      s.due = now + scaled(HARD_DELAY);
      break;
    case Eval.Good:
      s.box = Math.min(s.box + 1, GRADUATE_BOX);
      s.due = now + scaled(intervalFor(s.box));
      break;
    case Eval.Easy:
      s.box = Math.min(s.box + 2, GRADUATE_BOX);
      s.due = now + scaled(intervalFor(s.box));
      break;
    default:
      throw new Error(`Unknown eval: ${evalKey}`);
  }

  // Graduation: box5 + at least one Good/Easy review at +16d → archive
  if (s.box === GRADUATE_BOX) {
    const successAtBox5 = s.history.filter(
      (h) => (h.e === Eval.Good || h.e === Eval.Easy) && h.ts === now,
    ).length;
    if (successAtBox5 > 0 && (state.box ?? 0) === GRADUATE_BOX) {
      s.graduated = true;
      s.due = now + scaled(STRETCH_DELAY);
    }
  }
  return s;
}

function intervalFor(box) {
  return BOX_INTERVAL[box] ?? BOX_INTERVAL[GRADUATE_BOX];
}

/** Pick the next card to show. Priority: due reviews → new cards. */
export function pickNext(cards, states, opts = {}) {
  const now = opts.now ?? Date.now();
  const newLimit = opts.newLimit ?? 20;
  const reviewLimit = opts.reviewLimit ?? 20;
  const newToday = opts.newToday ?? 0;
  const reviewedToday = opts.reviewedToday ?? 0;

  // Due reviews come first (already-seen, due now)
  const dueReviews = cards.filter((c) => {
    const s = states[c.id];
    return s && s.box >= 1 && !s.graduated && s.due <= now;
  });
  if (dueReviews.length && reviewedToday < reviewLimit) {
    // pick the most-overdue
    dueReviews.sort((a, b) => states[a.id].due - states[b.id].due);
    return { card: dueReviews[0], kind: "review" };
  }

  // New cards next (in tier order)
  if (newToday < newLimit) {
    const fresh = cards.find((c) => !states[c.id] || states[c.id].box === 0);
    if (fresh) return { card: fresh, kind: "new" };
  }

  // Session done
  return { card: null, kind: "done" };
}

/** Aggregate progress for a tier. */
export function progressStats(cards, states) {
  const total = cards.length;
  let seen = 0;
  const boxCounts = [0, 0, 0, 0, 0, 0]; // index = box
  let graduated = 0;
  for (const c of cards) {
    const s = states[c.id];
    if (!s || s.box === 0) continue;
    seen += 1;
    boxCounts[s.box] = (boxCounts[s.box] || 0) + 1;
    if (s.graduated) graduated += 1;
  }
  const box3plus = boxCounts.slice(3).reduce((a, b) => a + b, 0);
  return {
    total,
    seen,
    unseen: total - seen,
    boxCounts,
    graduated,
    productiveUnlocked: total > 0 && box3plus / total >= 0.8,
    box3PlusRatio: total > 0 ? box3plus / total : 0,
  };
}

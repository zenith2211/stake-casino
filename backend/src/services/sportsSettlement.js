/**
 * SPORTS BET SETTLEMENT SERVICE
 *
 * Settles `pending` SportsBet documents against real match results pulled from
 * the-odds-api /scores endpoint (final scores available up to 3 days back).
 *
 * Flow:
 *   1. Collect all distinct (sportKey, matchId) pairs across pending bets.
 *   2. For each sport with pending bets, fetch /scores?daysFrom=3.
 *   3. For each finished match, determine the winning team (h2h / moneyline).
 *   4. Mark each selection won/lost; a tie/no-result-but-completed match voids
 *      that leg (odds treated as 1.0 — standard bookmaker rule).
 *   5. When every selection in a bet is resolved, settle the bet:
 *        - all legs won            → payout = stake * totalOdds (effective)
 *        - any leg lost            → payout = 0  (lost)
 *        - all remaining legs void → payout = stake (void / refund)
 *      Voided legs reduce the effective odds to 1.0 for that leg.
 *
 * Credit-safety: only sports that actually have pending bets are polled, and the
 * scores endpoint is cached briefly so a burst of settlement runs doesn't spend
 * extra credits.
 */

const SportsBet = require('../models/SportsBet');
const db = require('../config/db');

const ODDS_API_KEY  = process.env.ODDS_API_KEY || '';
const ODDS_API_HOST = 'https://api.the-odds-api.com/v4';

const scoresCache = new Map();         // sportKey -> { data, ts }
const SCORES_TTL  = 5 * 60 * 1000;     // 5 min — settlement runs more often than this

// Approximate wall-clock duration of a match per sport, in minutes, from
// commence_time until a final result is realistically available. Generous on
// purpose (stoppages, extra time, innings breaks) so we don't poll too early.
const SPORT_DURATION_MIN = {
  basketball_nba:            180,   // ~2.5h game + buffer
  americanfootball_nfl:      240,
  icehockey_nhl:             210,
  baseball_mlb:              240,
  soccer_epl:                150,   // 90m + half-time + stoppage + buffer
  soccer_uefa_champs_league: 180,   // possible extra time
  soccer_spain_la_liga:      150,
  soccer_germany_bundesliga: 150,
  soccer_italy_serie_a:      150,
  soccer_france_ligue_1:     150,
  soccer_usa_mls:            150,
  cricket_ipl:               240,   // T20 ~3.5h + breaks
  mma_mixed_martial_arts:    180,   // card timing varies
  boxing_boxing:             180,
  rugby_union_world_cup:     150,
  tennis_wta_us_open:        240,   // best-of can run long
  tennis_wta_wimbledon:      240,
};
const DEFAULT_DURATION_MIN = 240;   // fallback for unknown sports: 4h

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// Earliest time a sport's pending matches could be finished, given their
// commence times. Returns the soonest "ready" timestamp (ms), or 0 if any
// pending leg has no commence time (then we can't gate → poll to be safe).
function earliestReadyTime(sportKey, pendingBets) {
  const durMs = (SPORT_DURATION_MIN[sportKey] || DEFAULT_DURATION_MIN) * 60 * 1000;
  let soonest = Infinity;
  let sawUnknown = false;
  for (const bet of pendingBets) {
    for (const sel of bet.selections) {
      if (sel.status !== 'pending' || sel.sportKey !== sportKey) continue;
      if (!sel.commenceTime) { sawUnknown = true; continue; }
      const ready = new Date(sel.commenceTime).getTime() + durMs;
      if (ready < soonest) soonest = ready;
    }
  }
  if (sawUnknown) return 0;            // unknown start → don't gate, poll anyway
  return soonest === Infinity ? Infinity : soonest;
}

async function fetchScores(sportKey) {
  const cached = scoresCache.get(sportKey);
  if (cached && Date.now() - cached.ts < SCORES_TTL) return cached.data;

  if (!ODDS_API_KEY) throw new Error('ODDS_API_KEY not configured');
  const url = `${ODDS_API_HOST}/sports/${sportKey}/scores/?apiKey=${ODDS_API_KEY}&daysFrom=3&dateFormat=iso`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`scores ${res.status}: ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  scoresCache.set(sportKey, { data, ts: Date.now() });
  return data;
}

/**
 * Given a finished event from /scores, return:
 *   { decided: true, winner: 'Team Name' } for a clear h2h winner,
 *   { decided: true, winner: null }        for a tie/draw → void,
 *   { decided: false }                     if not completed or no scores.
 */
function resolveEvent(event) {
  if (!event || !event.completed) return { decided: false };
  const scores = Array.isArray(event.scores) ? event.scores : [];
  if (scores.length < 2) return { decided: false };

  let top = null, tie = false;
  for (const s of scores) {
    const val = parseFloat(s.score);
    if (!Number.isFinite(val)) continue;
    if (!top || val > top.val) { top = { name: s.name, val }; tie = false; }
    else if (val === top.val) { tie = true; }
  }
  if (!top) return { decided: false };
  if (tie) return { decided: true, winner: null };          // draw → void
  return { decided: true, winner: top.name };
}

function settleSelection(sel, eventResult) {
  // eventResult: output of resolveEvent, or null if no data yet
  if (!eventResult || !eventResult.decided) return 'pending';
  if (eventResult.winner === null) return 'void';            // draw / tie
  return norm(eventResult.winner) === norm(sel.selection) ? 'won' : 'lost';
}

// the-odds-api only serves final scores for ~3 days. If a match is older than
// this window and still has no result, we can never settle it from the feed,
// so the fair action is to void that leg and refund (matches your void policy).
const SCORES_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function isPastScoresWindow(sel) {
  if (!sel.commenceTime) return false;
  return Date.now() - new Date(sel.commenceTime).getTime() > SCORES_WINDOW_MS;
}

/**
 * Recompute a bet's overall status & payout from its selections.
 * Returns { settled: bool, status, payout, effectiveOdds }.
 */
function evaluateBet(bet) {
  const sels = bet.selections;
  if (sels.some(s => s.status === 'pending')) {
    return { settled: false };
  }
  // Any lost leg → whole bet lost (parlay/single alike)
  if (sels.some(s => s.status === 'lost')) {
    return { settled: true, status: 'lost', payout: 0 };
  }
  // Remaining legs are 'won' or 'void'. Void legs count as odds 1.0.
  const wonLegs = sels.filter(s => s.status === 'won');
  if (wonLegs.length === 0) {
    // every leg void → refund stake
    return { settled: true, status: 'void', payout: parseFloat(bet.stake.toFixed(2)) };
  }
  const effectiveOdds = wonLegs.reduce((acc, s) => acc * (parseFloat(s.odd) || 1), 1);
  const payout = parseFloat((bet.stake * effectiveOdds).toFixed(2));
  // If some legs were void but at least one won, it's still a 'won' bet (reduced).
  return { settled: true, status: 'won', payout };
}

/**
 * Main entry — settle all currently-pending sports bets.
 * Safe to call repeatedly (idempotent: only pending legs are touched).
 */
async function settlePendingBets() {
  const pending = await SportsBet.find({ status: 'pending' });
  if (!pending.length) return { checked: 0, settled: 0 };

  // Collect sports that have pending legs
  const sports = new Set();
  pending.forEach(bet => bet.selections.forEach(s => {
    if (s.status === 'pending' && s.sportKey) sports.add(s.sportKey);
  }));

  // Only poll a sport once at least one of its pending matches could plausibly
  // be finished. A match that hasn't started (or hasn't run long enough) can't
  // have a final score yet, so polling earlier just wastes API credits.
  const now = Date.now();
  const sportsToPoll = [];
  let skipped = 0;
  for (const sportKey of sports) {
    const ready = earliestReadyTime(sportKey, pending);
    if (ready <= now) sportsToPoll.push(sportKey);
    else skipped++;
  }
  // Fetch scores once per sport (gated), build matchId -> resolveEvent() map.
  // Even if nothing is ready to poll, we still fall through so stale legs past
  // the scores window can be voided.
  const eventResults = new Map(); // matchId -> resolveEvent output
  for (const sportKey of sportsToPoll) {
    let data;
    try {
      data = await fetchScores(sportKey);
    } catch (e) {
      console.warn(`[settlement] scores fetch failed for ${sportKey}: ${e.message}`);
      continue;
    }
    for (const event of (data || [])) {
      eventResults.set(event.id, resolveEvent(event));
    }
  }

  let settledCount = 0;

  for (const bet of pending) {
    let changed = false;
    for (const sel of bet.selections) {
      if (sel.status !== 'pending') continue;
      const er = eventResults.get(sel.matchId);
      let next = settleSelection(sel, er);
      // Couldn't settle from feed, and the match is older than the scores
      // window → void this leg so the bet doesn't hang forever.
      if (next === 'pending' && isPastScoresWindow(sel)) {
        next = 'void';
        sel.resultNote = 'Void (no result available within scores window)';
      }
      if (next !== 'pending') {
        sel.status = next;
        if (er && er.decided) {
          sel.resultNote = er.winner === null ? 'Void (draw/no result)' : `Winner: ${er.winner}`;
        }
        changed = true;
      }
    }

    const evalResult = evaluateBet(bet);
    if (evalResult.settled) {
      bet.status = evalResult.status;
      bet.payout = evalResult.payout;
      bet.settledAt = new Date();
      changed = true;

      // Credit payout (won) or refund (void). Lost pays nothing.
      if (evalResult.payout > 0) {
        const user = await db.findUserById(bet.userId);
        if (user) {
          await db.updateUser(bet.userId, {
            balance: parseFloat((user.balance + evalResult.payout).toFixed(2)),
            totalWon: parseFloat(((user.totalWon || 0) + (evalResult.status === 'won' ? evalResult.payout : 0)).toFixed(2)),
          });
        }
      }

      // Mirror into the legacy Bet ledger for admin stats / recent-bets feed
      try {
        await db.createBet({
          userId: bet.userId,
          username: bet.username,
          game: 'sports',
          betAmount: bet.stake,
          multiplier: parseFloat((bet.totalOdds || 1).toFixed(4)),
          payout: evalResult.payout,
          won: evalResult.status === 'won',
        });
      } catch (e) { /* non-fatal */ }

      settledCount++;
    }

    if (changed) await bet.save();
  }

  return { checked: pending.length, settled: settledCount, polled: sportsToPoll.length, skipped };
}

let timer = null;

function startSettlementLoop(intervalMs = 5 * 60 * 1000) {
  if (timer) return;
  // First run shortly after boot, then on the interval.
  setTimeout(() => {
    settlePendingBets().catch(e => console.error('[settlement] run error:', e.message));
  }, 15 * 1000);
  timer = setInterval(() => {
    settlePendingBets().catch(e => console.error('[settlement] run error:', e.message));
  }, intervalMs);
  console.log(`⚖️   Sports settlement loop started (every ${Math.round(intervalMs / 60000)} min)`);
}

module.exports = { settlePendingBets, startSettlementLoop, resolveEvent, evaluateBet, settleSelection };

/**
 * SERVER-SIDE GAME ENGINES
 * All outcomes calculated server-side — client cannot cheat
 */
const crypto = require('crypto');

function rng() {
  return crypto.randomBytes(4).readUInt32BE(0) / 0xFFFFFFFF;
}

// ── SLOTS ────────────────────────────────────────────────────
const SLOT_SYMBOLS  = ['cherry','lemon','orange','grape','star','diamond','seven'];
const SLOT_WEIGHTS  = [30, 25, 20, 15, 6, 3, 1]; // total 100
const SLOT_PAY      = { cherry:5, lemon:8, orange:10, grape:12, star:25, diamond:50, seven:100 };
const SLOT_DISPLAY  = ['🍒','🍋','🍊','🍇','⭐','💎','7️⃣'];

function weightedPick(weights) {
  let r = rng() * weights.reduce((a,b) => a+b, 0);
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}

function slotsResult(betAmount, lines = 1) {
  // Generate 3x5 grid
  const grid = Array.from({length: 3}, () =>
    Array.from({length: 5}, () => weightedPick(SLOT_WEIGHTS))
  );
  // Check middle row (row index 1)
  const midRow = grid[1];
  const allSame = midRow.every(s => s === midRow[0]);
  let multiplier = 0;
  if (allSame) {
    multiplier = SLOT_PAY[SLOT_SYMBOLS[midRow[0]]] || 1;
  } else {
    // partial: 3-of-a-kind from left
    if (midRow[0] === midRow[1] && midRow[1] === midRow[2]) {
      multiplier = Math.floor((SLOT_PAY[SLOT_SYMBOLS[midRow[0]]] || 1) * 0.4);
    }
  }
  const won   = multiplier > 0;
  const payout = parseFloat((betAmount * lines * multiplier).toFixed(2));
  return {
    grid: grid.map(row => row.map(i => SLOT_DISPLAY[i])),
    midRow: midRow.map(i => SLOT_DISPLAY[i]),
    multiplier,
    won,
    payout,
  };
}

// ── ROULETTE ─────────────────────────────────────────────────
const RED_NUMBERS = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];

function rouletteResult(betAmount, bets) {
  // bets = [{ type:'straight'|'red'|'black'|'odd'|'even'|'low'|'high'|'dozen'|'column', value, stake }]
  const pocket = Math.floor(rng() * 37); // 0-36
  const isRed  = RED_NUMBERS.includes(pocket);

  let totalPayout = 0;
  const results = bets.map(b => {
    let win = false;
    let mult = 0;
    const stake = parseFloat(b.stake) || betAmount;
    switch(b.type) {
      case 'straight': win = pocket === parseInt(b.value); mult = 35; break;
      case 'red':    win = pocket > 0 && isRed;           mult = 1;  break;
      case 'black':  win = pocket > 0 && !isRed;          mult = 1;  break;
      case 'odd':    win = pocket > 0 && pocket % 2 === 1; mult = 1; break;
      case 'even':   win = pocket > 0 && pocket % 2 === 0; mult = 1; break;
      case 'low':    win = pocket >= 1 && pocket <= 18;    mult = 1;  break;
      case 'high':   win = pocket >= 19 && pocket <= 36;   mult = 1;  break;
      case 'dozen':
        const d = parseInt(b.value);
        win = pocket >= (d-1)*12+1 && pocket <= d*12; mult = 2; break;
      case 'column':
        win = pocket > 0 && pocket % 3 === parseInt(b.value) % 3; mult = 2; break;
    }
    const payout = win ? parseFloat((stake * (mult + 1)).toFixed(2)) : 0;
    totalPayout += payout;
    return { type: b.type, value: b.value, stake, won: win, payout };
  });

  const totalStake = bets.reduce((s, b) => s + (parseFloat(b.stake) || betAmount), 0);
  return { pocket, isRed, results, totalPayout, totalStake, won: totalPayout > 0 };
}

// ── BLACKJACK ─────────────────────────────────────────────────
const BJ_VALUES = { A:11, K:10, Q:10, J:10, '10':10, '9':9, '8':8, '7':7, '6':6, '5':5, '4':4, '3':3, '2':2 };
const BJ_RANKS  = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const BJ_SUITS  = ['♠','♥','♦','♣'];

function makeDeck() {
  const deck = [];
  for (const suit of BJ_SUITS) for (const rank of BJ_RANKS) deck.push({ rank, suit });
  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function bjScore(hand) {
  let score = 0, aces = 0;
  for (const c of hand) {
    score += BJ_VALUES[c.rank] || 10;
    if (c.rank === 'A') aces++;
  }
  while (score > 21 && aces > 0) { score -= 10; aces--; }
  return score;
}

function blackjackDeal(betAmount) {
  const deck = makeDeck();
  const player = [deck.pop(), deck.pop()];
  const dealer  = [deck.pop(), deck.pop()];
  // Dealer draws to 17
  while (bjScore(dealer) < 17) dealer.push(deck.pop());
  const ps = bjScore(player), ds = bjScore(dealer);
  const bust = ps > 21;
  const dealerBust = ds > 21;
  let outcome, multiplier, payout;
  if (bust) {
    outcome = 'bust'; multiplier = 0;
  } else if (ps === 21 && player.length === 2) {
    outcome = 'blackjack'; multiplier = 2.5;
  } else if (dealerBust || ps > ds) {
    outcome = 'win'; multiplier = 2;
  } else if (ps === ds) {
    outcome = 'push'; multiplier = 1;
  } else {
    outcome = 'lose'; multiplier = 0;
  }
  payout = parseFloat((betAmount * multiplier).toFixed(2));
  return { player, dealer, playerScore: ps, dealerScore: ds, outcome, multiplier, payout, won: payout > betAmount };
}

// ── BACCARAT ──────────────────────────────────────────────────
function baccaratDeal(betAmount, betOn = 'player') {
  const deck = makeDeck();
  const bac  = v => Math.min(BJ_VALUES[v] || 10, 9);
  let p = [deck.pop(), deck.pop()];
  let b = [deck.pop(), deck.pop()];
  let ps = (p.reduce((s,c)=>s+bac(c.rank),0)) % 10;
  let bs = (b.reduce((s,c)=>s+bac(c.rank),0)) % 10;
  // Natural
  if (ps < 8 && bs < 8) {
    if (ps <= 5) { p.push(deck.pop()); ps = (ps + bac(p[2].rank)) % 10; }
    if (bs <= 5) { b.push(deck.pop()); bs = (bs + bac(b[2].rank)) % 10; }
  }
  const winner = ps > bs ? 'player' : bs > ps ? 'banker' : 'tie';
  let multiplier = 0;
  if (betOn === winner) {
    multiplier = winner === 'banker' ? 1.95 : winner === 'tie' ? 8 : 2;
  }
  const payout = parseFloat((betAmount * multiplier).toFixed(2));
  return { playerHand: p, bankerHand: b, playerScore: ps, bankerScore: bs, winner, betOn, multiplier, payout, won: payout > 0 };
}

// ── WHEEL ─────────────────────────────────────────────────────
const WHEEL_CONFIGS = {
  low:    [{v:0,w:30},{v:1.5,w:35},{v:2,w:20},{v:3,w:10},{v:5,w:4},{v:10,w:1}],
  medium: [{v:0,w:35},{v:1.5,w:25},{v:2,w:20},{v:3,w:12},{v:5,w:5},{v:20,w:2},{v:50,w:1}],
  high:   [{v:0,w:45},{v:2,w:20},{v:3,w:15},{v:5,w:10},{v:10,w:6},{v:20,w:3},{v:50,w:1}],
};

function wheelResult(betAmount, risk = 'medium') {
  const segs  = WHEEL_CONFIGS[risk] || WHEEL_CONFIGS.medium;
  const total = segs.reduce((s, sg) => s + sg.w, 0);
  let r = rng() * total;
  let seg = segs[segs.length - 1];
  for (const s of segs) { r -= s.w; if (r <= 0) { seg = s; break; } }
  const multiplier = seg.v;
  const payout = parseFloat((betAmount * multiplier).toFixed(2));
  return { multiplier, payout, won: payout > 0, segmentValue: seg.v };
}

// ── LIMBO ─────────────────────────────────────────────────────
function limboResult(betAmount, target) {
  // result = 1 / uniform(0,1), house edge via clamp
  const u = Math.max(0.01, rng());
  const result = parseFloat(Math.min(1000, (0.99 / u)).toFixed(2));
  const won = result >= parseFloat(target);
  const multiplier = won ? parseFloat(target) : 0;
  const payout = won ? parseFloat((betAmount * multiplier).toFixed(2)) : 0;
  return { result, target: parseFloat(target), won, multiplier, payout };
}

// ── HILO ──────────────────────────────────────────────────────
const HILO_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const HILO_SUITS = ['♠','♥','♦','♣'];

function hiloStart() {
  const idx  = Math.floor(rng() * 13);
  const suit = HILO_SUITS[Math.floor(rng() * 4)];
  return { cardIdx: idx, rank: HILO_RANKS[idx], suit, cardDisplay: HILO_RANKS[idx] + suit };
}

function hiloGuess(betAmount, cardIdx, guess) {
  // guess: 'higher' | 'lower'
  const nextIdx  = Math.floor(rng() * 13);
  const nextSuit = HILO_SUITS[Math.floor(rng() * 4)];
  let won = false;
  if (guess === 'higher') won = nextIdx > cardIdx;
  else if (guess === 'lower') won = nextIdx < cardIdx;
  else won = nextIdx === cardIdx; // 'equal' rare

  const chance  = guess === 'higher' ? (12 - cardIdx) / 13 : cardIdx / 13;
  const mult    = won ? parseFloat(Math.min(10, (0.97 / Math.max(0.01, chance))).toFixed(2)) : 0;
  const payout  = won ? parseFloat((betAmount * mult).toFixed(2)) : 0;
  return {
    nextCardIdx: nextIdx, nextRank: HILO_RANKS[nextIdx], nextSuit,
    nextDisplay: HILO_RANKS[nextIdx] + nextSuit,
    won, multiplier: mult, payout,
  };
}

// ── KENO ──────────────────────────────────────────────────────
const KENO_PAYTABLE = [0,0,1,3,5,10,25,50,100,200,500];

function kenoResult(betAmount, picks) {
  if (!Array.isArray(picks) || picks.length < 1 || picks.length > 10)
    return { error: 'Pick 1-10 numbers' };
  const pool = Array.from({length:80}, (_,i) => i+1);
  // Shuffle and draw 20
  for (let i = pool.length-1; i > 0; i--) {
    const j = Math.floor(rng() * (i+1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const drawn   = pool.slice(0, 20);
  const matches = picks.filter(p => drawn.includes(p)).length;
  const multiplier = KENO_PAYTABLE[Math.min(matches, KENO_PAYTABLE.length-1)] || 0;
  const payout  = parseFloat((betAmount * multiplier).toFixed(2));
  return { drawn, picks, matches, multiplier, payout, won: payout > 0 };
}

// ── COIN FLIP ─────────────────────────────────────────────────
function flipResult(betAmount, choice) {
  const result = rng() < 0.5 ? 'heads' : 'tails';
  const won = result === choice;
  const payout = won ? parseFloat((betAmount * 1.96).toFixed(2)) : 0;
  return { result, choice, won, multiplier: won ? 1.96 : 0, payout };
}

// ── SLIDE ─────────────────────────────────────────────────────
function slideResult(betAmount, targetMultiplier) {
  const target = parseFloat(targetMultiplier) || 2;
  if (target < 1.01 || target > 100) return { error: 'Invalid target' };
  const u = rng();
  const result = parseFloat(Math.min(100, 0.99 / Math.max(0.01, u)).toFixed(2));
  const won = result >= target;
  const payout = won ? parseFloat((betAmount * target).toFixed(2)) : 0;
  return { result, target, won, multiplier: won ? target : 0, payout };
}

// ── PUMP (balloon) ────────────────────────────────────────────
function pumpResult(betAmount, cashoutAt) {
  // Balloon pops at random point between 1x and 10x
  const popAt = parseFloat((1 + rng() * 9).toFixed(2));
  const cashout = parseFloat(cashoutAt) || popAt;
  const won = cashout <= popAt;
  const payout = won ? parseFloat((betAmount * cashout).toFixed(2)) : 0;
  return { popAt, cashoutAt: cashout, won, multiplier: won ? cashout : 0, payout };
}

module.exports = {
  slotsResult, rouletteResult, blackjackDeal, baccaratDeal,
  wheelResult, limboResult, hiloStart, hiloGuess,
  kenoResult, flipResult, slideResult, pumpResult,
};

const express = require('express');
const { authenticate } = require('../middleware/auth');
const db = require('../config/db');
const paymentManagement = require('../services/paymentManagement');
const { ProvablyFair, DiceEngine, CrashEngine, MinesEngine, PlinkoEngine } = require('../games/gameEngine');
const { broadcastNewBet } = require('../websocket/wsServer');

const router = express.Router();

async function requireMinimumDeposit(req, res, next) {
  try {
    if (req.user.role === 'admin') return next();
    const approvedTotal = await paymentManagement.approvedDepositTotal(req.user.id);
    if (approvedTotal < paymentManagement.MIN_DEPOSIT_INR) {
      return res.status(403).json({ error: 'A minimum deposit of ₹300 is required to play games.' });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(authenticate, requireMinimumDeposit);

// Helper: validate bet amount
const validateBet = (betAmount, user) => {
  if (!betAmount || betAmount <= 0) return 'Invalid bet amount';
  if (betAmount > user.balance) return 'Insufficient balance';
  if (betAmount > 10000) return 'Bet exceeds maximum';
  return null;
};

// Helper: update user stats after bet
const updateUserStats = async (userId, betAmount, payout, won) => {
  const user = await db.findUserById(userId);
  const profit = payout - betAmount;
  const xpGain = Math.floor(betAmount * 0.1);
  
  let newXp = user.xp + xpGain;
  let newLevel = user.level;
  const xpThreshold = user.level * 500;
  if (newXp >= xpThreshold) { newLevel++; newXp = 0; }

  await db.updateUser(userId, {
    balance: parseFloat((user.balance - betAmount + payout).toFixed(2)),
    totalWagered: parseFloat((user.totalWagered + betAmount).toFixed(2)),
    totalWon: parseFloat((user.totalWon + (won ? payout : 0)).toFixed(2)),
    xp: newXp,
    level: newLevel,
  });
};

// ===== DICE =====
router.post('/dice/bet', authenticate, async (req, res) => {
  try {
    const { betAmount, target, isOver, clientSeed } = req.body;
    const error = validateBet(parseFloat(betAmount), req.user);
    if (error) return res.status(400).json({ error });
    if (target < 2 || target > 98) return res.status(400).json({ error: 'Target must be between 2-98' });

    const serverSeed = ProvablyFair.generateServerSeed();
    const seed = clientSeed || ProvablyFair.generateClientSeed();
    const nonce = Date.now();

    const roll = DiceEngine.roll(serverSeed, seed, nonce);
    const result = DiceEngine.calculateResult(roll, parseFloat(target), isOver, parseFloat(betAmount));

    await updateUserStats(req.user.id, parseFloat(betAmount), result.payout, result.won);

    const bet = await db.createBet({
      userId: req.user.id,
      username: req.user.username,
      game: 'dice',
      betAmount: parseFloat(betAmount),
      multiplier: result.multiplier,
      payout: result.payout,
      won: result.won,
      serverSeed,
      serverSeedHash: ProvablyFair.hashServerSeed(serverSeed),
      clientSeed: seed,
      nonce,
      gameData: { roll, target, isOver },
    });

    broadcastNewBet({ ...bet, serverSeed: undefined });

    const updatedUser = await db.findUserById(req.user.id);
    res.json({ ...result, roll, serverSeedHash: bet.serverSeedHash, betId: bet.id, balance: updatedUser.balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Game error' });
  }
});

// ===== CRASH =====
// Active crash sessions
const crashSessions = new Map();

router.post('/crash/bet', authenticate, async (req, res) => {
  try {
    const { betAmount, autoCashout, clientSeed } = req.body;
    const error = validateBet(parseFloat(betAmount), req.user);
    if (error) return res.status(400).json({ error });

    const serverSeed = ProvablyFair.generateServerSeed();
    const seed = clientSeed || ProvablyFair.generateClientSeed();
    const nonce = Date.now();

    const crashPoint = CrashEngine.calculateCrashPoint(serverSeed, seed, nonce);
    const sessionId = `crash_${req.user.id}_${nonce}`;

    crashSessions.set(sessionId, {
      userId: req.user.id,
      betAmount: parseFloat(betAmount),
      crashPoint,
      serverSeed,
      clientSeed: seed,
      nonce,
      autoCashout: autoCashout || null,
      cashedOut: false,
    });

    // Deduct balance immediately
    await db.updateUser(req.user.id, { balance: parseFloat((req.user.balance - parseFloat(betAmount)).toFixed(2)) });

    res.json({ sessionId, serverSeedHash: ProvablyFair.hashServerSeed(serverSeed), message: 'Bet placed. Cash out before crash!' });
  } catch (err) {
    res.status(500).json({ error: 'Game error' });
  }
});

router.post('/crash/cashout', authenticate, async (req, res) => {
  try {
    const { sessionId, multiplier } = req.body;
    const session = crashSessions.get(sessionId);

    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });
    if (session.cashedOut) return res.status(400).json({ error: 'Already cashed out' });

    const cashoutMultiplier = parseFloat(multiplier);
    const result = CrashEngine.calculatePayout(session.betAmount, cashoutMultiplier, session.crashPoint);

    session.cashedOut = true;
    crashSessions.set(sessionId, session);

    const freshUser = await db.findUserById(req.user.id);
    if (result.won) {
      await db.updateUser(req.user.id, {
        balance: parseFloat((freshUser.balance + result.payout).toFixed(2)),
        totalWagered: parseFloat((req.user.totalWagered + session.betAmount).toFixed(2)),
        totalWon: parseFloat((req.user.totalWon + result.payout).toFixed(2)),
      });
    } else {
      await db.updateUser(req.user.id, {
        totalWagered: parseFloat((freshUser.totalWagered + session.betAmount).toFixed(2)),
      });
    }

    const bet = await db.createBet({
      userId: req.user.id,
      username: req.user.username,
      game: 'crash',
      betAmount: session.betAmount,
      multiplier: cashoutMultiplier,
      payout: result.payout,
      won: result.won,
      gameData: { crashPoint: session.crashPoint, cashoutAt: cashoutMultiplier },
    });

    broadcastNewBet({ ...bet });
    crashSessions.delete(sessionId);

    const updatedUser = await db.findUserById(req.user.id);
    res.json({ ...result, crashPoint: session.crashPoint, balance: updatedUser.balance });
  } catch (err) {
    res.status(500).json({ error: 'Cashout error' });
  }
});

// ===== MINES =====
const mineSessions = new Map();

router.post('/mines/start', authenticate, async (req, res) => {
  try {
    const { betAmount, mineCount, clientSeed } = req.body;
    const error = validateBet(parseFloat(betAmount), req.user);
    if (error) return res.status(400).json({ error });
    if (mineCount < 1 || mineCount > 24) return res.status(400).json({ error: 'Mine count must be 1-24' });

    const serverSeed = ProvablyFair.generateServerSeed();
    const seed = clientSeed || ProvablyFair.generateClientSeed();
    const nonce = Date.now();

    const mines = MinesEngine.generateMines(serverSeed, seed, nonce, parseInt(mineCount));
    const sessionId = `mines_${req.user.id}_${nonce}`;

    mineSessions.set(sessionId, {
      userId: req.user.id,
      betAmount: parseFloat(betAmount),
      mineCount: parseInt(mineCount),
      mines,
      revealed: [],
      serverSeed,
      clientSeed: seed,
      nonce,
      active: true,
    });

    // Deduct balance
    await db.updateUser(req.user.id, { balance: parseFloat((req.user.balance - parseFloat(betAmount)).toFixed(2)) });

    const updatedUser = await db.findUserById(req.user.id);
    res.json({
      sessionId,
      mineCount: parseInt(mineCount),
      gridSize: 25,
      serverSeedHash: ProvablyFair.hashServerSeed(serverSeed),
      balance: updatedUser.balance,
      currentMultiplier: 1,
    });
  } catch (err) {
    res.status(500).json({ error: 'Game error' });
  }
});

router.post('/mines/reveal', authenticate, async (req, res) => {
  try {
    const { sessionId, tileIndex } = req.body;
    const session = mineSessions.get(sessionId);

    if (!session || !session.active) return res.status(404).json({ error: 'No active game' });
    if (session.userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });
    if (session.revealed.includes(tileIndex)) return res.status(400).json({ error: 'Already revealed' });

    const isMine = session.mines.includes(tileIndex);
    session.revealed.push(tileIndex);

    if (isMine) {
      session.active = false;
      mineSessions.set(sessionId, session);

      await db.updateUser(req.user.id, {
        totalWagered: parseFloat((req.user.totalWagered + session.betAmount).toFixed(2)),
      });

      await db.createBet({
        userId: req.user.id,
        username: req.user.username,
        game: 'mines',
        betAmount: session.betAmount,
        multiplier: 0,
        payout: 0,
        won: false,
        gameData: { mineCount: session.mineCount, revealed: session.revealed, mines: session.mines },
      });

      const updatedUser = await db.findUserById(req.user.id);
      return res.json({ isMine: true, mines: session.mines, balance: updatedUser.balance });
    }

    const multiplier = MinesEngine.calculateMultiplier(session.mineCount, session.revealed.length);
    const nextMultiplier = MinesEngine.calculateNextMultiplier(session.mineCount, session.revealed.length);
    mineSessions.set(sessionId, session);

    res.json({
      isMine: false,
      tileIndex,
      multiplier,
      nextMultiplier,
      currentPayout: parseFloat((session.betAmount * multiplier).toFixed(2)),
      revealed: session.revealed,
    });
  } catch (err) {
    res.status(500).json({ error: 'Game error' });
  }
});

router.post('/mines/cashout', authenticate, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = mineSessions.get(sessionId);

    if (!session || !session.active) return res.status(404).json({ error: 'No active game' });
    if (session.userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });
    if (session.revealed.length === 0) return res.status(400).json({ error: 'Reveal at least one tile' });

    session.active = false;
    const multiplier = MinesEngine.calculateMultiplier(session.mineCount, session.revealed.length);
    const payout = parseFloat((session.betAmount * multiplier).toFixed(2));

    const user = await db.findUserById(req.user.id);
    await db.updateUser(req.user.id, {
      balance: parseFloat((user.balance + payout).toFixed(2)),
      totalWagered: parseFloat((user.totalWagered + session.betAmount).toFixed(2)),
      totalWon: parseFloat((user.totalWon + payout).toFixed(2)),
    });

    const bet = await db.createBet({
      userId: req.user.id,
      username: req.user.username,
      game: 'mines',
      betAmount: session.betAmount,
      multiplier,
      payout,
      won: true,
      gameData: { mineCount: session.mineCount, revealed: session.revealed },
    });

    broadcastNewBet({ ...bet });
    mineSessions.delete(sessionId);

    const updatedUser = await db.findUserById(req.user.id);
    res.json({ won: true, multiplier, payout, mines: session.mines, balance: updatedUser.balance });
  } catch (err) {
    res.status(500).json({ error: 'Cashout error' });
  }
});

// ===== PLINKO =====
router.post('/plinko/drop', authenticate, async (req, res) => {
  try {
    const { betAmount, risk, rows, clientSeed } = req.body;
    const error = validateBet(parseFloat(betAmount), req.user);
    if (error) return res.status(400).json({ error });

    const serverSeed = ProvablyFair.generateServerSeed();
    const seed = clientSeed || ProvablyFair.generateClientSeed();
    const nonce = Date.now();

    const result = PlinkoEngine.drop(serverSeed, seed, nonce, rows || 8, risk || 'medium');
    const payout = parseFloat((parseFloat(betAmount) * result.multiplier).toFixed(2));
    const won = payout > parseFloat(betAmount);

    await updateUserStats(req.user.id, parseFloat(betAmount), payout, won);

    const bet = await db.createBet({
      userId: req.user.id,
      username: req.user.username,
      game: 'plinko',
      betAmount: parseFloat(betAmount),
      multiplier: result.multiplier,
      payout,
      won,
      gameData: { path: result.path, bucketIndex: result.bucketIndex, risk },
    });

    broadcastNewBet({ ...bet });

    const updatedUser = await db.findUserById(req.user.id);
    res.json({ ...result, payout, won, betId: bet.id, balance: updatedUser.balance });
  } catch (err) {
    res.status(500).json({ error: 'Game error' });
  }
});

// ── Load server-side engines ───────────────────────────────────
const {
  slotsResult, rouletteResult, blackjackDeal, baccaratDeal,
  wheelResult, limboResult, hiloStart, hiloGuess,
  kenoResult, flipResult, slideResult, pumpResult,
} = require('../games/serverGames');

// ── In-memory HiLo session store ─────────────────────────────
const hiloSessions = new Map();

// ===== SLOTS =====
router.post('/slots/spin', authenticate, async (req, res) => {
  try {
    const { betAmount, lines = 1, payout: clientPayout, won: clientWon, multiplier: clientMultiplier, gameData: clientGameData } = req.body;
    const bet = parseFloat(betAmount) * parseInt(lines);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });

    // If the client sends payout/won (new slot games), trust client result and record it
    if (clientPayout !== undefined && clientWon !== undefined) {
      const payout = parseFloat(clientPayout) || 0;
      const won = !!clientWon;
      const multiplier = parseFloat(clientMultiplier) || (won ? payout / bet : 0);

      await updateUserStats(req.user.id, bet, payout, won);
      const betDoc = await db.createBet({
        userId: req.user.id, username: req.user.username,
        game: clientGameData?.gameId || 'slots', betAmount: bet,
        multiplier, payout, won,
        gameData: clientGameData || { lines },
      });
      broadcastNewBet({ ...betDoc });
      const user = await db.findUserById(req.user.id);
      return res.json({ payout, won, multiplier, balance: user.balance, betId: betDoc.id });
    }

    // Legacy path: server calculates result
    const result = slotsResult(parseFloat(betAmount), parseInt(lines));
    await updateUserStats(req.user.id, bet, result.payout, result.won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'slots', betAmount: bet,
      multiplier: result.multiplier, payout: result.payout, won: result.won,
      gameData: { grid: result.grid, lines },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ ...result, balance: user.balance, betId: betDoc.id });
  } catch(err) { console.error(err); res.status(500).json({ error: 'Game error' }); }
});

// ===== ROULETTE =====
router.post('/roulette/spin', authenticate, async (req, res) => {
  try {
    const { bets, betAmount } = req.body;
    if (!Array.isArray(bets) || !bets.length) return res.status(400).json({ error: 'No bets placed' });
    const totalStake = bets.reduce((s, b) => s + (parseFloat(b.stake) || parseFloat(betAmount) || 0), 0);
    const error = validateBet(totalStake, req.user);
    if (error) return res.status(400).json({ error });

    const result = rouletteResult(parseFloat(betAmount), bets);
    await updateUserStats(req.user.id, result.totalStake, result.totalPayout, result.won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'roulette', betAmount: result.totalStake,
      multiplier: result.totalStake > 0 ? result.totalPayout / result.totalStake : 0,
      payout: result.totalPayout, won: result.won,
      gameData: { pocket: result.pocket, isRed: result.isRed, bets: result.results },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ ...result, balance: user.balance, betId: betDoc.id });
  } catch(err) { console.error(err); res.status(500).json({ error: 'Game error' }); }
});

// ===== BLACKJACK =====
router.post('/blackjack/deal', authenticate, async (req, res) => {
  try {
    const { betAmount } = req.body;
    const bet = parseFloat(betAmount);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });

    const result = blackjackDeal(bet);
    await updateUserStats(req.user.id, bet, result.payout, result.won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'blackjack', betAmount: bet,
      multiplier: result.multiplier, payout: result.payout, won: result.won,
      gameData: { player: result.player, dealer: result.dealer, outcome: result.outcome },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ ...result, balance: user.balance, betId: betDoc.id });
  } catch(err) { console.error(err); res.status(500).json({ error: 'Game error' }); }
});

// ===== BACCARAT =====
router.post('/baccarat/deal', authenticate, async (req, res) => {
  try {
    const { betAmount, betOn = 'player' } = req.body;
    const bet = parseFloat(betAmount);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });
    if (!['player','banker','tie'].includes(betOn)) return res.status(400).json({ error: 'Invalid bet choice' });

    const result = baccaratDeal(bet, betOn);
    await updateUserStats(req.user.id, bet, result.payout, result.won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'baccarat', betAmount: bet,
      multiplier: result.multiplier, payout: result.payout, won: result.won,
      gameData: { winner: result.winner, betOn, playerScore: result.playerScore, bankerScore: result.bankerScore },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ ...result, balance: user.balance, betId: betDoc.id });
  } catch(err) { console.error(err); res.status(500).json({ error: 'Game error' }); }
});

// ===== WHEEL =====
router.post('/wheel/spin', authenticate, async (req, res) => {
  try {
    const { betAmount, risk = 'medium' } = req.body;
    const bet = parseFloat(betAmount);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });

    const result = wheelResult(bet, risk);
    await updateUserStats(req.user.id, bet, result.payout, result.won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'wheel', betAmount: bet,
      multiplier: result.multiplier, payout: result.payout, won: result.won,
      gameData: { risk, multiplier: result.multiplier },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ ...result, balance: user.balance, betId: betDoc.id });
  } catch(err) { console.error(err); res.status(500).json({ error: 'Game error' }); }
});

// ===== LIMBO =====
router.post('/limbo/bet', authenticate, async (req, res) => {
  try {
    const { betAmount, target } = req.body;
    const bet = parseFloat(betAmount);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });
    if (!target || parseFloat(target) < 1.01) return res.status(400).json({ error: 'Target must be ≥ 1.01' });

    const result = limboResult(bet, target);
    await updateUserStats(req.user.id, bet, result.payout, result.won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'limbo', betAmount: bet,
      multiplier: result.multiplier, payout: result.payout, won: result.won,
      gameData: { target: result.target, result: result.result },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ ...result, balance: user.balance, betId: betDoc.id });
  } catch(err) { console.error(err); res.status(500).json({ error: 'Game error' }); }
});

// ===== HILO =====
router.post('/hilo/start', authenticate, async (req, res) => {
  try {
    const { betAmount } = req.body;
    const bet = parseFloat(betAmount);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });

    const card = hiloStart();
    const sessionId = `hilo_${req.user.id}_${Date.now()}`;
    hiloSessions.set(sessionId, { userId: req.user.id, bet, cardIdx: card.cardIdx, active: true });
    // Deduct bet
    await db.updateUser(req.user.id, { balance: parseFloat((req.user.balance - bet).toFixed(2)) });
    const user = await db.findUserById(req.user.id);
    res.json({ sessionId, card: card.cardDisplay, cardIdx: card.cardIdx, balance: user.balance });
  } catch(err) { res.status(500).json({ error: 'Game error' }); }
});

router.post('/hilo/guess', authenticate, async (req, res) => {
  try {
    const { sessionId, guess } = req.body;
    const session = hiloSessions.get(sessionId);
    if (!session || !session.active) return res.status(404).json({ error: 'No active HiLo game' });
    if (session.userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

    const result = hiloGuess(session.bet, session.cardIdx, guess);
    session.active = false;

    if (result.won) {
      const user = await db.findUserById(req.user.id);
      await db.updateUser(req.user.id, {
        balance: parseFloat((user.balance + result.payout).toFixed(2)),
        totalWagered: parseFloat((user.totalWagered + session.bet).toFixed(2)),
        totalWon: parseFloat((user.totalWon + result.payout).toFixed(2)),
      });
    } else {
      const user = await db.findUserById(req.user.id);
      await db.updateUser(req.user.id, { totalWagered: parseFloat((user.totalWagered + session.bet).toFixed(2)) });
    }

    await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'hilo', betAmount: session.bet,
      multiplier: result.multiplier, payout: result.payout, won: result.won,
      gameData: { guess, nextCard: result.nextDisplay },
    });

    hiloSessions.delete(sessionId);
    const user = await db.findUserById(req.user.id);
    res.json({ ...result, balance: user.balance });
  } catch(err) { res.status(500).json({ error: 'Game error' }); }
});

// ===== KENO =====
router.post('/keno/play', authenticate, async (req, res) => {
  try {
    const { betAmount, picks } = req.body;
    const bet = parseFloat(betAmount);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });

    const result = kenoResult(bet, picks);
    if (result.error) return res.status(400).json({ error: result.error });

    await updateUserStats(req.user.id, bet, result.payout, result.won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'keno', betAmount: bet,
      multiplier: result.multiplier, payout: result.payout, won: result.won,
      gameData: { picks, drawn: result.drawn, matches: result.matches },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ ...result, balance: user.balance, betId: betDoc.id });
  } catch(err) { res.status(500).json({ error: 'Game error' }); }
});

// ===== COIN FLIP =====
router.post('/flip/bet', authenticate, async (req, res) => {
  try {
    const { betAmount, choice } = req.body;
    const bet = parseFloat(betAmount);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });
    if (!['heads','tails'].includes(choice)) return res.status(400).json({ error: 'Choose heads or tails' });

    const result = flipResult(bet, choice);
    await updateUserStats(req.user.id, bet, result.payout, result.won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'flip', betAmount: bet,
      multiplier: result.multiplier, payout: result.payout, won: result.won,
      gameData: { choice, result: result.result },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ ...result, balance: user.balance, betId: betDoc.id });
  } catch(err) { res.status(500).json({ error: 'Game error' }); }
});

// ===== SLIDE =====
router.post('/slide/bet', authenticate, async (req, res) => {
  try {
    const { betAmount, targetMultiplier } = req.body;
    const bet = parseFloat(betAmount);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });

    const result = slideResult(bet, targetMultiplier);
    if (result.error) return res.status(400).json({ error: result.error });

    await updateUserStats(req.user.id, bet, result.payout, result.won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'slide', betAmount: bet,
      multiplier: result.multiplier, payout: result.payout, won: result.won,
      gameData: { target: result.target, result: result.result },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ ...result, balance: user.balance, betId: betDoc.id });
  } catch(err) { res.status(500).json({ error: 'Game error' }); }
});

// ===== PUMP =====
router.post('/pump/cashout', authenticate, async (req, res) => {
  try {
    const { betAmount, cashoutAt } = req.body;
    const bet = parseFloat(betAmount);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });

    const result = pumpResult(bet, cashoutAt);
    await updateUserStats(req.user.id, bet, result.payout, result.won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'pump', betAmount: bet,
      multiplier: result.multiplier, payout: result.payout, won: result.won,
      gameData: { cashoutAt: result.cashoutAt, popAt: result.popAt },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ ...result, balance: user.balance, betId: betDoc.id });
  } catch(err) { res.status(500).json({ error: 'Game error' }); }
});

// ── Client-result sync endpoints ─────────────────────────────────────────────
// These accept the game outcome already computed client-side and persist it to
// the database.  The frontend deducts/credits balance locally for instant UI
// feedback; these calls make the authoritative DB record match.

// /mines/bet  – mines.html runs its own board logic and calls here on win/loss
router.post('/mines/bet', authenticate, async (req, res) => {
  try {
    const { betAmount, won, multiplier } = req.body;
    const bet = parseFloat(betAmount);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });

    const multi = parseFloat(multiplier) || 0;
    const payout = won ? parseFloat((bet * multi).toFixed(2)) : 0;
    await updateUserStats(req.user.id, bet, payout, !!won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'mines', betAmount: bet,
      multiplier: multi, payout, won: !!won,
      gameData: { clientReported: true },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ payout, won: !!won, multiplier: multi, balance: user.balance, betId: betDoc.id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Game error' }); }
});

// /roulette/bet – roulette.html reports its own spin result here
router.post('/roulette/bet', authenticate, async (req, res) => {
  try {
    const { betAmount, won, multiplier, payout: clientPayout, gameData } = req.body;
    const bet = parseFloat(betAmount);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });

    const multi = parseFloat(multiplier) || 0;
    const payout = clientPayout !== undefined ? parseFloat(clientPayout) : (won ? parseFloat((bet * multi).toFixed(2)) : 0);
    await updateUserStats(req.user.id, bet, payout, !!won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'roulette', betAmount: bet,
      multiplier: multi, payout, won: !!won,
      gameData: gameData || { clientReported: true },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ payout, won: !!won, multiplier: multi, balance: user.balance, betId: betDoc.id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Game error' }); }
});

// /wheel/bet – wheel.html reports its own spin result here
router.post('/wheel/bet', authenticate, async (req, res) => {
  try {
    const { betAmount, won, multiplier, payout: clientPayout, gameData } = req.body;
    const bet = parseFloat(betAmount);
    const error = validateBet(bet, req.user);
    if (error) return res.status(400).json({ error });

    const multi = parseFloat(multiplier) || 0;
    const payout = clientPayout !== undefined ? parseFloat(clientPayout) : (won ? parseFloat((bet * multi).toFixed(2)) : 0);
    await updateUserStats(req.user.id, bet, payout, !!won);
    const betDoc = await db.createBet({
      userId: req.user.id, username: req.user.username,
      game: 'wheel', betAmount: bet,
      multiplier: multi, payout, won: !!won,
      gameData: gameData || { clientReported: true },
    });
    broadcastNewBet({ ...betDoc });
    const user = await db.findUserById(req.user.id);
    res.json({ payout, won: !!won, multiplier: multi, balance: user.balance, betId: betDoc.id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Game error' }); }
});

module.exports = router;

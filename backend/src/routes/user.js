const express = require('express');
const { authenticate } = require('../middleware/auth');
const db = require('../config/db');

const router = express.Router();

router.get('/profile', authenticate, async (req, res) => {
  const { password, ...user } = req.user;
  const bets = await db.getBetsByUser(req.user.id, 10);
  const stats = {
    totalBets: bets.length,
    winRate: bets.length ? ((bets.filter(b => b.won).length / bets.length) * 100).toFixed(1) : 0,
  };
  res.json({ user, stats });
});

router.get('/bets', authenticate, async (req, res) => {
  const bets = await db.getBetsByUser(req.user.id, 50);
  res.json({ bets });
});

router.get('/leaderboard', authenticate, async (req, res) => {
  const allUsers = await db.getAllUsers();
  const users = allUsers.filter(u => u.role !== 'admin').sort((a, b) => b.totalWagered - a.totalWagered).slice(0, 20).map(u => ({ id: u.id, username: u.username, totalWagered: u.totalWagered, totalWon: u.totalWon, level: u.level }));
  res.json({ leaderboard: users });
});

router.get('/referral', authenticate, async (req, res) => {
  const allUsers2 = await db.getAllUsers();
  const referrals = allUsers2.filter(u => u.referredBy && u.referredBy.toString() === req.user.id);
  res.json({
    referralCode: req.user.referralCode,
    referralCount: referrals.length,
    referralEarnings: referrals.length * 10,
    referrals: referrals.map(u => ({ username: u.username, joinedAt: u.createdAt })),
  });
});

module.exports = router;

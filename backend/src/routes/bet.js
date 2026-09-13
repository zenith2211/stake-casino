const express = require('express');
const { authenticate } = require('../middleware/auth');
const db = require('../config/db');

const router = express.Router();

router.get('/live', authenticate, async (req, res) => {
  const bets = await db.getRecentBets(20);
  res.json({ bets });
});

router.get('/my', authenticate, async (req, res) => {
  const bets = await db.getBetsByUser(req.user.id);
  res.json({ bets });
});

module.exports = router;

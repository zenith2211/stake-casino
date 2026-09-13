// wallet.js
const express = require('express');
const { authenticate } = require('../middleware/auth');
const db = require('../config/db');
const paymentManagement = require('../services/paymentManagement');

const router = express.Router();

router.get('/balance', authenticate, async (req, res) => {
  res.json({ balance: req.user.balance });
});

router.get('/transactions', authenticate, async (req, res) => {
  const transactions = await db.getTransactionsByUser(req.user.id);
  res.json({ transactions });
});

router.post('/deposit', authenticate, async (req, res) => {
  const deposit = await paymentManagement.createDeposit(req, req.body);
  res.status(201).json({
    deposit,
    message: 'Please wait 5–10 minutes while your payment is being verified.',
  });
});

// Placeholder withdraw
router.post('/withdraw', authenticate, async (req, res) => {
  const { amount, address, method } = req.body;
  if (amount > req.user.balance) return res.status(400).json({ error: 'Insufficient balance' });
  res.json({
    status: 'pending',
    message: 'Withdrawal gateway not yet connected.',
    amount,
    method,
  });
});

router.post('/demo-add', authenticate, async (req, res) => {
  res.status(403).json({ error: 'Demo balance credits are disabled. Deposits require admin verification.' });
});

module.exports = router;

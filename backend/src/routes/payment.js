const express = require('express');
const { authenticate } = require('../middleware/auth');
const paymentManagement = require('../services/paymentManagement');
const DepositRequest = require('../models/DepositRequest');
const Transaction = require('../models/Transaction');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.get('/methods', authenticate, asyncHandler(async (req, res) => {
  const accounts = (await paymentManagement.listAccounts()).filter(account => account.enabled);
  const methods = ['upi', 'crypto'].map(method => ({
    method,
    enabled: accounts.some(account => account.method === method),
    accounts: accounts
      .filter(account => account.method === method)
      .map(account => ({
        id: account.id,
        label: account.label,
        description: account.description,
        limits: account.limits,
        upiId: method === 'upi' ? account.upiId : undefined,
        crypto: method === 'crypto' ? account.crypto : undefined,
      })),
  }));
  res.json({ minDeposit: paymentManagement.MIN_DEPOSIT_INR, methods });
}));

router.post('/deposits', authenticate, asyncHandler(async (req, res) => {
  const deposit = await paymentManagement.createDeposit(req, req.body);
  res.status(201).json({
    deposit,
    message: 'Please wait 5–10 minutes while your payment is being verified.',
  });
}));

router.get('/deposits', authenticate, asyncHandler(async (req, res) => {
  const deposits = await DepositRequest.find({ userId: req.user.id })
    .populate('accountId', 'label method provider upiId crypto')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json({ deposits });
}));

router.get('/history', authenticate, asyncHandler(async (req, res) => {
  const [transactions, deposits, approvedTotal] = await Promise.all([
    Transaction.find({ userId: req.user.id, type: { $in: ['deposit', 'withdraw', 'withdrawal'] } })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
    DepositRequest.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(100).lean(),
    paymentManagement.approvedDepositTotal(req.user.id),
  ]);
  res.json({
    balance: req.user.balance,
    minDeposit: paymentManagement.MIN_DEPOSIT_INR,
    canPlayGames: approvedTotal >= paymentManagement.MIN_DEPOSIT_INR,
    approvedDepositTotal: approvedTotal,
    transactions,
    deposits,
  });
}));

router.get('/config', authenticate, asyncHandler(async (req, res) => {
  const approvedTotal = await paymentManagement.approvedDepositTotal(req.user.id);
  res.json({
    manualVerificationOnly: true,
    minDeposit: paymentManagement.MIN_DEPOSIT_INR,
    canPlayGames: approvedTotal >= paymentManagement.MIN_DEPOSIT_INR,
    approvedDepositTotal: approvedTotal,
    supportedMethods: ['UPI', 'CRYPTO'],
    supportedCryptos: ['BTC', 'ETH', 'BNB', 'USDT', 'OTHER'],
    verificationMessage: 'Please wait 5–10 minutes while your payment is being verified.',
    gameAccessMessage: `A minimum deposit of ₹${paymentManagement.MIN_DEPOSIT_INR} is required to play games.`,
  });
}));

// ── Withdraw via UPI ────────────────────────────────────────────────────────
router.post('/withdraw/upi', authenticate, asyncHandler(async (req, res) => {
  const { amount, upiId } = req.body;
  const User = require('../models/User');

  if (!upiId || !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/.test(upiId)) {
    return res.status(400).json({ error: 'Invalid UPI ID format. Example: name@okicici' });
  }

  const parsedAmount = parseFloat(amount);
  if (!parsedAmount || parsedAmount < 200) {
    return res.status(400).json({ error: 'Minimum withdrawal amount is ₹200' });
  }

  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.balance < parsedAmount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  // Deduct balance and record transaction
  user.balance = parseFloat((user.balance - parsedAmount).toFixed(2));
  await user.save();

  const Transaction = require('../models/Transaction');
  await Transaction.create({
    userId: user._id,
    type: 'withdrawal',
    amount: -parsedAmount,
    description: `UPI withdrawal to ${upiId}`,
    status: 'pending',
  });

  res.json({
    success: true,
    balance: user.balance,
    message: `Withdrawal of ₹${parsedAmount} to ${upiId} submitted. ETA: 30 minutes.`,
  });
}));

// ── Withdraw via Crypto ─────────────────────────────────────────────────────
router.post('/withdraw/crypto', authenticate, asyncHandler(async (req, res) => {
  const { amount, currency, address } = req.body;
  const User = require('../models/User');

  const supportedCoins = ['BTC', 'ETH', 'BNB', 'USDT', 'OTHER'];
  if (!currency || !supportedCoins.includes(currency.toUpperCase())) {
    return res.status(400).json({ error: 'Unsupported cryptocurrency' });
  }
  if (!address || address.trim().length < 10) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const parsedAmount = parseFloat(amount);
  if (!parsedAmount || parsedAmount < 5) {
    return res.status(400).json({ error: 'Minimum withdrawal amount is ₹5' });
  }

  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.balance < parsedAmount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  user.balance = parseFloat((user.balance - parsedAmount).toFixed(2));
  await user.save();

  const Transaction = require('../models/Transaction');
  await Transaction.create({
    userId: user._id,
    type: 'withdrawal',
    amount: -parsedAmount,
    description: `${currency.toUpperCase()} withdrawal to ${address}`,
    status: 'pending',
  });

  res.json({
    success: true,
    balance: user.balance,
    message: `Withdrawal of ₹${parsedAmount} in ${currency.toUpperCase()} submitted. ETA: 10–60 minutes.`,
  });
}));

module.exports = router;

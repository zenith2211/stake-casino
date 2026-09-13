const express = require('express');
const { authenticate, requireAdmin } = require('../middleware/auth');
const db = require('../config/db');
const paymentManagement = require('../services/paymentManagement');
const DepositRequest = require('../models/DepositRequest');
const AuditLog = require('../models/AuditLog');
const PaymentAlert = require('../models/PaymentAlert');

const router = express.Router();
router.use(authenticate, requireAdmin);

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.get('/stats', asyncHandler(async (req, res) => { const stats = await db.getStats(); res.json(stats); }));

router.get('/users', asyncHandler(async (req, res) => {
  const rawUsers = await db.getAllUsers();
  const users = rawUsers.map(({ password, ...u }) => u);
  res.json({ users });
}));

router.post('/users/:id/ban', asyncHandler(async (req, res) => {
  const user = await db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await db.updateUser(req.params.id, { isBanned: true });
  await paymentManagement.audit(req, 'user.ban', 'User', req.params.id, { isBanned: user.isBanned }, { isBanned: true });
  res.json({ message: 'User banned' });
}));

router.post('/users/:id/unban', asyncHandler(async (req, res) => {
  const user = await db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await db.updateUser(req.params.id, { isBanned: false });
  await paymentManagement.audit(req, 'user.unban', 'User', req.params.id, { isBanned: user.isBanned }, { isBanned: false });
  res.json({ message: 'User unbanned' });
}));

router.post('/users/:id/make-admin', asyncHandler(async (req, res) => {
  const user = await db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const updated = await db.updateUser(req.params.id, { role: 'admin' });
  console.log(`[make-admin] userId=${req.params.id} role after update: ${updated?.role}`);
  res.json({ message: 'User promoted to admin', role: updated?.role });
}));

router.post('/users/:id/remove-admin', asyncHandler(async (req, res) => {
  const user = await db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const updated = await db.updateUser(req.params.id, { role: 'user' });
  console.log(`[remove-admin] userId=${req.params.id} role after update: ${updated?.role}`);
  res.json({ message: 'Admin role removed', role: updated?.role });
}));

router.post('/users/:id/add-balance', asyncHandler(async (req, res) => {
  const { amount } = req.body;
  const user = await db.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const nextBalance = user.balance + parseFloat(amount);
  await db.updateUser(req.params.id, { balance: nextBalance });
  await paymentManagement.audit(req, 'user.balance_adjust', 'User', req.params.id, { balance: user.balance }, { balance: nextBalance }, { amount: parseFloat(amount) });
  res.json({ message: `Added $${amount} to ${user.username}` });
}));

router.get('/bets', asyncHandler(async (req, res) => { const bets = await db.getAllBets(100); res.json({ bets }); }));

router.get('/transactions', asyncHandler(async (req, res) => { const transactions = await db.getAllTransactions(); res.json({ transactions }); }));

router.get('/payment/accounts', asyncHandler(async (req, res) => {
  res.json({ accounts: await paymentManagement.listAccounts() });
}));

router.post('/payment/accounts', asyncHandler(async (req, res) => {
  const account = await paymentManagement.createAccount(req, req.body);
  res.status(201).json({ account });
}));

router.put('/payment/accounts/:id', asyncHandler(async (req, res) => {
  const account = await paymentManagement.updateAccount(req, req.params.id, req.body);
  res.json({ account });
}));

router.delete('/payment/accounts/:id', asyncHandler(async (req, res) => {
  res.json(await paymentManagement.removeAccount(req, req.params.id));
}));

router.post('/payment/accounts/:id/enable', asyncHandler(async (req, res) => {
  const account = await paymentManagement.updateAccount(req, req.params.id, { enabled: true });
  res.json({ account });
}));

router.post('/payment/accounts/:id/disable', asyncHandler(async (req, res) => {
  const account = await paymentManagement.updateAccount(req, req.params.id, { enabled: false });
  res.json({ account });
}));

router.get('/payment/deposits', asyncHandler(async (req, res) => {
  const deposits = await DepositRequest.find()
    .populate('accountId', 'label method provider businessUnit brand region')
    .populate('userId', 'username email')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  res.json({ deposits });
}));

router.post('/payment/deposits/:id/status', asyncHandler(async (req, res) => {
  const deposit = await paymentManagement.updateDepositStatus(req, req.params.id, req.body.status, req.body.note || '');
  res.json({ deposit });
}));

router.get('/payment/dashboard', asyncHandler(async (req, res) => {
  res.json(await paymentManagement.dashboardStats());
}));

router.get('/payment/reports', asyncHandler(async (req, res) => {
  res.json(await paymentManagement.reports());
}));

router.get('/payment/audit-logs', asyncHandler(async (req, res) => {
  const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(200).lean();
  res.json({ logs });
}));

router.get('/payment/alerts', asyncHandler(async (req, res) => {
  const alerts = await PaymentAlert.find().populate('accountId', 'label method provider').sort({ createdAt: -1 }).limit(100).lean();
  res.json({ alerts });
}));

router.post('/payment/alerts/:id/acknowledge', asyncHandler(async (req, res) => {
  const alert = await PaymentAlert.findByIdAndUpdate(req.params.id, { acknowledged: true }, { new: true }).lean();
  await paymentManagement.audit(req, 'payment_alert.acknowledge', 'PaymentAlert', req.params.id, null, alert);
  res.json({ alert });
}));

module.exports = router;

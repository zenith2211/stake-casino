const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const PaymentAccount = require('../models/PaymentAccount');
const DepositRequest = require('../models/DepositRequest');
const PaymentAlert = require('../models/PaymentAlert');
const AuditLog = require('../models/AuditLog');
const Transaction = require('../models/Transaction');
const User = require('../models/User');

const MIN_DEPOSIT_INR = 300;
const METHODS = ['upi', 'crypto'];
const SUPPORTED_COINS = ['BTC', 'ETH', 'BNB', 'USDT', 'OTHER'];
const STATUS = ['pending', 'approved', 'rejected'];

function normalizeDoc(doc) {
  if (!doc) return null;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  if (obj._id) obj.id = obj._id.toString();
  delete obj.credentials;
  return obj;
}

function requestContext(req) {
  return {
    actorId: req.user?.id || req.user?._id || null,
    actorEmail: req.user?.email || '',
    ip: req.ip,
    userAgent: req.get('user-agent') || '',
  };
}

async function audit(req, action, resourceType, resourceId, before, after, metadata = {}) {
  const ctx = requestContext(req);
  await AuditLog.create({ ...ctx, action, resourceType, resourceId: String(resourceId || ''), before, after, metadata });
}

function buildTarget(account) {
  if (account.method === 'upi') return account.upiId;
  return account.crypto?.walletAddress || '';
}

function validateAccountPayload(payload, partial = false) {
  const errors = [];
  const method = payload.method;
  if ((!partial || method !== undefined) && !METHODS.includes(method)) errors.push('method must be upi or crypto');
  if ((!partial || payload.label !== undefined) && !String(payload.label || '').trim()) errors.push('label is required');

  if (method === 'upi') {
    if (!payload.upiId || !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/.test(payload.upiId)) {
      errors.push('valid UPI ID is required for UPI accounts');
    }
  }

  if (method === 'crypto') {
    const coin = String(payload.crypto?.coin || '').toUpperCase();
    if (!SUPPORTED_COINS.includes(coin)) errors.push('crypto.coin must be BTC, ETH, BNB, USDT, or OTHER');
    if (!String(payload.crypto?.walletAddress || '').trim()) errors.push('crypto.walletAddress is required');
  }

  const limits = payload.limits || {};
  ['minAmount', 'maxAmount', 'dailyAmountLimit', 'dailyCountLimit'].forEach(key => {
    if (limits[key] !== undefined && Number(limits[key]) < 0) errors.push(`${key} cannot be negative`);
  });
  if (limits.minAmount !== undefined && limits.maxAmount !== undefined && Number(limits.minAmount) > Number(limits.maxAmount)) {
    errors.push('minAmount cannot be greater than maxAmount');
  }
  return errors;
}

function buildAccountUpdate(payload) {
  const allowed = ['method', 'provider', 'label', 'description', 'enabled', 'businessUnit', 'brand', 'region', 'upiId', 'crypto', 'limits', 'assignmentRules', 'health'];
  const update = {};
  allowed.forEach(key => {
    if (payload[key] !== undefined) update[key] = payload[key];
  });
  if (update.method === 'upi') {
    update.provider = 'manual_upi';
    update.crypto = { coin: '', network: '', walletAddress: '' };
  }
  if (update.method === 'crypto') {
    update.provider = 'manual_crypto';
    update.upiId = '';
    update.crypto = {
      coin: String(update.crypto?.coin || 'OTHER').toUpperCase(),
      network: update.crypto?.network || '',
      walletAddress: update.crypto?.walletAddress || '',
    };
  }
  return update;
}

async function createAccount(req, payload) {
  const normalized = { ...payload, provider: payload.method === 'crypto' ? 'manual_crypto' : 'manual_upi' };
  const errors = validateAccountPayload(normalized);
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    throw err;
  }
  const created = await PaymentAccount.create(buildAccountUpdate(normalized));
  await audit(req, 'payment_account.create', 'PaymentAccount', created._id, null, normalizeDoc(created));
  return normalizeDoc(created);
}

async function updateAccount(req, id, payload) {
  const existing = await PaymentAccount.findById(id).lean();
  if (!existing) {
    const err = new Error('Payment account not found');
    err.status = 404;
    throw err;
  }
  const merged = { ...existing, ...payload, crypto: { ...(existing.crypto || {}), ...(payload.crypto || {}) } };
  if (payload.method === undefined) merged.method = existing.method;
  merged.provider = merged.method === 'crypto' ? 'manual_crypto' : 'manual_upi';
  const errors = validateAccountPayload(merged, true);
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    throw err;
  }
  const updated = await PaymentAccount.findByIdAndUpdate(id, buildAccountUpdate(merged), { new: true }).lean();
  await audit(req, 'payment_account.update', 'PaymentAccount', id, normalizeDoc(existing), normalizeDoc(updated));
  return normalizeDoc(updated);
}

async function removeAccount(req, id) {
  const existing = await PaymentAccount.findById(id).lean();
  if (!existing) {
    const err = new Error('Payment account not found');
    err.status = 404;
    throw err;
  }
  const pending = await DepositRequest.countDocuments({ accountId: id, status: 'pending' });
  if (pending) {
    const err = new Error('Cannot remove account with pending deposit requests. Disable it instead.');
    err.status = 409;
    throw err;
  }
  await PaymentAccount.findByIdAndDelete(id);
  await audit(req, 'payment_account.remove', 'PaymentAccount', id, normalizeDoc(existing), null);
  return { removed: true };
}

async function listAccounts() {
  return (await PaymentAccount.find().sort({ method: 1, enabled: -1, 'crypto.coin': 1, label: 1 }).lean()).map(normalizeDoc);
}

function matchesAssignment(account, context) {
  const rules = account.assignmentRules || {};
  const check = (values, current) => !Array.isArray(values) || values.length === 0 || values.includes(current);
  return check(rules.allowedBusinessUnits, context.businessUnit)
    && check(rules.allowedBrands, context.brand)
    && check(rules.allowedRegions, context.region)
    && check(rules.currencies, context.currency);
}

async function accountUsage(accountId, since = new Date(new Date().setHours(0, 0, 0, 0))) {
  const [agg] = await DepositRequest.aggregate([
    { $match: { accountId, createdAt: { $gte: since }, status: { $in: ['pending', 'approved'] } } },
    { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  return agg || { amount: 0, count: 0 };
}

async function selectAccount(method, amount, context = {}) {
  if (context.accountId) {
    const chosen = await PaymentAccount.findOne({ _id: context.accountId, method, enabled: true }).lean();
    if (chosen && method === 'crypto' && context.coin && chosen.crypto?.coin !== context.coin) return null;
    if (chosen) {
      const limits = chosen.limits || {};
      if (amount >= (limits.minAmount || MIN_DEPOSIT_INR)
        && amount <= (limits.maxAmount || Number.MAX_SAFE_INTEGER)
        && matchesAssignment(chosen, context)
        && buildTarget(chosen)) {
        return chosen;
      }
    }
  }
  const filter = { method, enabled: true };
  if (method === 'crypto' && context.coin && context.coin !== 'OTHER') filter['crypto.coin'] = context.coin;
  const accounts = await PaymentAccount.find(filter)
    .sort({ 'assignmentRules.priority': 1, lastAssignedAt: 1, assignmentCount: 1, createdAt: 1 })
    .lean();

  for (const account of accounts) {
    const limits = account.limits || {};
    if (amount < (limits.minAmount || MIN_DEPOSIT_INR) || amount > (limits.maxAmount || Number.MAX_SAFE_INTEGER)) continue;
    if (!matchesAssignment(account, context)) continue;
    if (!buildTarget(account)) continue;
    const usage = await accountUsage(account._id);
    if (usage.amount + amount > (limits.dailyAmountLimit || Number.MAX_SAFE_INTEGER)) continue;
    if (usage.count + 1 > (limits.dailyCountLimit || Number.MAX_SAFE_INTEGER)) continue;
    return account;
  }
  return null;
}

function buildInstructions(account, amount, reference) {
  if (account.method === 'upi') {
    return {
      mode: 'manual_upi',
      upiId: account.upiId,
      amount,
      currency: 'INR',
      reference,
      message: 'Send the payment externally to this UPI ID, then submit your UTR/reference number for admin verification.',
    };
  }
  return {
    mode: 'manual_crypto',
    coin: account.crypto.coin,
    network: account.crypto.network,
    walletAddress: account.crypto.walletAddress,
    amount,
    currency: 'INR',
    reference,
    message: 'Send crypto externally to this wallet, then submit the transaction hash for admin verification.',
  };
}

async function createDeposit(req, payload) {
  const amount = Number(payload.amount);
  const method = String(payload.method || '').toLowerCase();
  const coin = method === 'crypto' ? String(payload.coin || payload.currency || 'USDT').toUpperCase() : '';
  const userPaymentReference = String(payload.userPaymentReference || '').trim();

  if (!METHODS.includes(method)) {
    const err = new Error('Unsupported payment method');
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_INR) {
    const err = new Error(`Minimum deposit amount is ₹${MIN_DEPOSIT_INR}`);
    err.status = 400;
    throw err;
  }
  if (method === 'crypto' && !SUPPORTED_COINS.includes(coin)) {
    const err = new Error('Unsupported cryptocurrency');
    err.status = 400;
    throw err;
  }
  if (!userPaymentReference) {
    const err = new Error(method === 'upi' ? 'UPI reference / UTR number is required' : 'Transaction hash is required');
    err.status = 400;
    throw err;
  }

  const context = {
    currency: 'INR',
    coin,
    accountId: payload.accountId,
    businessUnit: payload.businessUnit || 'default',
    brand: payload.brand || 'default',
    region: payload.region || 'global',
  };
  const account = await selectAccount(method, amount, context);
  if (!account) {
    const err = new Error('No enabled payment address is available for this deposit method');
    err.status = 503;
    throw err;
  }

  const reference = `DEP-${uuidv4().slice(0, 8).toUpperCase()}`;
  const target = buildTarget(account);
  const deposit = await DepositRequest.create({
    userId: req.user.id,
    accountId: account._id,
    amount,
    currency: 'INR',
    method,
    coin,
    provider: account.provider,
    reference,
    userPaymentReference,
    assignedPaymentTarget: target,
    businessUnit: context.businessUnit,
    brand: context.brand,
    region: context.region,
    instructions: buildInstructions(account, amount, reference),
    history: [{ status: 'pending', by: req.user.id, note: 'User clicked Complete Payment; pending admin verification' }],
  });
  const tx = await Transaction.create({
    userId: req.user.id,
    type: 'deposit',
    amount,
    method: method === 'upi' ? 'UPI' : coin,
    reference,
    accountId: account._id,
    requestId: deposit._id,
    description: `Manual ${method} deposit pending admin verification`,
    status: 'pending',
    paymentData: { assignedPaymentTarget: target, coin, userPaymentReference },
  });
  deposit.transactionId = tx._id;
  await deposit.save();
  await PaymentAccount.findByIdAndUpdate(account._id, { $inc: { assignmentCount: 1 }, lastAssignedAt: new Date() });
  await monitorAccountThreshold(account._id);
  return normalizeDoc(await DepositRequest.findById(deposit._id).populate('accountId', 'label method provider upiId crypto').lean());
}

async function updateDepositStatus(req, id, status, note = '') {
  if (!STATUS.includes(status)) {
    const err = new Error('Invalid deposit status');
    err.status = 400;
    throw err;
  }
  const deposit = await DepositRequest.findById(id);
  if (!deposit) {
    const err = new Error('Deposit request not found');
    err.status = 404;
    throw err;
  }
  if (deposit.status !== 'pending') {
    const err = new Error('Only pending deposits can be approved or rejected');
    err.status = 409;
    throw err;
  }

  const before = normalizeDoc(deposit);
  deposit.status = status;
  deposit.adminNote = note;
  deposit.history.push({ status, by: req.user?.id || null, note });
  await deposit.save();

  if (deposit.transactionId) {
    await Transaction.findByIdAndUpdate(deposit.transactionId, {
      status: status === 'approved' ? 'completed' : 'failed',
      description: status === 'approved' ? 'Manual deposit approved by admin' : 'Manual deposit rejected by admin',
    });
  }
  if (status === 'approved') {
    await User.findByIdAndUpdate(deposit.userId, { $inc: { balance: deposit.amount } });
  }

  await audit(req, 'deposit.status_update', 'DepositRequest', deposit._id, before, normalizeDoc(deposit), { status, note });
  return normalizeDoc(deposit);
}

async function approvedDepositTotal(userId) {
  const id = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;
  const [agg] = await DepositRequest.aggregate([
    { $match: { userId: id, status: 'approved' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return agg?.total || 0;
}

async function monitorAccountThreshold(accountId) {
  const account = await PaymentAccount.findById(accountId).lean();
  if (!account) return;
  const limits = account.limits || {};
  const usage = await accountUsage(account._id);
  const amountLimit = limits.dailyAmountLimit || 0;
  const countLimit = limits.dailyCountLimit || 0;
  const threshold = (limits.warningThresholdPercent || 80) / 100;
  const amountHit = amountLimit && usage.amount >= amountLimit * threshold;
  const countHit = countLimit && usage.count >= countLimit * threshold;
  if (!amountHit && !countHit) return;
  const type = amountHit ? 'daily_amount_threshold' : 'daily_count_threshold';
  const open = await PaymentAlert.findOne({ accountId: account._id, type, acknowledged: false });
  if (!open) {
    await PaymentAlert.create({
      accountId: account._id,
      severity: usage.amount >= amountLimit || usage.count >= countLimit ? 'critical' : 'warning',
      type,
      message: `${account.label} is nearing manual deposit capacity`,
      metadata: { usage, limits },
    });
  }
}

async function dashboardStats() {
  const [depositAgg, methodAgg, statusAgg, accounts, alerts] = await Promise.all([
    DepositRequest.aggregate([{ $match: { status: 'approved' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    DepositRequest.aggregate([{ $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    DepositRequest.aggregate([{ $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    PaymentAccount.find().lean(),
    PaymentAlert.find({ acknowledged: false }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);
  const approved = statusAgg.find(s => s._id === 'approved')?.count || 0;
  const rejected = statusAgg.find(s => s._id === 'rejected')?.count || 0;
  const totalStatus = statusAgg.reduce((sum, s) => sum + s.count, 0);
  const utilization = [];
  for (const account of accounts) {
    const usage = await accountUsage(account._id);
    utilization.push({
      account: normalizeDoc(account),
      dailyAmount: usage.amount,
      dailyCount: usage.count,
      amountUtilization: account.limits?.dailyAmountLimit ? Math.round((usage.amount / account.limits.dailyAmountLimit) * 100) : 0,
      countUtilization: account.limits?.dailyCountLimit ? Math.round((usage.count / account.limits.dailyCountLimit) * 100) : 0,
    });
  }
  return {
    minDeposit: MIN_DEPOSIT_INR,
    totalDeposits: depositAgg[0]?.total || 0,
    totalDepositRequests: totalStatus,
    depositsByMethod: methodAgg,
    statusCounts: statusAgg,
    approvalRate: totalStatus ? Number(((approved / totalStatus) * 100).toFixed(2)) : 0,
    successRate: totalStatus ? Number(((approved / totalStatus) * 100).toFixed(2)) : 0,
    rejectedTransactions: rejected,
    failedTransactions: rejected,
    pendingTransactions: statusAgg.find(s => s._id === 'pending')?.count || 0,
    accountUtilization: utilization,
    alerts: alerts.map(normalizeDoc),
  };
}

async function reports() {
  const now = new Date();
  const ranges = {
    daily: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    weekly: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    monthly: new Date(now.getFullYear(), now.getMonth(), 1),
  };
  const out = {};
  for (const [key, since] of Object.entries(ranges)) {
    const rows = await DepositRequest.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    out[key] = rows.reduce((summary, row) => ({
      total: summary.total + row.total,
      count: summary.count + row.count,
      byStatus: { ...summary.byStatus, [row._id]: { total: row.total, count: row.count } },
    }), { total: 0, count: 0, byStatus: {} });
  }
  return out;
}

module.exports = {
  MIN_DEPOSIT_INR,
  createAccount,
  updateAccount,
  removeAccount,
  listAccounts,
  createDeposit,
  updateDepositStatus,
  approvedDepositTotal,
  dashboardStats,
  reports,
  audit,
};

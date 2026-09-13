const mongoose = require('mongoose');

const encryptedCredentialSchema = new mongoose.Schema({
  iv: String,
  tag: String,
  data: String,
  redacted: { type: Boolean, default: true },
}, { _id: false });

const paymentAccountSchema = new mongoose.Schema({
  method: {
    type: String,
    enum: ['upi', 'crypto'],
    required: true,
    index: true,
  },
  provider: {
    type: String,
    enum: ['manual_upi', 'manual_crypto', 'other'],
    required: true,
  },
  label: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, default: '', maxlength: 500 },
  enabled: { type: Boolean, default: true, index: true },
  businessUnit: { type: String, default: 'default', trim: true, index: true },
  brand: { type: String, default: 'default', trim: true, index: true },
  region: { type: String, default: 'global', trim: true, index: true },
  upiId: {
    type: String,
    default: '',
    trim: true,
    validate: {
      validator(value) {
        return !value || /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/.test(value);
      },
      message: 'Invalid UPI ID format',
    },
  },
  crypto: {
    coin: {
      type: String,
      enum: ['BTC', 'ETH', 'BNB', 'USDT', 'OTHER', ''],
      default: '',
      uppercase: true,
    },
    network: { type: String, default: '', trim: true },
    walletAddress: { type: String, default: '', trim: true },
  },
  lastAssignedAt: { type: Date, default: null, index: true },
  assignmentCount: { type: Number, default: 0 },
  credentials: { type: encryptedCredentialSchema, default: null, select: false },
  credentialSummary: { type: String, default: 'Not configured' },
  limits: {
    minAmount: { type: Number, default: 1 },
    maxAmount: { type: Number, default: 50000 },
    dailyAmountLimit: { type: Number, default: 100000 },
    dailyCountLimit: { type: Number, default: 1000 },
    warningThresholdPercent: { type: Number, default: 80 },
  },
  assignmentRules: {
    priority: { type: Number, default: 100 },
    currencies: [{ type: String, uppercase: true }],
    allowedRegions: [{ type: String }],
    allowedBrands: [{ type: String }],
    allowedBusinessUnits: [{ type: String }],
  },
  health: {
    status: { type: String, enum: ['healthy', 'warning', 'degraded', 'disabled'], default: 'healthy' },
    lastCheckedAt: Date,
    message: { type: String, default: 'Account ready' },
  },
}, { timestamps: true });

paymentAccountSchema.index({ method: 1, enabled: 1, businessUnit: 1, brand: 1, region: 1 });

module.exports = mongoose.model('PaymentAccount', paymentAccountSchema);

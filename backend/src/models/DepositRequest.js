const mongoose = require('mongoose');

const depositRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentAccount', required: true, index: true },
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'INR', uppercase: true },
  method: { type: String, enum: ['upi', 'crypto'], required: true, index: true },
  coin: { type: String, default: '', uppercase: true },
  provider: { type: String, required: true },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true,
  },
  reference: { type: String, required: true, unique: true },
  userPaymentReference: { type: String, default: '', trim: true, index: true },
  assignedPaymentTarget: { type: String, required: true },
  adminNote: { type: String, default: '' },
  businessUnit: { type: String, default: 'default' },
  brand: { type: String, default: 'default' },
  region: { type: String, default: 'global' },
  instructions: { type: mongoose.Schema.Types.Mixed, default: {} },
  monitoring: {
    kycStatus: { type: String, enum: ['not_required', 'pending', 'passed', 'failed'], default: 'pending' },
    amlStatus: { type: String, enum: ['pending', 'clear', 'review', 'blocked'], default: 'pending' },
    riskScore: { type: Number, default: 0 },
    notes: { type: String, default: '' },
  },
  history: [{
    status: String,
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: String,
  }],
}, { timestamps: true });

depositRequestSchema.index({ createdAt: -1 });
depositRequestSchema.index({ accountId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('DepositRequest', depositRequestSchema);

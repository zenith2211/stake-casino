const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:        { type: String, enum: ['deposit', 'withdraw', 'withdrawal', 'bonus', 'bet', 'win', 'demo'], required: true },
  amount:      { type: Number, required: true },
  method:      { type: String, default: 'internal' },
  reference:   { type: String, default: null, index: true },
  accountId:   { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentAccount', default: null },
  requestId:   { type: mongoose.Schema.Types.ObjectId, ref: 'DepositRequest', default: null },
  description: { type: String, default: '' },
  status:      { type: String, enum: ['pending', 'processing', 'completed', 'failed', 'approved', 'rejected'], default: 'completed' },
  paymentData: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

module.exports = mongoose.model('Transaction', transactionSchema);

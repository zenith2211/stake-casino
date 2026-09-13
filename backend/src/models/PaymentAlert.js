const mongoose = require('mongoose');

const paymentAlertSchema = new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentAccount', default: null, index: true },
  severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
  type: { type: String, required: true },
  message: { type: String, required: true },
  acknowledged: { type: Boolean, default: false, index: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

paymentAlertSchema.index({ createdAt: -1 });

module.exports = mongoose.model('PaymentAlert', paymentAlertSchema);

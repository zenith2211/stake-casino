const mongoose = require('mongoose');

const betSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username:  { type: String, required: true },
  game:      { type: String, required: true },
  betAmount: { type: Number, required: true },
  multiplier:{ type: Number, default: 1 },
  payout:    { type: Number, default: 0 },
  won:       { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('Bet', betSchema);

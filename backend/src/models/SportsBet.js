const mongoose = require('mongoose');

/**
 * A real-sportsbook bet.
 * Bets are created `pending`, the stake is deducted immediately, and they are
 * settled later by the background settlement job once every selected match has
 * a final result from the-odds-api /scores endpoint.
 *
 * Bet outcome rules:
 *   - won    → every selection won                → pay stake * totalOdds
 *   - lost   → at least one selection lost         → pay 0
 *   - void   → every non-losing selection voided   → refund stake (stake * 1)
 *   - partial-void handling: a voided leg in a multi is treated as odds 1.0
 *     (standard bookmaker behaviour) and the rest of the bet still settles.
 */

const selectionSchema = new mongoose.Schema({
  matchId:    { type: String, required: true },   // the-odds-api event id
  sportKey:   { type: String, default: '' },       // e.g. basketball_nba
  match:      { type: String, default: '' },       // "San Antonio Spurs vs New York Knicks"
  selection:  { type: String, required: true },     // team name backed, e.g. "New York Knicks"
  odd:        { type: Number, required: true },
  commenceTime: { type: Date, default: null },
  status:     { type: String, enum: ['pending', 'won', 'lost', 'void'], default: 'pending', index: true },
  resultNote: { type: String, default: '' },        // e.g. "Final: NYK 112 - SAS 104"
}, { _id: false });

const sportsBetSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  username:   { type: String, required: true },
  betType:    { type: String, enum: ['singles', 'multi', 'system'], default: 'singles' },
  stake:      { type: Number, required: true, min: 0 },
  totalOdds:  { type: Number, required: true },
  potentialPayout: { type: Number, required: true },
  selections: { type: [selectionSchema], required: true },
  status:     { type: String, enum: ['pending', 'won', 'lost', 'void'], default: 'pending', index: true },
  payout:     { type: Number, default: 0 },
  settledAt:  { type: Date, default: null },
}, { timestamps: true });

sportsBetSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('SportsBet', sportsBetSchema);

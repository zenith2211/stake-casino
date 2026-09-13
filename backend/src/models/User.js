const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true, trim: true },
  email:        { type: String, required: true, unique: true, lowercase: true },
  password:     { type: String, default: null },
  googleId:     { type: String, default: null },
  role:         { type: String, enum: ['user', 'admin'], default: 'user' },
  balance:      { type: Number, default: 0 },
  totalWagered: { type: Number, default: 0 },
  totalWon:     { type: Number, default: 0 },
  level:        { type: Number, default: 1 },
  xp:           { type: Number, default: 0 },
  referralCode: { type: String, unique: true },
  referredBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isBanned:     { type: Boolean, default: false },
  avatar:       { type: String, default: null },
  twoFA:        { type: Boolean, default: false },
  lastLogin:    { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// ── Connect to MongoDB ────────────────────────────────────────
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log('⚠️  No MONGODB_URI found — using in-memory fallback');
    return false;
  }
  try {
    await mongoose.connect(uri, { dbName: 'stake-casino' });
    console.log('✅  MongoDB Atlas connected');
    await seedDefaultUsers();
    return true;
  } catch (err) {
    console.error('❌  MongoDB connection failed:', err.message);
    return false;
  }
}

// ── Seed admin + demo users if they don't exist ───────────────
async function seedDefaultUsers() {
  const User = require('../models/User');
  const Transaction = require('../models/Transaction');

  const adminExists = await User.findOne({ email: 'admin@casino.com' });
  if (!adminExists) {
    const adminHash = await bcrypt.hash('admin123', 12);
    const admin = await User.create({
      username: 'admin', email: 'admin@casino.com',
      password: adminHash, role: 'admin',
      balance: 999999, level: 10, xp: 10000,
      referralCode: 'ADMIN001',
    });
    console.log('🌱  Admin user seeded');
  }

  // ── Owner admin — zenith01yt@gmail.com ─────────────────────
  const ownerExists = await User.findOne({ email: 'zenith01yt@gmail.com' });
  if (!ownerExists) {
    await User.create({
      username: 'zenith01', email: 'zenith01yt@gmail.com',
      password: null, role: 'admin',
      balance: 999999, level: 10, xp: 10000,
      referralCode: 'ZENITH01',
      isBanned: false, twoFA: false,
    });
    console.log('🌱  Owner admin seeded (zenith01yt@gmail.com)');
  } else if (ownerExists.role !== 'admin') {
    // Ensure it's always admin even if already existed as user
    await User.findOneAndUpdate({ email: 'zenith01yt@gmail.com' }, { role: 'admin' });
    console.log('🔑  Owner email upgraded to admin');
  }

  const demoExists = await User.findOne({ email: 'demo@casino.com' });
  if (!demoExists) {
    const demoHash = await bcrypt.hash('demo123', 12);
    await User.create({
      username: 'demouser', email: 'demo@casino.com',
      password: demoHash, role: 'user',
      balance: 0, totalWagered: 0, totalWon: 0,
      level: 3, xp: 1500, referralCode: 'DEMO001',
    });
    console.log('🌱  Demo user seeded');
  }
}

// ── DB API (matches original interface exactly) ───────────────
// All methods are async-compatible; callers that were sync now await.

const User        = () => require('../models/User');
const Bet         = () => require('../models/Bet');
const Transaction = () => require('../models/Transaction');


// ── Normalize MongoDB _id to id ──────────────────────────────
function normalize(doc) {
  if (!doc) return null;
  if (Array.isArray(doc)) return doc.map(normalize);
  const obj = { ...doc };
  if (obj._id) { obj.id = obj._id.toString(); }
  return obj;
}

const db = {
  // ── Users ──────────────────────────────────────────────────
  async findUserById(id) {
    try { return normalize(await User().findById(id).lean()); }
    catch { return null; }
  },

  async findUserByEmail(email) {
    return normalize(await User().findOne({ email: email.toLowerCase() }).lean());
  },

  async findUserByUsername(username) {
    return normalize(await User().findOne({ username }).lean());
  },

  async createUser(data) {
    const user = await User().create(data);
    return normalize(user.toObject());
  },

  async updateUser(id, data) {
    return normalize(await User().findByIdAndUpdate(id, { $set: data }, { returnDocument: 'after' }).lean());
  },

  async getAllUsers() {
    return normalize(await User().find().lean());
  },

  // ── Bets ───────────────────────────────────────────────────
  async createBet(data) {
    const bet = await Bet().create(data);
    return normalize(bet.toObject());
  },

  async getBetsByUser(userId, limit = 50) {
    return normalize(await Bet().find({ userId }).sort({ createdAt: -1 }).limit(limit).lean());
  },

  async getAllBets(limit = 100) {
    return normalize(await Bet().find().sort({ createdAt: -1 }).limit(limit).lean());
  },

  async getRecentBets(limit = 20) {
    return normalize(await Bet().find().sort({ createdAt: -1 }).limit(limit).lean());
  },

  // ── Transactions ───────────────────────────────────────────
  async createTransaction(data) {
    const tx = await Transaction().create(data);
    return normalize(tx.toObject());
  },

  async getTransactionsByUser(userId) {
    return normalize(await Transaction().find({ userId }).sort({ createdAt: -1 }).lean());
  },

  async getAllTransactions() {
    return normalize(await Transaction().find().sort({ createdAt: -1 }).lean());
  },

  // ── Stats ──────────────────────────────────────────────────
  async getStats() {
    const [totalUsers, totalBets, betAgg] = await Promise.all([
      User().countDocuments({ role: 'user' }),
      Bet().countDocuments(),
      Bet().aggregate([
        { $group: {
          _id: null,
          totalWagered: { $sum: '$betAmount' },
          totalPayout:  { $sum: '$payout' },
        }},
      ]),
    ]);
    const agg = betAgg[0] || { totalWagered: 0, totalPayout: 0 };
    return {
      totalUsers,
      totalBets,
      totalWagered: agg.totalWagered,
      totalRevenue: agg.totalWagered - agg.totalPayout,
      activeUsers: totalUsers,
    };
  },
};

module.exports = { connectDB, ...db };

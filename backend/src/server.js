const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createServer } = require('http');
const path = require('path');
const dotenv = require('dotenv');
const passport = require('passport');
const session = require('express-session');

dotenv.config();

const { connectDB }  = require('./config/db');
const { initWebSocket } = require('./websocket/wsServer');
const { startSettlementLoop } = require('./services/sportsSettlement');
const authRoutes    = require('./routes/auth');
const userRoutes    = require('./routes/user');
const gameRoutes    = require('./routes/game');
const walletRoutes  = require('./routes/wallet');
const adminRoutes   = require('./routes/admin');
const betRoutes     = require('./routes/bet');
const sportsRoutes   = require('./routes/sports');
const paymentRoutes  = require('./routes/payment');

const app = express();
const httpServer = createServer(app);

// ── Resolve frontend path ────────────────────────────────────────────────────
// Works for both local dev and Docker/Railway:
//   Local:  backend/src/server.js  →  ../../frontend  =  stake-redesigned/frontend
//   Docker: /app/src/server.js     →  /frontend       (copied there by Dockerfile)
const FRONTEND_PATH = (() => {
  const relative = path.join(__dirname, '../../frontend');
  const fs = require('fs');
  if (fs.existsSync(relative)) return relative;
  // Fallback: Docker puts frontend at /frontend
  if (fs.existsSync('/frontend')) return '/frontend';
  return relative; // let it fail with a clear missing-path error
})();

console.log(`📁  Frontend path: ${FRONTEND_PATH}`);

// ── Security middleware ──────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));

// ── Simple built-in rate limiter ─────────────────────────────────────────────
const rateLimitStore = new Map();
function makeRateLimiter(windowMs, max, message) {
  return (req, res, next) => {
    const key = req.ip + (req.path || '');
    const now = Date.now();
    const record = rateLimitStore.get(key) || { count: 0, start: now };
    if (now - record.start > windowMs) {
      record.count = 0;
      record.start = now;
    }
    record.count++;
    rateLimitStore.set(key, record);
    if (record.count > max) {
      return res.status(429).json(message);
    }
    next();
  };
}

const limiter     = makeRateLimiter(15*60*1000, 500, { error: 'Too many requests, please slow down.' });
const authLimiter = makeRateLimiter(5*60*1000,  50,  { error: 'Too many auth attempts, please try again in 5 minutes.' });

app.use('/api/', limiter);
app.use('/api/auth', authLimiter);

// ── Session (required for Google OAuth passport flow) ────────────────────────
app.use(session({
  secret: process.env.JWT_SECRET || 'fallback-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 5 * 60 * 1000,
  },
}));

// ── Passport ─────────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

// ── Static frontend ──────────────────────────────────────────────────────────
app.use(express.static(FRONTEND_PATH));

// ── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',   authRoutes);
app.use('/api/user',   userRoutes);
app.use('/api/games',  gameRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin',  adminRoutes);
app.use('/api/bets',   betRoutes);
app.use('/api/sports',  sportsRoutes);
app.use('/api/payment', paymentRoutes);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'OK', timestamp: new Date().toISOString() }),
);

// ── Catch-all → serve index.html ─────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Route not found' });
  }
  res.sendFile(path.join(FRONTEND_PATH, 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// ── WebSocket ────────────────────────────────────────────────────────────────
initWebSocket(httpServer);

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  startSettlementLoop(10 * 60 * 1000);
  httpServer.listen(PORT, () => {
    console.log(`\n🚀  Casino server running   → http://localhost:${PORT}`);
    console.log(`🎮  WebSocket ready         → ws://localhost:${PORT}/ws`);
    console.log(`🗄️   MongoDB Atlas           → connected`);
    console.log(`\n  Demo credentials:`);
    console.log(`    admin@casino.com  /  admin123`);
    console.log(`    demo@casino.com   /  demo123\n`);
  });
});

module.exports = { app, httpServer };

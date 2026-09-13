const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const nodemailer = require('nodemailer');
const db = require('../config/db');
const { generateToken, authenticate } = require('../middleware/auth');

const router = express.Router();

// ── In-memory OTP store: { email -> { otp, expiresAt } } ──────
const otpStore = new Map();

// ── Nodemailer transporter ─────────────────────────────────────
let transporter = null;
try {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
} catch(e) {
  console.warn('⚠️  Nodemailer setup failed:', e.message);
}

// ── Passport Google Strategy ───────────────────────────────────
try {
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    let user = await db.findUserByEmail(email);
    if (user) {
      return done(null, { user, isNew: false });
    }
    return done(null, {
      isNew: true,
      email,
      googleId: profile.id,
      avatar: profile.photos?.[0]?.value || null,
    });
  } catch (err) {
    return done(err);
  }
}));
} catch(e) {
  console.warn('⚠️  Google OAuth setup failed:', e.message);
}

// ── Passport session serialization (needed for OAuth handshake) ─
passport.serializeUser((u, done) => done(null, u));
passport.deserializeUser((u, done) => done(null, u));

// ── POST /api/auth/register ────────────────────────────────────
router.post('/register', [
  body('username').trim().isLength({ min: 3, max: 20 }).matches(/^[a-zA-Z0-9_]+$/),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { username, email, password, referralCode } = req.body;
    if (await db.findUserByEmail(email)) return res.status(400).json({ error: 'Email already registered' });
    if (await db.findUserByUsername(username)) return res.status(400).json({ error: 'Username taken' });

    const hashedPassword = await bcrypt.hash(password, 12);
    const newReferralCode = username.toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();

    let referredBy = null;
    if (referralCode) {
      const allUsers = await db.getAllUsers(); const referrer = allUsers.find(u => u.referralCode === referralCode);
      if (referrer) {
        referredBy = referrer.id;
      }
    }

    const user = await db.createUser({
      username, email, password: hashedPassword,
      role: 'user', balance: 0, totalWagered: 0,
      totalWon: 0, level: 1, xp: 0,
      referralCode: newReferralCode, referredBy,
      isBanned: false, avatar: null, twoFA: false,
    });

    const token = generateToken(user.id);
    const { password: _, ...userSafe } = user;
    res.status(201).json({ token, user: userSafe, message: 'Account created! Welcome to Stake Casino.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── POST /api/auth/login ───────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { email, password } = req.body;
    const user = await db.findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned. Contact support.' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

    await db.updateUser(user.id, { lastLogin: new Date() });
    const token = generateToken(user.id);
    const { password: _, ...userSafe } = user;
    res.json({ token, user: userSafe });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── GET /api/auth/me ───────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  const { password, ...userSafe } = req.user;
  res.json({ user: userSafe });
});

// ══════════════════════════════════════════════════════════════
//  GOOGLE OAUTH ROUTES
// ══════════════════════════════════════════════════════════════

// Step 1: Redirect to Google
// NOTE: No session:false here — session is needed for the OAuth state verification
router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Step 2: Google callback
// NOTE: session:false removed — passport needs the session to complete the handshake
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?auth=error' }),
  (req, res) => {
    const data = req.user;
    if (data.isNew) {
      // New user — redirect to frontend with temp data, username needed
      const payload = encodeURIComponent(JSON.stringify({
        email: data.email,
        googleId: data.googleId,
        avatar: data.avatar,
      }));
      return res.redirect(`/?auth=google-new&data=${payload}`);
    }
    // Existing user — issue token and redirect
    const token = generateToken(data.user.id);
    return res.redirect(`/?auth=google-ok&token=${token}`);
  }
);

// Step 3: Complete Google signup (set username)
router.post('/google/complete', [
  body('username').trim().isLength({ min: 3, max: 20 }).matches(/^[a-zA-Z0-9_]+$/),
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { username, email, googleId, avatar, referralCode } = req.body;

    if (await db.findUserByEmail(email)) return res.status(400).json({ error: 'Email already registered' });
    if (await db.findUserByUsername(username)) return res.status(400).json({ error: 'Username taken' });

    const referralCodeNew = username.toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();

    let referredBy = null;
    if (referralCode) {
      const allUsers = await db.getAllUsers(); const referrer = allUsers.find(u => u.referralCode === referralCode);
      if (referrer) {
        referredBy = referrer.id;
      }
    }

    const user = await db.createUser({
      username, email, password: null,
      googleId, avatar,
      role: 'user', balance: 0, totalWagered: 0,
      totalWon: 0, level: 1, xp: 0,
      referralCode: referralCodeNew, referredBy,
      isBanned: false, twoFA: false,
    });

    const token = generateToken(user.id);
    const { password: _, ...userSafe } = user;
    res.status(201).json({ token, user: userSafe, message: 'Account created! Welcome to Stake Casino.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete signup' });
  }
});

// ══════════════════════════════════════════════════════════════
//  EMAIL OTP ROUTES
// ══════════════════════════════════════════════════════════════

// Step 1: Send OTP
router.post('/send-otp', [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid email address' });

    const { email } = req.body;

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    otpStore.set(email, { otp, expiresAt });

    // Send email
    if (!transporter) {
      return res.status(500).json({ error: 'Email service not configured. Check GMAIL_USER and GMAIL_APP_PASSWORD in .env' });
    }
    await transporter.sendMail({
      from: `"Stake Casino" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: 'Your Stake Casino Login Code',
      html: `
        <div style="background:#0f1923;padding:40px;font-family:Arial,sans-serif;color:#ffffff;max-width:480px;margin:0 auto;border-radius:12px;">
          <div style="text-align:center;margin-bottom:32px;">
            <span style="font-size:36px;font-weight:900;color:#00e701;letter-spacing:4px;">STAKE</span>
          </div>
          <h2 style="color:#ffffff;margin-bottom:8px;">Your verification code</h2>
          <p style="color:#b1bad3;margin-bottom:32px;">Enter this code to sign in to your account.</p>
          <div style="background:#1a2c38;border-radius:12px;padding:32px;text-align:center;margin-bottom:24px;">
            <span style="font-size:48px;font-weight:900;color:#00e701;letter-spacing:12px;">${otp}</span>
          </div>
          <p style="color:#6c7a8d;font-size:13px;">This code expires in 10 minutes. Never share it with anyone.</p>
        </div>
      `,
    });

    // Check if user exists to tell frontend
    const existingUser = await db.findUserByEmail(email);
    res.json({
      message: 'OTP sent successfully',
      isNewUser: !existingUser,
    });
  } catch (err) {
    console.error('OTP send error:', err);
    res.status(500).json({ error: 'Failed to send OTP. Check email configuration.' });
  }
});

// Step 2: Verify OTP
router.post('/verify-otp', [
  body('email').isEmail().normalizeEmail(),
  body('otp').isLength({ min: 6, max: 6 }).isNumeric(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input' });

    const { email, otp } = req.body;
    const record = otpStore.get(email);

    if (!record) return res.status(400).json({ error: 'No OTP requested for this email' });
    if (Date.now() > record.expiresAt) {
      otpStore.delete(email);
      return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    }
    if (record.otp !== otp) return res.status(400).json({ error: 'Incorrect OTP' });

    otpStore.delete(email);

    // ── Owner email always gets admin role ──────────────────
    const ADMIN_EMAILS = ['zenith01yt@gmail.com', 'vr377817@gmail.com'];

    // Check if user exists
    const existingUser = await db.findUserByEmail(email);
    if (existingUser) {
      // Existing user — log them in
      if (existingUser.isBanned) return res.status(403).json({ error: 'Account banned.' });

      // Ensure admin emails always have admin role
      if (ADMIN_EMAILS.includes(email) && existingUser.role !== 'admin') {
        await db.updateUser(existingUser.id, { role: 'admin' });
        existingUser.role = 'admin';
      }

      await db.updateUser(existingUser.id, { lastLogin: new Date() });
      const token = generateToken(existingUser.id);
      const { password: _, ...userSafe } = existingUser;
      return res.json({ token, user: userSafe, isNewUser: false });
    }

    // New user — need username (but auto-grant admin for owner email)
    if (ADMIN_EMAILS.includes(email)) {
      // Auto-create admin account without needing username step
      const newReferralCode = 'ZENITH' + Math.random().toString(36).substr(2,4).toUpperCase();
      const user = await db.createUser({
        username: 'zenith01', email, password: null,
        role: 'admin', balance: 999999, totalWagered: 0,
        totalWon: 0, level: 10, xp: 10000,
        referralCode: newReferralCode, referredBy: null,
        isBanned: false, avatar: null, twoFA: false,
      });
      const token = generateToken(user.id);
      const { password: _, ...userSafe } = user;
      return res.json({ token, user: userSafe, isNewUser: false });
    }

    // New regular user — need username
    res.json({ isNewUser: true, email, message: 'OTP verified. Please choose a username.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'OTP verification failed' });
  }
});

// Step 3: Complete OTP signup (set username)
router.post('/otp/complete', [
  body('username').trim().isLength({ min: 3, max: 20 }).matches(/^[a-zA-Z0-9_]+$/),
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { username, email, referralCode } = req.body;

    if (await db.findUserByEmail(email)) return res.status(400).json({ error: 'Email already registered' });
    if (await db.findUserByUsername(username)) return res.status(400).json({ error: 'Username taken' });

    const newReferralCode = username.toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();

    let referredBy = null;
    if (referralCode) {
      const allUsers = await db.getAllUsers(); const referrer = allUsers.find(u => u.referralCode === referralCode);
      if (referrer) {
        referredBy = referrer.id;
      }
    }

    const user = await db.createUser({
      username, email, password: null,
      role: 'user', balance: 0, totalWagered: 0,
      totalWon: 0, level: 1, xp: 0,
      referralCode: newReferralCode, referredBy,
      isBanned: false, avatar: null, twoFA: false,
    });

    const token = generateToken(user.id);
    const { password: _, ...userSafe } = user;
    res.status(201).json({ token, user: userSafe, message: 'Account created! Welcome to Stake Casino.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete signup' });
  }
});

module.exports = router;

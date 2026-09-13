const jwt = require('jsonwebtoken');
const db = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'casino-super-secret-key-change-in-production';

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await db.findUserById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Account banned' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const generateToken = (userId) => {
  return jwt.sign({ userId: userId.toString() }, JWT_SECRET, { expiresIn: '7d' });
};

module.exports = { authenticate, requireAdmin, generateToken };

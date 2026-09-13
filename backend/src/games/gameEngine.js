const crypto = require('crypto');

/**
 * Provably Fair System
 * Users can verify every game result using:
 * 1. Server seed (revealed after game)
 * 2. Client seed (provided by user)
 * 3. Nonce (increments each bet)
 */

class ProvablyFair {
  // Generate a random server seed
  static generateServerSeed() {
    return crypto.randomBytes(32).toString('hex');
  }

  // Hash the server seed (shown to user before game)
  static hashServerSeed(serverSeed) {
    return crypto.createHash('sha256').update(serverSeed).digest('hex');
  }

  // Generate a random client seed
  static generateClientSeed() {
    return crypto.randomBytes(16).toString('hex');
  }

  // Core: generate a float 0-1 from seeds
  static generateFloat(serverSeed, clientSeed, nonce) {
    const hmac = crypto.createHmac('sha256', serverSeed);
    hmac.update(`${clientSeed}:${nonce}`);
    const hash = hmac.digest('hex');
    
    // Use first 8 hex chars = 32 bits
    const decimal = parseInt(hash.slice(0, 8), 16);
    return decimal / 0xffffffff;
  }

  // Generate multiple floats for complex games
  static generateFloats(serverSeed, clientSeed, nonce, count) {
    const results = [];
    for (let i = 0; i < count; i++) {
      results.push(this.generateFloat(serverSeed, clientSeed, `${nonce}-${i}`));
    }
    return results;
  }

  // Verify a game result
  static verify(serverSeed, clientSeed, nonce) {
    return this.generateFloat(serverSeed, clientSeed, nonce);
  }
}

// ===== DICE GAME ENGINE =====
class DiceEngine {
  static roll(serverSeed, clientSeed, nonce) {
    const float = ProvablyFair.generateFloat(serverSeed, clientSeed, nonce);
    return parseFloat((float * 100).toFixed(2)); // 0.00 to 100.00
  }

  static calculateResult(roll, target, isOver, betAmount) {
    const won = isOver ? roll > target : roll < target;
    const winChance = isOver ? (100 - target) : target;
    const multiplier = won ? parseFloat((99 / winChance).toFixed(4)) : 0;
    const payout = won ? parseFloat((betAmount * multiplier).toFixed(2)) : 0;
    return { roll, won, multiplier: won ? multiplier : 0, payout };
  }
}

// ===== CRASH GAME ENGINE =====
class CrashEngine {
  static calculateCrashPoint(serverSeed, clientSeed, nonce) {
    const float = ProvablyFair.generateFloat(serverSeed, clientSeed, nonce);
    
    // House edge of 1%
    if (float * 100 < 1) return 1.00; // instant crash (1% chance)
    
    // Formula: 99 / (1 - e)
    const crashPoint = Math.floor(99 / (1 - float)) / 100;
    return Math.max(1.00, parseFloat(crashPoint.toFixed(2)));
  }

  static calculatePayout(betAmount, cashoutMultiplier, crashPoint) {
    if (cashoutMultiplier > crashPoint) return { won: false, payout: 0 };
    return {
      won: true,
      payout: parseFloat((betAmount * cashoutMultiplier).toFixed(2)),
    };
  }
}

// ===== MINES GAME ENGINE =====
class MinesEngine {
  static generateMines(serverSeed, clientSeed, nonce, mineCount, gridSize = 25) {
    const floats = ProvablyFair.generateFloats(serverSeed, clientSeed, nonce, gridSize);
    const indices = floats.map((f, i) => ({ f, i })).sort((a, b) => a.f - b.f);
    return indices.slice(0, mineCount).map(x => x.i);
  }

  static calculateMultiplier(mineCount, revealedCount, gridSize = 25) {
    // Based on probability of avoiding mines
    let probability = 1;
    for (let i = 0; i < revealedCount; i++) {
      probability *= (gridSize - mineCount - i) / (gridSize - i);
    }
    const multiplier = (0.99 / probability);
    return parseFloat(multiplier.toFixed(4));
  }

  static calculateNextMultiplier(mineCount, revealedCount, gridSize = 25) {
    return this.calculateMultiplier(mineCount, revealedCount + 1, gridSize);
  }
}

// ===== PLINKO GAME ENGINE =====
class PlinkoEngine {
  static MULTIPLIERS = {
    low: [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
  };

  static drop(serverSeed, clientSeed, nonce, rows = 8, risk = 'medium') {
    const floats = ProvablyFair.generateFloats(serverSeed, clientSeed, nonce, rows);
    const path = floats.map(f => f < 0.5 ? 0 : 1); // 0=left, 1=right
    const bucketIndex = path.reduce((sum, dir) => sum + dir, 0);
    
    const multipliers = this.MULTIPLIERS[risk] || this.MULTIPLIERS.medium;
    const multiplier = multipliers[bucketIndex] || 1;
    
    return { path, bucketIndex, multiplier };
  }
}

module.exports = { ProvablyFair, DiceEngine, CrashEngine, MinesEngine, PlinkoEngine };

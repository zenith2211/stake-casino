/**
 * Payment management module migration.
 *
 * This project uses Mongoose, so indexes are normally created by the models.
 * Run this script in production deployment if autoIndex is disabled:
 *
 *   node backend/migrations/20260602_payment_management_module.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI or MONGO_URI is required');
  await mongoose.connect(uri, { dbName: 'stake-casino' });

  require('../src/models/PaymentAccount');
  require('../src/models/DepositRequest');
  require('../src/models/PaymentAlert');
  require('../src/models/AuditLog');
  require('../src/models/Transaction');

  await Promise.all(Object.values(mongoose.models).map(model => model.syncIndexes()));
  await mongoose.disconnect();
  console.log('Payment management indexes synchronized');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

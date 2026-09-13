# Manual Payment Management Architecture

## Scope

This module uses a completely manual deposit verification process. There is no payment gateway integration. Users pay externally to admin-managed UPI IDs or crypto wallet addresses, then submit a deposit request for admin review.

## User Access Control

- Users can register, sign in, and browse normally.
- New users start with a balance of `₹0`.
- Game and sports wager routes are blocked until the user's approved deposit total is at least `₹300`.
- The blocked response is:

```json
{ "error": "A minimum deposit of ₹300 is required to play games." }
```

## Database Schema

### User

- `balance`: current playable INR balance, default `0`.
- `role`: `user` or `admin`.
- `isBanned`: prevents login/access when true.

### PaymentAccount

Admin-managed payment targets:

- `method`: `upi` or `crypto`.
- `provider`: `manual_upi`, `manual_crypto`, or `other`.
- `label`, `description`, `enabled`.
- `upiId`: required for UPI accounts.
- `crypto.coin`: `BTC`, `ETH`, `BNB`, `USDT`, or `OTHER`.
- `crypto.network`: network label such as `TRC20`, `ERC20`, or `BEP20`.
- `crypto.walletAddress`: wallet address shown to users.
- `limits`: min/max deposit, daily amount limit, daily count limit.
- `assignmentRules`: priority/currency/business filters.
- `lastAssignedAt`, `assignmentCount`: used for rotation and operational tracking.

### DepositRequest

Manual deposit request:

- `userId`, `accountId`, `transactionId`.
- `amount`, `currency: INR`.
- `method`: `upi` or `crypto`.
- `coin`: crypto coin when applicable.
- `status`: `pending`, `approved`, or `rejected`.
- `reference`: internal deposit reference.
- `userPaymentReference`: optional UTR/transaction hash submitted by user.
- `assignedPaymentTarget`: exact UPI ID or wallet assigned to this request.
- `adminNote`.
- `history`: status timeline.

### Transaction

Ledger entry tied to the deposit request:

- Created as `pending` when the user clicks `Complete Payment`.
- Updated to `completed` only when admin approves.
- Updated to `failed` when admin rejects.

## User API

- `GET /api/payment/methods`: list enabled UPI IDs and crypto wallets.
- `POST /api/payment/deposits`: create a pending manual deposit request.
- `GET /api/payment/deposits`: current user's deposit history.
- `GET /api/payment/history`: current balance, approved deposit total, can-play flag, transactions, deposits.
- `GET /api/payment/config`: min deposit, supported methods/coins, access-control message.

## Admin API

- `GET /api/admin/payment/accounts`
- `POST /api/admin/payment/accounts`
- `PUT /api/admin/payment/accounts/:id`
- `DELETE /api/admin/payment/accounts/:id`
- `POST /api/admin/payment/accounts/:id/enable`
- `POST /api/admin/payment/accounts/:id/disable`
- `GET /api/admin/payment/deposits`
- `POST /api/admin/payment/deposits/:id/status` with `{ "status": "approved" | "rejected", "note": "..." }`
- `GET /api/admin/payment/dashboard`
- `GET /api/admin/payment/reports`
- `GET /api/admin/payment/alerts`
- `POST /api/admin/payment/alerts/:id/acknowledge`
- `GET /api/admin/payment/audit-logs`

## Deposit Flow

1. User selects UPI or crypto in the cashier.
2. The cashier displays an enabled admin-managed UPI ID or wallet address.
3. User pays externally.
4. User clicks `Complete Payment`.
5. User submits deposit amount and optional UTR/transaction hash.
6. `DepositRequest.status` becomes `pending`.
7. User sees: `Please wait 5–10 minutes while your payment is being verified.`
8. Admin reviews the pending request.
9. Admin approves or rejects.
10. Approved deposits credit user balance. Rejected deposits do not affect balance.

## Wallet Logic

- Minimum deposit is `₹300`.
- Balance is credited only after admin approval.
- Rejected deposits never credit balance.
- A pending deposit creates a pending transaction only.
- User game access unlocks when approved deposit total reaches `₹300`.

## Admin Dashboard Structure

- Payment dashboard metrics: total approved deposits, approval rate, pending count, rejected count.
- UPI management: add/edit/remove/enable/disable UPI IDs.
- Crypto wallet management: add/edit/remove/enable/disable wallet addresses for BTC, ETH, BNB, USDT, and other coins.
- Pending deposits table: user info, method, amount, assigned target, optional user reference, status, approve/reject actions.
- Audit logs: admin account changes, approvals, rejections, alerts, and balance actions.

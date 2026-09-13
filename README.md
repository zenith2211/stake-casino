# Stake Casino v7 — Full Stack

## 📁 Project Structure

```
stake-full/
├── frontend/
│   ├── index.html          ← Main site (lobby, sports, wallet)
│   ├── cashier.html        ← Deposit / Withdraw page
│   └── games/              ← ✅ ALL GAMES (each in its own file)
│       ├── games.html      ← Games hub / lobby
│       ├── dice.html       ← 🎲 Dice
│       ├── crash.html      ← 🚀 Crash
│       ├── mines.html      ← 💣 Mines
│       ├── plinko.html     ← 🔵 Plinko
│       ├── wheel.html      ← 🎡 Wheel
│       ├── limbo.html      ← ⬆️  Limbo
│       ├── hilo.html       ← 🃏 Hi-Lo
│       ├── keno.html       ← 🔢 Keno
│       ├── roulette.html   ← 🎰 Roulette
│       ├── blackjack.html  ← ♠️  Blackjack
│       ├── baccarat.html   ← 🀄 Baccarat
│       └── slots.html      ← 🎰 Slots
├── backend/
│   ├── src/
│   │   ├── server.js
│   │   ├── config/db.js
│   │   ├── routes/
│   │   │   ├── auth.js
│   │   │   ├── game.js
│   │   │   ├── payment.js
│   │   │   ├── sports.js
│   │   │   ├── user.js
│   │   │   ├── wallet.js
│   │   │   └── admin.js
│   │   ├── games/gameEngine.js
│   │   ├── middleware/auth.js
│   │   └── websocket/wsServer.js
│   ├── package.json
│   ├── .env
│   └── Dockerfile
└── docker-compose.yml
```

---

## 🚀 How to Run

### Option 1 — Frontend Only (No Backend, Instant)

Just open the HTML files directly in your browser — no server needed.

1. Open the `frontend/` folder
2. Double-click `index.html` OR open it in your browser:
   - Windows: Right-click → "Open with" → Chrome/Edge/Firefox
   - Mac: Double-click in Finder
   - Or drag the file into your browser

> All games work fully offline using `localStorage` for balance. No backend required for gameplay.

---

### Option 2 — Full Stack with Node.js Backend

**Requirements:** Node.js 18+, MongoDB

#### Step 1 — Install backend dependencies
```bash
cd stake-full/backend
npm install
```

#### Step 2 — Configure environment
Edit `backend/.env`:
```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/stake
JWT_SECRET=your_secret_key_here
```

#### Step 3 — Start backend
```bash
npm start
# or for development with auto-reload:
npm run dev
```

#### Step 4 — Serve frontend
Option A — Use VS Code Live Server (easiest):
- Install "Live Server" extension in VS Code
- Right-click `index.html` → "Open with Live Server"

Option B — Use a simple HTTP server:
```bash
# Python (built-in, no install needed)
cd stake-full/frontend
python3 -m http.server 3000
# Then open: http://localhost:3000

# OR Node.js
npx serve stake-full/frontend -p 3000
```

Option C — Use the included backend as static server:
The Express backend already serves the frontend folder at http://localhost:5000

---

### Option 3 — Docker (Full Stack)

```bash
cd stake-full
docker-compose up --build
```

Then open: **http://localhost:3000**

---

## 🎮 Editing a Specific Game

Each game is its own standalone HTML file in `frontend/games/`:

| File | Game | What to Edit |
|------|------|-------------|
| `dice.html` | 🎲 Dice | Slider, odds, provably fair |
| `crash.html` | 🚀 Crash | Graph, crash point formula |
| `mines.html` | 💣 Mines | Grid size, mine payout math |
| `plinko.html` | 🔵 Plinko | Multiplier tables, physics |
| `wheel.html` | 🎡 Wheel | Segment configs, risk levels |
| `limbo.html` | ⬆️ Limbo | Target input, RTP graph |
| `hilo.html` | 🃏 Hi-Lo | Card odds, streak cashout |
| `keno.html` | 🔢 Keno | Payout tables, draw animation |
| `roulette.html` | 🎰 Roulette | Betting table, wheel layout |
| `blackjack.html` | ♠️ Blackjack | Rules, deck count, payouts |
| `baccarat.html` | 🀄 Baccarat | Third-card rules, commission |
| `slots.html` | 🎰 Slots | Symbols, weights, jackpot |

Each file is **self-contained** — edit one without affecting any other.

---

## 💡 Tips

- Balance is shared across all pages via `localStorage`
- To reset balance: open browser console → `localStorage.setItem('balance','1000')`
- To connect a game to your backend API, search for `apiFetch` in the game file and update the endpoint
- House edge and RTP are configurable per-game in the JavaScript logic section of each file

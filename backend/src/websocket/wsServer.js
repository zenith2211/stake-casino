const { WebSocketServer, WebSocket } = require('ws');

let wss = null;
const clients = new Set();

// Crash game state
let crashState = {
  phase: 'waiting', // waiting, running, crashed
  multiplier: 1.00,
  crashPoint: null,
  startTime: null,
  bets: [],
};

let crashInterval = null;
let waitingTimeout = null;

function initWebSocket(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    console.log(`WS Client connected. Total: ${clients.size}`);

    // Send current crash state on connect
    ws.send(JSON.stringify({ type: 'crash_state', data: crashState }));

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        handleClientMessage(ws, data);
      } catch (e) {
        // ignore invalid messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  // Start crash game loop
  startCrashLoop();

  console.log('WebSocket server initialized');
  return wss;
}

function handleClientMessage(ws, data) {
  switch (data.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    case 'subscribe_crash':
      ws.send(JSON.stringify({ type: 'crash_state', data: crashState }));
      break;
  }
}

function broadcast(message) {
  const json = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

function broadcastNewBet(bet) {
  broadcast({ type: 'new_bet', data: bet });
}

// ===== CRASH GAME LOOP =====
function startCrashLoop() {
  startWaiting();
}

function startWaiting() {
  crashState = {
    phase: 'waiting',
    multiplier: 1.00,
    crashPoint: null,
    startTime: null,
    bets: [],
    countdown: 5,
  };

  broadcast({ type: 'crash_waiting', data: { countdown: 5 } });

  let countdown = 5;
  const countdownInterval = setInterval(() => {
    countdown--;
    broadcast({ type: 'crash_countdown', data: { countdown } });
    if (countdown <= 0) {
      clearInterval(countdownInterval);
      startCrashRound();
    }
  }, 1000);
}

function startCrashRound() {
  // Generate crash point (1.00 to 100x with house edge)
  const rand = Math.random();
  let crashPoint;
  if (rand < 0.01) {
    crashPoint = 1.00; // 1% instant crash
  } else {
    crashPoint = Math.max(1.00, parseFloat((99 / (1 - rand)).toFixed(2)));
    crashPoint = Math.min(crashPoint, 1000); // cap at 1000x
  }

  crashState = {
    phase: 'running',
    multiplier: 1.00,
    crashPoint,
    startTime: Date.now(),
    bets: crashState.bets,
  };

  broadcast({ type: 'crash_start', data: { startTime: crashState.startTime } });

  crashInterval = setInterval(() => {
    const elapsed = (Date.now() - crashState.startTime) / 1000;
    // Exponential growth: multiplier = e^(0.00006 * elapsed_ms)
    const newMultiplier = parseFloat(Math.pow(Math.E, 0.00006 * (Date.now() - crashState.startTime)).toFixed(2));
    crashState.multiplier = newMultiplier;

    broadcast({ type: 'crash_tick', data: { multiplier: newMultiplier } });

    if (newMultiplier >= crashPoint) {
      clearInterval(crashInterval);
      endCrash(crashPoint);
    }
  }, 100);
}

function endCrash(crashPoint) {
  crashState.phase = 'crashed';
  broadcast({ type: 'crash_end', data: { crashPoint } });

  // Wait before next round
  setTimeout(() => {
    startWaiting();
  }, 3000);
}

module.exports = { initWebSocket, broadcastNewBet, broadcast };

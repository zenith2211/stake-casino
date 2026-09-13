/**
 * Sports Routes  —  /api/sports
 * Acts as a proxy to The Odds API v4.
 * The frontend cannot call The Odds API directly (CORS + IP restrictions).
 * All requests go through here. We cache for 10 min to save credits.
 *
 * To unlock live odds:
 *   Go to https://the-odds-api.com/account → your API subscription
 *   → remove IP/host restrictions (or add your server IP)
 *   ODDS_API_KEY is already set in .env
 */

const express = require('express');
const { authenticate } = require('../middleware/auth');
const db = require('../config/db');
const paymentManagement = require('../services/paymentManagement');

const router = express.Router();

async function requireMinimumDeposit(req, res, next) {
  try {
    if (req.user.role === 'admin') return next();
    const approvedTotal = await paymentManagement.approvedDepositTotal(req.user.id);
    if (approvedTotal < paymentManagement.MIN_DEPOSIT_INR) {
      return res.status(403).json({ error: 'A minimum deposit of ₹300 is required to play games.' });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

const ODDS_API_KEY  = process.env.ODDS_API_KEY || '10497d7384606ceb2041d935fc22f3dd';
const ODDS_API_HOST = 'https://api.the-odds-api.com/v4';

const cache   = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const SPORT_REGIONS = {
  cricket_ipl:               'uk',
  soccer_epl:                'uk',
  soccer_uefa_champs_league: 'uk,eu',
  soccer_spain_la_liga:      'uk,eu',
  soccer_germany_bundesliga: 'uk,eu',
  soccer_italy_serie_a:      'uk,eu',
  soccer_france_ligue_1:     'uk,eu',
  basketball_nba:            'us',
  americanfootball_nfl:      'us',
  icehockey_nhl:             'us',
  baseball_mlb:              'us',
  mma_mixed_martial_arts:    'us,uk',
  boxing_boxing:             'uk',
  soccer_usa_mls:            'us',
  rugby_union_world_cup:     'uk',
};

async function fetchFromOddsAPI(sportKey, oddsFormat) {
  const cacheKey = `${sportKey}:${oddsFormat}`;
  const cached   = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return { data: cached.data, source: 'live', credits: cached.credits };
  }

  const regions = SPORT_REGIONS[sportKey] || 'uk,us,eu';
  const url = `${ODDS_API_HOST}/sports/${sportKey}/odds/`
    + `?apiKey=${ODDS_API_KEY}`
    + `&regions=${regions}`
    + `&markets=h2h,spreads,totals`
    + `&oddsFormat=${oddsFormat}`;

  const res = await fetch(url);
  const credits = res.headers.get('x-requests-remaining');

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odds API ${res.status}: ${body}`);
  }

  const data = await res.json();
  cache.set(cacheKey, { data, ts: Date.now(), credits });
  return { data, source: 'live', credits };
}

// Rich mock data — structured identically to real Odds API v4 response
function ft(h) { return new Date(Date.now() + h * 3600000).toISOString(); }
function pt(h) { return new Date(Date.now() - h * 3600000).toISOString(); }

const MOCK = {
  cricket_ipl: [
    { id:'ipl-1', sport_key:'cricket_ipl', home_team:'Mumbai Indians', away_team:'Chennai Super Kings', commence_time:ft(1),
      bookmakers:[{key:'betway',title:'Betway',markets:[{key:'h2h',outcomes:[{name:'Mumbai Indians',price:2.10},{name:'Chennai Super Kings',price:1.75}]}]}]},
    { id:'ipl-2', sport_key:'cricket_ipl', home_team:'Sunrisers Hyderabad', away_team:'Rajasthan Royals', commence_time:ft(25),
      bookmakers:[{key:'betway',title:'Betway',markets:[{key:'h2h',outcomes:[{name:'Sunrisers Hyderabad',price:1.90},{name:'Rajasthan Royals',price:1.95}]}]}]},
    { id:'ipl-3', sport_key:'cricket_ipl', home_team:'Kolkata Knight Riders', away_team:'Punjab Kings', commence_time:ft(49),
      bookmakers:[{key:'betway',title:'Betway',markets:[{key:'h2h',outcomes:[{name:'Kolkata Knight Riders',price:1.80},{name:'Punjab Kings',price:2.05}]}]}]},
    { id:'ipl-4', sport_key:'cricket_ipl', home_team:'Delhi Capitals', away_team:'Lucknow Super Giants', commence_time:ft(73),
      bookmakers:[{key:'betway',title:'Betway',markets:[{key:'h2h',outcomes:[{name:'Delhi Capitals',price:2.20},{name:'Lucknow Super Giants',price:1.70}]}]}]},
    { id:'ipl-5', sport_key:'cricket_ipl', home_team:'Royal Challengers Bangalore', away_team:'Gujarat Titans', commence_time:ft(97),
      bookmakers:[{key:'betway',title:'Betway',markets:[{key:'h2h',outcomes:[{name:'Royal Challengers Bangalore',price:1.85},{name:'Gujarat Titans',price:2.05}]}]}]},
  ],
  soccer_epl: [
    { id:'epl-1', sport_key:'soccer_epl', home_team:'Arsenal', away_team:'Chelsea', commence_time:pt(1),
      bookmakers:[{key:'betfair_ex_uk',title:'Betfair Exchange',markets:[
        {key:'h2h',outcomes:[{name:'Arsenal',price:1.45},{name:'Draw',price:4.20},{name:'Chelsea',price:6.50}]},
        {key:'totals',outcomes:[{name:'Over',point:2.5,price:1.82},{name:'Under',point:2.5,price:2.00}]},
      ]}]},
    { id:'epl-2', sport_key:'soccer_epl', home_team:'Man City', away_team:'Liverpool', commence_time:pt(0.5),
      bookmakers:[{key:'betfair_ex_uk',title:'Betfair Exchange',markets:[
        {key:'h2h',outcomes:[{name:'Man City',price:2.10},{name:'Draw',price:3.40},{name:'Liverpool',price:3.20}]},
        {key:'spreads',outcomes:[{name:'Man City',point:-0.5,price:2.05},{name:'Liverpool',point:0.5,price:1.85}]},
      ]}]},
    { id:'epl-3', sport_key:'soccer_epl', home_team:'Tottenham', away_team:'Man United', commence_time:ft(3),
      bookmakers:[{key:'betfair_ex_uk',title:'Betfair Exchange',markets:[
        {key:'h2h',outcomes:[{name:'Tottenham',price:2.40},{name:'Draw',price:3.30},{name:'Man United',price:2.90}]},
      ]}]},
    { id:'epl-4', sport_key:'soccer_epl', home_team:'Newcastle', away_team:'Everton', commence_time:ft(3.5),
      bookmakers:[{key:'betfair_ex_uk',title:'Betfair Exchange',markets:[
        {key:'h2h',outcomes:[{name:'Newcastle',price:1.80},{name:'Draw',price:3.60},{name:'Everton',price:4.20}]},
      ]}]},
  ],
  soccer_uefa_champs_league: [
    { id:'ucl-1', sport_key:'soccer_uefa_champs_league', home_team:'Bayern Munich', away_team:'PSG', commence_time:pt(0.8),
      bookmakers:[{key:'betfair_ex_uk',title:'Betfair Exchange',markets:[
        {key:'h2h',outcomes:[{name:'Bayern Munich',price:2.60},{name:'Draw',price:3.20},{name:'PSG',price:2.75}]},
      ]}]},
    { id:'ucl-2', sport_key:'soccer_uefa_champs_league', home_team:'Real Madrid', away_team:'Man City', commence_time:ft(5),
      bookmakers:[{key:'betfair_ex_uk',title:'Betfair Exchange',markets:[
        {key:'h2h',outcomes:[{name:'Real Madrid',price:2.10},{name:'Draw',price:3.40},{name:'Man City',price:3.20}]},
      ]}]},
  ],
  soccer_spain_la_liga: [
    { id:'lla-1', sport_key:'soccer_spain_la_liga', home_team:'Real Madrid', away_team:'Atletico Madrid', commence_time:pt(1.2),
      bookmakers:[{key:'betfair_ex_uk',title:'Betfair Exchange',markets:[
        {key:'h2h',outcomes:[{name:'Real Madrid',price:1.35},{name:'Draw',price:5.00},{name:'Atletico Madrid',price:8.50}]},
      ]}]},
    { id:'lla-2', sport_key:'soccer_spain_la_liga', home_team:'Barcelona', away_team:'Villarreal', commence_time:ft(2),
      bookmakers:[{key:'betfair_ex_uk',title:'Betfair Exchange',markets:[
        {key:'h2h',outcomes:[{name:'Barcelona',price:1.55},{name:'Draw',price:3.80},{name:'Villarreal',price:5.50}]},
      ]}]},
  ],
  soccer_germany_bundesliga: [
    { id:'bun-1', sport_key:'soccer_germany_bundesliga', home_team:'Bayern Munich', away_team:'Borussia Dortmund', commence_time:ft(4),
      bookmakers:[{key:'betfair_ex_uk',title:'Betfair Exchange',markets:[
        {key:'h2h',outcomes:[{name:'Bayern Munich',price:1.55},{name:'Draw',price:4.00},{name:'Borussia Dortmund',price:5.50}]},
      ]}]},
  ],
  soccer_italy_serie_a: [
    { id:'ser-1', sport_key:'soccer_italy_serie_a', home_team:'Inter Milan', away_team:'Juventus', commence_time:ft(3),
      bookmakers:[{key:'betfair_ex_uk',title:'Betfair Exchange',markets:[
        {key:'h2h',outcomes:[{name:'Inter Milan',price:1.90},{name:'Draw',price:3.50},{name:'Juventus',price:4.00}]},
      ]}]},
    { id:'ser-2', sport_key:'soccer_italy_serie_a', home_team:'AC Milan', away_team:'Napoli', commence_time:ft(5),
      bookmakers:[{key:'betfair_ex_uk',title:'Betfair Exchange',markets:[
        {key:'h2h',outcomes:[{name:'AC Milan',price:2.20},{name:'Draw',price:3.20},{name:'Napoli',price:3.30}]},
      ]}]},
  ],
  basketball_nba: [
    { id:'nba-1', sport_key:'basketball_nba', home_team:'Los Angeles Lakers', away_team:'Boston Celtics', commence_time:pt(0.5),
      bookmakers:[{key:'draftkings',title:'DraftKings',markets:[
        {key:'h2h',outcomes:[{name:'Los Angeles Lakers',price:2.80},{name:'Boston Celtics',price:1.45}]},
        {key:'spreads',outcomes:[{name:'Los Angeles Lakers',point:-3.5,price:1.91},{name:'Boston Celtics',point:3.5,price:1.91}]},
        {key:'totals',outcomes:[{name:'Over',point:220.5,price:1.90},{name:'Under',point:220.5,price:1.92}]},
      ]}]},
    { id:'nba-2', sport_key:'basketball_nba', home_team:'Golden State Warriors', away_team:'Milwaukee Bucks', commence_time:pt(0.2),
      bookmakers:[{key:'draftkings',title:'DraftKings',markets:[
        {key:'h2h',outcomes:[{name:'Golden State Warriors',price:1.90},{name:'Milwaukee Bucks',price:1.90}]},
        {key:'totals',outcomes:[{name:'Over',point:225.5,price:1.88},{name:'Under',point:225.5,price:1.95}]},
      ]}]},
    { id:'nba-3', sport_key:'basketball_nba', home_team:'New York Knicks', away_team:'Miami Heat', commence_time:ft(3),
      bookmakers:[{key:'draftkings',title:'DraftKings',markets:[
        {key:'h2h',outcomes:[{name:'New York Knicks',price:2.10},{name:'Miami Heat',price:1.72}]},
      ]}]},
  ],
  americanfootball_nfl: [
    { id:'nfl-1', sport_key:'americanfootball_nfl', home_team:'Kansas City Chiefs', away_team:'Philadelphia Eagles', commence_time:ft(48),
      bookmakers:[{key:'draftkings',title:'DraftKings',markets:[
        {key:'h2h',outcomes:[{name:'Kansas City Chiefs',price:1.70},{name:'Philadelphia Eagles',price:2.15}]},
        {key:'spreads',outcomes:[{name:'Kansas City Chiefs',point:-2.5,price:1.91},{name:'Philadelphia Eagles',point:2.5,price:1.91}]},
        {key:'totals',outcomes:[{name:'Over',point:47.5,price:1.91},{name:'Under',point:47.5,price:1.91}]},
      ]}]},
  ],
  icehockey_nhl: [
    { id:'nhl-1', sport_key:'icehockey_nhl', home_team:'Toronto Maple Leafs', away_team:'Boston Bruins', commence_time:pt(0.5),
      bookmakers:[{key:'draftkings',title:'DraftKings',markets:[
        {key:'h2h',outcomes:[{name:'Toronto Maple Leafs',price:2.10},{name:'Boston Bruins',price:1.75}]},
        {key:'totals',outcomes:[{name:'Over',point:5.5,price:1.88},{name:'Under',point:5.5,price:1.95}]},
      ]}]},
    { id:'nhl-2', sport_key:'icehockey_nhl', home_team:'New York Rangers', away_team:'Pittsburgh Penguins', commence_time:ft(4),
      bookmakers:[{key:'draftkings',title:'DraftKings',markets:[
        {key:'h2h',outcomes:[{name:'New York Rangers',price:1.90},{name:'Pittsburgh Penguins',price:1.92}]},
      ]}]},
  ],
  baseball_mlb: [
    { id:'mlb-1', sport_key:'baseball_mlb', home_team:'New York Yankees', away_team:'Boston Red Sox', commence_time:pt(0.7),
      bookmakers:[{key:'draftkings',title:'DraftKings',markets:[
        {key:'h2h',outcomes:[{name:'New York Yankees',price:1.75},{name:'Boston Red Sox',price:2.10}]},
        {key:'spreads',outcomes:[{name:'New York Yankees',point:-1.5,price:2.10},{name:'Boston Red Sox',point:1.5,price:1.75}]},
        {key:'totals',outcomes:[{name:'Over',point:8.5,price:1.90},{name:'Under',point:8.5,price:1.92}]},
      ]}]},
    { id:'mlb-2', sport_key:'baseball_mlb', home_team:'Los Angeles Dodgers', away_team:'Chicago Cubs', commence_time:ft(5),
      bookmakers:[{key:'draftkings',title:'DraftKings',markets:[
        {key:'h2h',outcomes:[{name:'Los Angeles Dodgers',price:1.55},{name:'Chicago Cubs',price:2.55}]},
      ]}]},
  ],
  mma_mixed_martial_arts: [
    { id:'mma-1', sport_key:'mma_mixed_martial_arts', home_team:'Islam Makhachev', away_team:'Dustin Poirier', commence_time:ft(72),
      bookmakers:[{key:'draftkings',title:'DraftKings',markets:[
        {key:'h2h',outcomes:[{name:'Islam Makhachev',price:1.30},{name:'Dustin Poirier',price:3.40}]},
      ]}]},
    { id:'mma-2', sport_key:'mma_mixed_martial_arts', home_team:'Jon Jones', away_team:'Stipe Miocic', commence_time:ft(168),
      bookmakers:[{key:'draftkings',title:'DraftKings',markets:[
        {key:'h2h',outcomes:[{name:'Jon Jones',price:1.45},{name:'Stipe Miocic',price:2.75}]},
      ]}]},
  ],
  boxing_boxing: [
    { id:'box-1', sport_key:'boxing_boxing', home_team:'Canelo Alvarez', away_team:'David Benavidez', commence_time:ft(120),
      bookmakers:[{key:'betway',title:'Betway',markets:[
        {key:'h2h',outcomes:[{name:'Canelo Alvarez',price:1.65},{name:'David Benavidez',price:2.30}]},
      ]}]},
  ],
  soccer_usa_mls: [
    { id:'mls-1', sport_key:'soccer_usa_mls', home_team:'Inter Miami CF', away_team:'LA Galaxy', commence_time:ft(6),
      bookmakers:[{key:'draftkings',title:'DraftKings',markets:[
        {key:'h2h',outcomes:[{name:'Inter Miami CF',price:1.75},{name:'Draw',price:3.50},{name:'LA Galaxy',price:4.20}]},
      ]}]},
    { id:'mls-2', sport_key:'soccer_usa_mls', home_team:'Seattle Sounders', away_team:'Portland Timbers', commence_time:ft(8),
      bookmakers:[{key:'draftkings',title:'DraftKings',markets:[
        {key:'h2h',outcomes:[{name:'Seattle Sounders',price:2.10},{name:'Draw',price:3.30},{name:'Portland Timbers',price:3.40}]},
      ]}]},
  ],
};

// Short ID → full Odds API sport key aliases
const SPORT_ALIASES = {
  // Short nav IDs used by sidebar
  ucl:        'soccer_uefa_champs_league',
  epl:        'soccer_epl',
  laliga:     'soccer_spain_la_liga',
  bundesliga: 'soccer_germany_bundesliga',
  seriea:     'soccer_italy_serie_a',
  ligue1:     'soccer_france_ligue_1',
  nba:        'basketball_nba',
  nfl:        'americanfootball_nfl',
  nhl:        'icehockey_nhl',
  mlb:        'baseball_mlb',
  mls:        'soccer_usa_mls',
  ipl:        'cricket_ipl',
  mma:        'mma_mixed_martial_arts',
  boxing:     'boxing_boxing',
  rugby:      'rugby_union_world_cup',
  // Tennis — use correct current tournament key
  tennis_us:  'tennis_wta_us_open',       // changed from tennis_atp_us_open (off season)
  tennis_wim: 'tennis_wta_wimbledon',     // changed from tennis_atp_wimbledon
  // Fix wrong keys that returned 404
  soccer_uefa_champs_league: 'soccer_uefa_champs_league',
  icehockey_nhl:             'icehockey_nhl',
  mma_mixed_martial_arts:    'mma_mixed_martial_arts',
  boxing_boxing:             'boxing_boxing',
  cricket_ipl:               'cricket_ipl',
};

// GET /api/sports/live/:sport
router.get('/live/:sport', async (req, res) => {
  const rawKey   = req.params.sport;
  const sportKey = SPORT_ALIASES[rawKey] || rawKey;
  const fmt      = req.query.oddsFormat || 'decimal';
  try {
    const { data, source, credits } = await fetchFromOddsAPI(sportKey, fmt);
    return res.json({ events: data, source, sport: sportKey, creditsRemaining: credits ? parseInt(credits) : undefined });
  } catch(e) {
    console.warn(`Odds API failed (${sportKey}): ${e.message}`);
    console.warn('Fix: remove IP restrictions at https://the-odds-api.com/account');
    return res.json({ events: MOCK[sportKey] || [], source: 'mock', sport: sportKey });
  }
});

// GET /api/sports/live
router.get('/live', async (req, res) => {
  const rawKey   = req.query.sport || 'cricket_ipl';
  const sportKey = SPORT_ALIASES[rawKey] || rawKey;
  const fmt      = req.query.oddsFormat || 'decimal';
  try {
    const { data, source, credits } = await fetchFromOddsAPI(sportKey, fmt);
    return res.json({ events: data, source, sport: sportKey, creditsRemaining: credits ? parseInt(credits) : undefined });
  } catch(e) {
    return res.json({ events: MOCK[sportKey] || [], source: 'mock', sport: sportKey });
  }
});

router.get('/sports', async (req, res) => {
  try {
    const r = await fetch(`${ODDS_API_HOST}/sports/?apiKey=${ODDS_API_KEY}`);
    const d = await r.json();
    res.json({ sports: d, source: 'live' });
  } catch(e) {
    res.json({ sports: Object.keys(SPORT_REGIONS).map(k => ({ key: k })), source: 'mock' });
  }
});

router.get('/upcoming', (req, res) => {
  const events = Object.values(MOCK).flat()
    .filter(e => new Date(e.commence_time) > new Date())
    .sort((a,b) => new Date(a.commence_time) - new Date(b.commence_time))
    .slice(0, 20);
  res.json({ events });
});

const SportsBet = require('../models/SportsBet');

// Resolve a selection's sportKey from the live/cached odds data if the client
// didn't send it, so the settlement job knows which /scores feed to poll.
function resolveSportKey(sel) {
  const explicit = SPORT_ALIASES[sel.sportKey] || sel.sportKey;
  if (explicit) return explicit;
  // Search the odds cache and mock data for this matchId
  for (const [, entry] of cache) {
    const found = (entry.data || []).find(e => e.id === sel.matchId);
    if (found?.sport_key) return found.sport_key;
  }
  for (const [key, events] of Object.entries(MOCK)) {
    if (events.some(e => e.id === sel.matchId)) return key;
  }
  return '';
}

function resolveCommenceTime(sel) {
  if (sel.commenceTime) return new Date(sel.commenceTime);
  for (const [, entry] of cache) {
    const found = (entry.data || []).find(e => e.id === sel.matchId);
    if (found?.commence_time) return new Date(found.commence_time);
  }
  for (const events of Object.values(MOCK)) {
    const found = events.find(e => e.id === sel.matchId);
    if (found?.commence_time) return new Date(found.commence_time);
  }
  return null;
}

router.post('/bet', authenticate, requireMinimumDeposit, async (req, res) => {
  try {
    const { selections, stake, betType } = req.body;
    if (!Array.isArray(selections) || !selections.length) return res.status(400).json({ error: 'No selections' });
    const stakeNum = parseFloat(stake);
    if (!stakeNum || stakeNum <= 0) return res.status(400).json({ error: 'Invalid stake' });

    const user = await db.findUserById(req.user.id);
    if (stakeNum > user.balance) return res.status(400).json({ error: 'Insufficient balance' });

    // Build validated selections with sport/commence info for later settlement
    const enriched = selections.map(s => ({
      matchId: s.matchId,
      sportKey: resolveSportKey(s),
      match: s.match || s.matchName || '',
      selection: s.selection,
      odd: parseFloat(s.odd) || 1,
      commenceTime: resolveCommenceTime(s),
      status: 'pending',
      resultNote: '',
    }));

    if (enriched.some(s => !s.matchId || !s.selection)) {
      return res.status(400).json({ error: 'Malformed selection' });
    }
    // Block bets on matches that have already started (can't bet after kickoff)
    const now = Date.now();
    if (enriched.some(s => s.commenceTime && new Date(s.commenceTime).getTime() <= now)) {
      return res.status(400).json({ error: 'One or more matches have already started' });
    }

    const totalOdds = enriched.reduce((a, s) => a * s.odd, 1);
    const potential = parseFloat((stakeNum * totalOdds).toFixed(2));

    // Deduct stake immediately; bet sits pending until matches finish.
    await db.updateUser(req.user.id, { balance: parseFloat((user.balance - stakeNum).toFixed(2)) });

    const bet = await SportsBet.create({
      userId: req.user.id,
      username: req.user.username,
      betType: betType || (enriched.length > 1 ? 'multi' : 'singles'),
      stake: stakeNum,
      totalOdds: parseFloat(totalOdds.toFixed(4)),
      potentialPayout: potential,
      selections: enriched,
      status: 'pending',
    });

    const updated = await db.findUserById(req.user.id);
    res.status(201).json({
      status: 'pending',
      betId: bet._id,
      totalOdds: parseFloat(totalOdds.toFixed(4)),
      stake: stakeNum,
      potentialPayout: potential,
      balance: updated.balance,
      message: 'Bet placed. It will be settled automatically when the match finishes.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bet placement failed' });
  }
});

// Current user's sports bets, newest first, with live status
router.get('/bets', authenticate, async (req, res) => {
  const bets = await SportsBet.find({ userId: req.user.id })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json({ bets });
});

module.exports = router;

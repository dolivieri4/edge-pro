const express = require('express');
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bets (
        id SERIAL PRIMARY KEY,
        sport TEXT NOT NULL,
        game TEXT NOT NULL,
        bet_type TEXT NOT NULL,
        selection TEXT NOT NULL,
        odds TEXT NOT NULL,
        stake NUMERIC(10,2),
        result TEXT DEFAULT 'pending',
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Database initialized');
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}

initDB();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

const SPORT_KEYS = {
  mlb: 'baseball_mlb',
  nba: 'basketball_nba',
  nhl: 'icehockey_nhl',
  nfl: 'americanfootball_nfl'
};

// ── CACHE ──
const cache = {};
function setCache(key, data, ttlMs = 5 * 60 * 1000) {
  cache[key] = { data, expires: Date.now() + ttlMs };
}
function getCache(key) {
  const entry = cache[key];
  if (!entry || Date.now() > entry.expires) return null;
  return entry.data;
}

// ── HELPERS ──
const MAX_NEGATIVE_ODDS = -200; // Never show picks worse than this

function toDecimal(p) {
  const n = parseFloat(String(p).replace('+', ''));
  return n > 0 ? (n / 100) + 1 : (100 / Math.abs(n)) + 1;
}
function impliedProb(p) { return 1 / toDecimal(p); }
function fmtOdds(p) { return p > 0 ? `+${p}` : `${p}`; }
function oddsPassesFilter(price) {
  const n = parseFloat(price);
  // Always allow positive odds and negatives better than cutoff
  return n > 0 || n >= MAX_NEGATIVE_ODDS;
}

// ── MARKET EDGE ──
function calcMarketEdge(teamName, bookmakers, marketKey) {
  const prices = [];
  bookmakers.forEach(bm => {
    const market = bm.markets?.find(m => m.key === marketKey);
    if (!market) return;
    const outcome = market.outcomes.find(o => o.name === teamName);
    if (outcome) prices.push(outcome.price);
  });
  if (prices.length < 2) return { edge: 0, bestOdds: prices[0] || null, avgProb: 0.5 };
  const probs = prices.map(p => impliedProb(p));
  const avgProb = probs.reduce((a, b) => a + b, 0) / probs.length;
  const bestPrice = Math.max(...prices);
  const bestProb = impliedProb(bestPrice);
  const edge = ((avgProb - bestProb) / avgProb) * 100;
  return { edge, bestOdds: bestPrice, avgProb };
}

// ── FETCH RAW ODDS ──
async function fetchOddsRaw(sport) {
  const cacheKey = `odds_raw_${sport}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const sportKey = SPORT_KEYS[sport];
  const url = `${ODDS_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso`;
  const res = await fetch(url);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  setCache(cacheKey, data, 5 * 60 * 1000);
  return data;
}

// ── MLB STATS ──
async function getMLBStats() {
  const cached = getCache('mlb_stats');
  if (cached) return cached;
  try {
    const res = await fetch('https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2025&standingsTypes=regularSeason&hydrate=team,record,streak,division');
    const data = await res.json();
    const teamData = {};
    data.records?.forEach(division => {
      division.teamRecords?.forEach(record => {
        const name = record.team.name;
        const splits = record.records?.splitRecords || [];
        const home = splits.find(s => s.type === 'home') || {};
        const away = splits.find(s => s.type === 'road') || {};
        const last10 = splits.find(s => s.type === 'lastTen') || {};
        const homeW = home.wins || 0, homeL = home.losses || 0;
        const awayW = away.wins || 0, awayL = away.losses || 0;
        teamData[name] = {
          wins: record.wins || 0, losses: record.losses || 0,
          winPct: parseFloat(record.winningPercentage) || 0,
          homeWinPct: homeW / Math.max(1, homeW + homeL),
          awayWinPct: awayW / Math.max(1, awayW + awayL),
          last10WinPct: (last10.wins || 0) / 10,
          runDiff: record.runDifferential || 0,
          runsScored: record.runsScored || 0,
          runsAllowed: record.runsAllowed || 0,
          streak: record.streak?.streakCode || ''
        };
      });
    });
    setCache('mlb_stats', teamData, 20 * 60 * 1000);
    return teamData;
  } catch (err) { console.error('MLB stats error:', err.message); return {}; }
}

// ── NBA STATS ──
async function getNBAStats() {
  const cached = getCache('nba_stats');
  if (cached) return cached;
  try {
    const res = await fetch(
      'https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&LastNGames=0&LeagueID=00&Location=&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=2024-25&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=',
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com', 'Accept': 'application/json' } }
    );
    const data = await res.json();
    const headers = data.resultSets[0].headers;
    const rows = data.resultSets[0].rowSet;
    const teamData = {};
    rows.forEach(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = row[i]);
      teamData[obj.TEAM_NAME] = {
        wins: obj.W || 0, losses: obj.L || 0, winPct: obj.W_PCT || 0,
        offRating: obj.OFF_RATING || 0, defRating: obj.DEF_RATING || 0,
        netRating: obj.NET_RATING || 0, pace: obj.PACE || 0,
        tsPct: obj.TS_PCT || 0, tovPct: obj.TM_TOV_PCT || 0,
        piePct: obj.PIE || 0, efgPct: obj.EFG_PCT || 0
      };
    });
    setCache('nba_stats', teamData, 20 * 60 * 1000);
    return teamData;
  } catch (err) { console.error('NBA stats error:', err.message); return {}; }
}

// ── NHL STATS ──
async function getNHLStats() {
  const cached = getCache('nhl_stats');
  if (cached) return cached;
  try {
    const res = await fetch('https://api-web.nhle.com/v1/standings/now');
    const data = await res.json();
    const teamData = {};
    data.standings?.forEach(team => {
      const fullName = `${team.placeName?.default || ''} ${team.teamName?.default || ''}`.trim();
      const gp = (team.wins || 0) + (team.losses || 0) + (team.otLosses || 0);
      teamData[fullName] = {
        wins: team.wins || 0, losses: team.losses || 0, otLosses: team.otLosses || 0,
        points: team.points || 0,
        winPct: (team.wins || 0) / Math.max(1, gp),
        goalsForPerGame: (team.goalFor || 0) / Math.max(1, gp),
        goalsAgainstPerGame: (team.goalAgainst || 0) / Math.max(1, gp),
        goalDiff: team.goalDifferential || 0,
        homeWinPct: (team.homeWins || 0) / Math.max(1, (team.homeWins || 0) + (team.homeLosses || 0) + (team.homeOtLosses || 0)),
        roadWinPct: (team.roadWins || 0) / Math.max(1, (team.roadWins || 0) + (team.roadLosses || 0) + (team.roadOtLosses || 0)),
        l10Wins: team.l10Wins || 0,
        streak: team.streakCode || '',
        ppPct: team.powerPlayPct || 0,
        pkPct: team.penaltyKillPct || 0
      };
    });
    setCache('nhl_stats', teamData, 20 * 60 * 1000);
    return teamData;
  } catch (err) { console.error('NHL stats error:', err.message); return {}; }
}

// ── TEAM NAME FUZZY MATCH ──
function findTeam(name, statsMap) {
  if (!name || !statsMap) return null;
  const n = name.toLowerCase().trim();
  for (const [key, val] of Object.entries(statsMap)) {
    const k = key.toLowerCase().trim();
    if (k === n || k.includes(n) || n.includes(k)) return val;
    const kLast = k.split(' ').pop();
    const nLast = n.split(' ').pop();
    if (kLast === nLast && kLast.length > 3) return val;
  }
  return null;
}

// ── CONFIDENCE SCORING ──
function scoreMLB(myStats, oppStats, isHome) {
  if (!myStats || !oppStats) return 45;
  let s = 50;
  s += (myStats.winPct - oppStats.winPct) * 15;
  const locPct = isHome ? myStats.homeWinPct : myStats.awayWinPct;
  const oppLocPct = isHome ? oppStats.awayWinPct : oppStats.homeWinPct;
  s += (locPct - oppLocPct) * 10;
  s += (myStats.last10WinPct - oppStats.last10WinPct) * 10;
  const myGP = Math.max(1, myStats.wins + myStats.losses);
  const oppGP = Math.max(1, oppStats.wins + oppStats.losses);
  s += Math.min(8, Math.max(-8, (myStats.runDiff / myGP - oppStats.runDiff / oppGP) * 2));
  s += Math.min(5, Math.max(-5, myStats.runsScored / myGP - oppStats.runsScored / oppGP));
  s += Math.min(5, Math.max(-5, oppStats.runsAllowed / oppGP - myStats.runsAllowed / myGP));
  const streak = myStats.streak || '';
  if (streak.startsWith('W')) s += Math.min(5, parseInt(streak.slice(1)) || 0);
  if (streak.startsWith('L')) s -= Math.min(5, parseInt(streak.slice(1)) || 0);
  return Math.min(95, Math.max(20, Math.round(s)));
}

function scoreNBA(myStats, oppStats, isHome) {
  if (!myStats || !oppStats) return 45;
  let s = 50;
  s += Math.min(12, Math.max(-12, (myStats.netRating - oppStats.netRating) * 1.2));
  s += Math.min(8, Math.max(-8, (myStats.offRating - oppStats.offRating) * 0.5));
  s += Math.min(8, Math.max(-8, (oppStats.defRating - myStats.defRating) * 0.5));
  s += (myStats.winPct - oppStats.winPct) * 8;
  s += Math.min(5, Math.max(-5, (myStats.tsPct - oppStats.tsPct) * 50));
  s += Math.min(4, Math.max(-4, (oppStats.tovPct - myStats.tovPct) * 10));
  s += Math.min(5, Math.max(-5, (myStats.piePct - oppStats.piePct) * 100));
  if (isHome) s += 3;
  return Math.min(95, Math.max(20, Math.round(s)));
}

function scoreNHL(myStats, oppStats, isHome) {
  if (!myStats || !oppStats) return 45;
  let s = 50;
  s += (myStats.winPct - oppStats.winPct) * 12;
  s += Math.min(10, Math.max(-10, (myStats.goalsForPerGame - oppStats.goalsForPerGame) * 4));
  s += Math.min(10, Math.max(-10, (oppStats.goalsAgainstPerGame - myStats.goalsAgainstPerGame) * 4));
  const locPct = isHome ? myStats.homeWinPct : myStats.roadWinPct;
  const oppLocPct = isHome ? oppStats.roadWinPct : oppStats.homeWinPct;
  s += (locPct - oppLocPct) * 8;
  s += (myStats.l10Wins / 10 - oppStats.l10Wins / 10) * 8;
  s += Math.min(5, Math.max(-5, (myStats.ppPct - oppStats.ppPct) * 2));
  s += Math.min(4, Math.max(-4, (myStats.pkPct - oppStats.pkPct) * 2));
  const streak = myStats.streak || '';
  if (streak.startsWith('W')) s += Math.min(4, parseInt(streak.slice(1)) || 0);
  if (streak.startsWith('L')) s -= Math.min(4, parseInt(streak.slice(1)) || 0);
  if (isHome) s += 3;
  return Math.min(95, Math.max(20, Math.round(s)));
}

function buildFactors(sport, myStats, oppStats, isHome) {
  const f = [];
  if (!myStats || !oppStats) return f;
  if (sport === 'mlb') {
    if (Math.abs(myStats.winPct - oppStats.winPct) > 0.04) f.push({ label: 'Win %', value: `${(myStats.winPct*100).toFixed(0)}% vs ${(oppStats.winPct*100).toFixed(0)}%`, positive: myStats.winPct > oppStats.winPct });
    if (myStats.last10WinPct !== 0.5) f.push({ label: 'Last 10', value: `${Math.round(myStats.last10WinPct*10)}-${10-Math.round(myStats.last10WinPct*10)}`, positive: myStats.last10WinPct > 0.5 });
    const myGP = Math.max(1, myStats.wins + myStats.losses);
    const oppGP = Math.max(1, oppStats.wins + oppStats.losses);
    const rdDiff = myStats.runDiff/myGP - oppStats.runDiff/oppGP;
    if (Math.abs(rdDiff) > 0.3) f.push({ label: 'Run Diff/G', value: `${rdDiff > 0 ? '+' : ''}${rdDiff.toFixed(1)}`, positive: rdDiff > 0 });
    const locPct = isHome ? myStats.homeWinPct : myStats.awayWinPct;
    f.push({ label: isHome ? 'Home Record' : 'Road Record', value: `${(locPct*100).toFixed(0)}%`, positive: locPct > 0.5 });
    const streak = myStats.streak || '';
    if (streak) f.push({ label: 'Streak', value: streak, positive: streak.startsWith('W') });
  }
  if (sport === 'nba') {
    f.push({ label: 'Net Rating', value: `${myStats.netRating > 0 ? '+' : ''}${(myStats.netRating||0).toFixed(1)} vs ${oppStats.netRating > 0 ? '+' : ''}${(oppStats.netRating||0).toFixed(1)}`, positive: myStats.netRating > oppStats.netRating });
    f.push({ label: 'Off Rating', value: `${(myStats.offRating||0).toFixed(1)} vs ${(oppStats.offRating||0).toFixed(1)}`, positive: myStats.offRating > oppStats.offRating });
    f.push({ label: 'Def Rating', value: `${(myStats.defRating||0).toFixed(1)} vs ${(oppStats.defRating||0).toFixed(1)}`, positive: myStats.defRating < oppStats.defRating });
    f.push({ label: 'True Shooting', value: `${((myStats.tsPct||0)*100).toFixed(1)}% vs ${((oppStats.tsPct||0)*100).toFixed(1)}%`, positive: myStats.tsPct > oppStats.tsPct });
    if (isHome) f.push({ label: 'Home Court', value: 'Home advantage', positive: true });
  }
  if (sport === 'nhl') {
    f.push({ label: 'Goals/Game', value: `${(myStats.goalsForPerGame||0).toFixed(2)} vs ${(oppStats.goalsForPerGame||0).toFixed(2)}`, positive: myStats.goalsForPerGame > oppStats.goalsForPerGame });
    f.push({ label: 'GA/Game', value: `${(myStats.goalsAgainstPerGame||0).toFixed(2)} vs ${(oppStats.goalsAgainstPerGame||0).toFixed(2)}`, positive: myStats.goalsAgainstPerGame < oppStats.goalsAgainstPerGame });
    f.push({ label: 'Power Play %', value: `${(myStats.ppPct||0).toFixed(1)}% vs ${(oppStats.ppPct||0).toFixed(1)}%`, positive: myStats.ppPct > oppStats.ppPct });
    f.push({ label: 'Last 10', value: `${myStats.l10Wins}-${10-myStats.l10Wins}`, positive: myStats.l10Wins > 5 });
    if (isHome) f.push({ label: 'Home Ice', value: `${(myStats.homeWinPct*100).toFixed(0)}% at home`, positive: myStats.homeWinPct > 0.5 });
  }
  return f.slice(0, 5);
}

// ── BUILD PICKS ──
async function buildPicks(sport) {
  const cached = getCache(`picks_${sport}`);
  if (cached) return cached;

  const games = await fetchOddsRaw(sport);
  if (!games.length) return [];

  let statsMap = {};
  if (sport === 'mlb') statsMap = await getMLBStats();
  else if (sport === 'nba') statsMap = await getNBAStats();
  else if (sport === 'nhl') statsMap = await getNHLStats();

  const picks = [];

  for (const game of games) {
    const home = game.home_team, away = game.away_team;
    const bookmakers = game.bookmakers || [];
    const homeStats = findTeam(home, statsMap);
    const awayStats = findTeam(away, statsMap);

    for (const [name, isHome] of [[home, true], [away, false]]) {
      const myStats = isHome ? homeStats : awayStats;
      const oppStats = isHome ? awayStats : homeStats;

      let statScore = 50;
      if (sport === 'mlb') statScore = scoreMLB(myStats, oppStats, isHome);
      else if (sport === 'nba') statScore = scoreNBA(myStats, oppStats, isHome);
      else if (sport === 'nhl') statScore = scoreNHL(myStats, oppStats, isHome);

      // Moneyline
      const mlEdge = calcMarketEdge(name, bookmakers, 'h2h');
      if (mlEdge.bestOdds !== null && oddsPassesFilter(mlEdge.bestOdds)) {
        const marketBonus = Math.min(10, Math.max(-5, mlEdge.edge));
        const confidence = Math.min(95, Math.max(20, Math.round(statScore * 0.82 + marketBonus)));
        const ev = ((mlEdge.avgProb * toDecimal(mlEdge.bestOdds)) - 1) * 100;
        picks.push({
          sport, game: `${away} @ ${home}`, team: name, betType: 'Moneyline',
          selection: name, bestOdds: fmtOdds(mlEdge.bestOdds),
          edge: mlEdge.edge.toFixed(1), confidence, ev: ev.toFixed(1),
          commence: game.commence_time, statsAvailable: !!(homeStats && awayStats),
          factors: buildFactors(sport, myStats, oppStats, isHome)
        });
      }

      // Spread
      const spreadBm = bookmakers.find(b => b.markets?.find(m => m.key === 'spreads'));
      if (spreadBm) {
        const spreadMarket = spreadBm.markets.find(m => m.key === 'spreads');
        const spreadOut = spreadMarket?.outcomes.find(o => o.name === name);
        if (spreadOut && oddsPassesFilter(spreadOut.price)) {
          const sEdge = calcMarketEdge(name, bookmakers, 'spreads');
          const confidence = Math.min(92, Math.max(20, Math.round(statScore * 0.75 + Math.min(8, sEdge.edge))));
          const ev = ((sEdge.avgProb * toDecimal(spreadOut.price)) - 1) * 100;
          const pt = spreadOut.point;
          picks.push({
            sport, game: `${away} @ ${home}`, team: name, betType: 'Spread',
            selection: `${name} ${pt > 0 ? '+' : ''}${pt}`,
            bestOdds: fmtOdds(spreadOut.price),
            edge: sEdge.edge.toFixed(1), confidence, ev: ev.toFixed(1),
            commence: game.commence_time, statsAvailable: !!(homeStats && awayStats),
            factors: buildFactors(sport, myStats, oppStats, isHome)
          });
        }
      }
    }

    // Totals — now uses team offensive stats
    const totalsBm = bookmakers.find(b => b.markets?.find(m => m.key === 'totals'));
    if (totalsBm) {
      const totalsMarket = totalsBm.markets.find(m => m.key === 'totals');
      totalsMarket?.outcomes.forEach(out => {
        if (!oddsPassesFilter(out.price)) return;
        const tEdge = calcMarketEdge(out.name, bookmakers, 'totals');
        const ev = ((tEdge.avgProb * toDecimal(out.price)) - 1) * 100;

        // Score totals using combined offensive output of both teams
        let totalStatScore = 50;
        if (homeStats && awayStats) {
          if (sport === 'mlb') {
            const homeGP = Math.max(1, homeStats.wins + homeStats.losses);
            const awayGP = Math.max(1, awayStats.wins + awayStats.losses);
            const combinedRPG = (homeStats.runsScored / homeGP) + (awayStats.runsScored / awayGP);
            // League avg ~9 runs/game combined. Higher = lean over, lower = lean under
            const offensiveBias = (combinedRPG - 9) * 4;
            totalStatScore = out.name === 'Over'
              ? Math.min(85, Math.max(20, 50 + offensiveBias))
              : Math.min(85, Math.max(20, 50 - offensiveBias));
          } else if (sport === 'nba') {
            const combinedPace = ((homeStats.pace || 0) + (awayStats.pace || 0)) / 2;
            const combinedOffRating = ((homeStats.offRating || 0) + (awayStats.offRating || 0)) / 2;
            // League avg pace ~99, off rating ~115
            const paceBias = (combinedPace - 99) * 0.8;
            const offBias = (combinedOffRating - 115) * 0.5;
            totalStatScore = out.name === 'Over'
              ? Math.min(85, Math.max(20, 50 + paceBias + offBias))
              : Math.min(85, Math.max(20, 50 - paceBias - offBias));
          } else if (sport === 'nhl') {
            const combinedGPG = (homeStats.goalsForPerGame || 0) + (awayStats.goalsForPerGame || 0);
            // League avg ~6.2 combined goals/game
            const goalBias = (combinedGPG - 6.2) * 5;
            totalStatScore = out.name === 'Over'
              ? Math.min(85, Math.max(20, 50 + goalBias))
              : Math.min(85, Math.max(20, 50 - goalBias));
          }
        }

        const confidence = Math.min(85, Math.max(20, Math.round(
          totalStatScore * 0.7 + (50 + Math.min(15, tEdge.edge * 2)) * 0.3
        )));

        // Build total factors
        const totalFactors = [];
        if (homeStats && awayStats) {
          if (sport === 'mlb') {
            const homeGP = Math.max(1, homeStats.wins + homeStats.losses);
            const awayGP = Math.max(1, awayStats.wins + awayStats.losses);
            totalFactors.push({ label: `${home} RS/G`, value: (homeStats.runsScored/homeGP).toFixed(1), positive: out.name === 'Over' });
            totalFactors.push({ label: `${away} RS/G`, value: (awayStats.runsScored/awayGP).toFixed(1), positive: out.name === 'Over' });
          } else if (sport === 'nba') {
            totalFactors.push({ label: `${home} Pace`, value: (homeStats.pace||0).toFixed(1), positive: out.name === 'Over' });
            totalFactors.push({ label: `${away} Pace`, value: (awayStats.pace||0).toFixed(1), positive: out.name === 'Over' });
            totalFactors.push({ label: 'Combined Off Rtg', value: `${(((homeStats.offRating||0)+(awayStats.offRating||0))/2).toFixed(1)}`, positive: out.name === 'Over' });
          } else if (sport === 'nhl') {
            totalFactors.push({ label: `${home} GF/G`, value: (homeStats.goalsForPerGame||0).toFixed(2), positive: out.name === 'Over' });
            totalFactors.push({ label: `${away} GF/G`, value: (awayStats.goalsForPerGame||0).toFixed(2), positive: out.name === 'Over' });
          }
        }

        picks.push({
          sport, game: `${away} @ ${home}`,
          team: `${out.name} ${out.point}`, betType: 'Total',
          selection: `${out.name} ${out.point}`, bestOdds: fmtOdds(out.price),
          edge: tEdge.edge.toFixed(1), confidence, ev: ev.toFixed(1),
          commence: game.commence_time,
          statsAvailable: !!(homeStats && awayStats),
          factors: totalFactors
        });
      });
    }
  }

  picks.sort((a, b) => b.confidence - a.confidence);
  setCache(`picks_${sport}`, picks, 10 * 60 * 1000);
  return picks;
}

// ── PICKS ENDPOINT ──
app.get('/api/picks/all', async (req, res) => {
  try {
    const [mlb, nba, nhl] = await Promise.all([
      buildPicks('mlb').catch(() => []),
      buildPicks('nba').catch(() => []),
      buildPicks('nhl').catch(() => [])
    ]);
    const all = [...mlb, ...nba, ...nhl].sort((a, b) => b.confidence - a.confidence);
    res.json({ overall: { top5: all.slice(0, 5), all }, mlb: { top5: mlb.slice(0, 5), all: mlb }, nba: { top5: nba.slice(0, 5), all: nba }, nhl: { top5: nhl.slice(0, 5), all: nhl } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate picks' });
  }
});

// ── ODDS ENDPOINT ──
app.get('/api/odds/:sport', async (req, res) => {
  const sport = req.params.sport.toLowerCase();
  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) return res.status(400).json({ error: 'Invalid sport' });
  const cached = getCache(`odds_${sport}`);
  if (cached) return res.json(cached);
  try {
    const url = `${ODDS_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso`;
    const response = await fetch(url);
    const data = await response.json();
    if (!Array.isArray(data)) return res.json({ games: [], message: data.message || 'No games available' });
    const games = data.map(game => {
      const fanduel = game.bookmakers?.find(b => b.key === 'fanduel') || game.bookmakers?.[0];
      const markets = {};
      fanduel?.markets?.forEach(m => { markets[m.key] = m.outcomes; });
      return { id: game.id, sport, home: game.home_team, away: game.away_team, commence: game.commence_time, bookmaker: fanduel?.title || 'N/A', h2h: markets['h2h'] || [], spreads: markets['spreads'] || [], totals: markets['totals'] || [] };
    });
    const result = { games };
    setCache(`odds_${sport}`, result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch odds' }); }
});

// ── PARLAY ──
app.post('/api/parlay', (req, res) => {
  const { legs } = req.body;
  if (!legs || legs.length < 2 || legs.length > 3) return res.status(400).json({ error: 'Parlay requires 2-3 legs' });
  const combinedDecimal = legs.reduce((acc, leg) => acc * toDecimal(leg.odds), 1);
  const combinedAmerican = combinedDecimal >= 2 ? Math.round((combinedDecimal - 1) * 100) : Math.round(-100 / (combinedDecimal - 1));
  res.json({ legs, combinedOdds: combinedAmerican > 0 ? `+${combinedAmerican}` : `${combinedAmerican}`, impliedProb: (1 / combinedDecimal * 100).toFixed(1), payoutPer100: ((combinedDecimal - 1) * 100).toFixed(2) });
});

// ── BET LOGGER ──
app.get('/api/bets', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM bets ORDER BY created_at DESC'); res.json({ bets: r.rows }); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch bets' }); }
});
app.post('/api/bets', async (req, res) => {
  const { sport, game, bet_type, selection, odds, stake, notes } = req.body;
  if (!sport || !game || !bet_type || !selection || !odds) return res.status(400).json({ error: 'Missing required fields' });
  try {
    const r = await pool.query('INSERT INTO bets (sport, game, bet_type, selection, odds, stake, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [sport, game, bet_type, selection, odds, stake || null, notes || null]);
    res.json({ bet: r.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Failed to log bet' }); }
});
app.patch('/api/bets/:id', async (req, res) => {
  const { result } = req.body;
  if (!['win','loss','push','pending'].includes(result)) return res.status(400).json({ error: 'Invalid result' });
  try { const r = await pool.query('UPDATE bets SET result=$1 WHERE id=$2 RETURNING *', [result, req.params.id]); res.json({ bet: r.rows[0] }); }
  catch (err) { res.status(500).json({ error: 'Failed to update' }); }
});
app.delete('/api/bets/:id', async (req, res) => {
  try { await pool.query('DELETE FROM bets WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Failed to delete' }); }
});
app.get('/api/bets/stats', async (req, res) => {
  try {
    const r = await pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE result='win') as wins, COUNT(*) FILTER (WHERE result='loss') as losses, COUNT(*) FILTER (WHERE result='push') as pushes, COUNT(*) FILTER (WHERE result='pending') as pending, COALESCE(SUM(stake),0) as total_staked FROM bets`);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to get stats' }); }
});

app.listen(PORT, () => console.log(`Edge Pro running on port ${PORT}`));

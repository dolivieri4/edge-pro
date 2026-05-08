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
      );
      CREATE TABLE IF NOT EXISTS line_snapshots (
        id SERIAL PRIMARY KEY,
        sport TEXT NOT NULL,
        game_id TEXT NOT NULL,
        team TEXT NOT NULL,
        market TEXT NOT NULL,
        odds INTEGER NOT NULL,
        recorded_at TIMESTAMP DEFAULT NOW()
      );
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
const WEATHER_API_KEY = process.env.WEATHER_API_KEY || '';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const MAX_NEGATIVE_ODDS = -200;

const SPORT_KEYS = {
  mlb: 'baseball_mlb',
  nba: 'basketball_nba',
  nhl: 'icehockey_nhl',
  nfl: 'americanfootball_nfl'
};

// MLB stadium coordinates for weather
const MLB_STADIUMS = {
  'New York Yankees': { lat: 40.8296, lon: -73.9262, name: 'Yankee Stadium' },
  'New York Mets': { lat: 40.7571, lon: -73.8458, name: 'Citi Field' },
  'Boston Red Sox': { lat: 42.3467, lon: -71.0972, name: 'Fenway Park' },
  'Chicago Cubs': { lat: 41.9484, lon: -87.6553, name: 'Wrigley Field' },
  'Chicago White Sox': { lat: 41.8300, lon: -87.6338, name: 'Guaranteed Rate Field' },
  'Los Angeles Dodgers': { lat: 34.0739, lon: -118.2400, name: 'Dodger Stadium' },
  'Los Angeles Angels': { lat: 33.8003, lon: -117.8827, name: 'Angel Stadium' },
  'San Francisco Giants': { lat: 37.7786, lon: -122.3893, name: 'Oracle Park' },
  'Oakland Athletics': { lat: 37.7516, lon: -122.2005, name: 'Oakland Coliseum' },
  'Houston Astros': { lat: 29.7572, lon: -95.3555, name: 'Minute Maid Park' },
  'Texas Rangers': { lat: 32.7512, lon: -97.0832, name: 'Globe Life Field' },
  'Seattle Mariners': { lat: 47.5914, lon: -122.3325, name: 'T-Mobile Park' },
  'Atlanta Braves': { lat: 33.8908, lon: -84.4679, name: 'Truist Park' },
  'Miami Marlins': { lat: 25.7781, lon: -80.2197, name: 'loanDepot park' },
  'Philadelphia Phillies': { lat: 39.9061, lon: -75.1665, name: 'Citizens Bank Park' },
  'Washington Nationals': { lat: 38.8730, lon: -77.0074, name: 'Nationals Park' },
  'Pittsburgh Pirates': { lat: 40.4469, lon: -80.0057, name: 'PNC Park' },
  'Cincinnati Reds': { lat: 39.0979, lon: -84.5082, name: 'Great American Ball Park' },
  'Milwaukee Brewers': { lat: 43.0280, lon: -87.9712, name: 'American Family Field' },
  'St. Louis Cardinals': { lat: 38.6226, lon: -90.1928, name: 'Busch Stadium' },
  'Minnesota Twins': { lat: 44.9817, lon: -93.2778, name: 'Target Field' },
  'Detroit Tigers': { lat: 42.3390, lon: -83.0485, name: 'Comerica Park' },
  'Cleveland Guardians': { lat: 41.4962, lon: -81.6852, name: 'Progressive Field' },
  'Kansas City Royals': { lat: 39.0517, lon: -94.4803, name: 'Kauffman Stadium' },
  'Toronto Blue Jays': { lat: 43.6414, lon: -79.3894, name: 'Rogers Centre' },
  'Baltimore Orioles': { lat: 39.2838, lon: -76.6216, name: 'Camden Yards' },
  'Tampa Bay Rays': { lat: 27.7683, lon: -82.6534, name: 'Tropicana Field' },
  'Arizona Diamondbacks': { lat: 33.4453, lon: -112.0667, name: 'Chase Field' },
  'Colorado Rockies': { lat: 39.7559, lon: -104.9942, name: 'Coors Field' },
  'San Diego Padres': { lat: 32.7076, lon: -117.1570, name: 'Petco Park' },
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
function toDecimal(p) {
  const n = parseFloat(String(p).replace('+', ''));
  return n > 0 ? (n / 100) + 1 : (100 / Math.abs(n)) + 1;
}
function impliedProb(p) { return 1 / toDecimal(p); }
function fmtOdds(p) { return p > 0 ? `+${p}` : `${p}`; }
function oddsPassesFilter(price) {
  const n = parseFloat(String(price).replace('+', ''));
  return n > 0 || n >= MAX_NEGATIVE_ODDS;
}

// Kelly Criterion — returns recommended units (capped at 3u)
function kellyUnits(ev, impliedP, bestOddsStr) {
  try {
    const dec = toDecimal(bestOddsStr);
    const winProb = impliedP; // our estimated win probability
    const b = dec - 1; // net odds
    const kelly = (b * winProb - (1 - winProb)) / b;
    const fractionalKelly = kelly * 0.25; // quarter Kelly for safety
    const units = Math.max(0, Math.min(3, parseFloat((fractionalKelly * 10).toFixed(1))));
    return units;
  } catch { return 0; }
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

// ── LINE MOVEMENT ──
async function recordLineSnapshot(sport, games) {
  try {
    for (const game of games) {
      const bookmakers = game.bookmakers || [];
      const fanduel = bookmakers.find(b => b.key === 'fanduel') || bookmakers[0];
      if (!fanduel) continue;
      for (const market of fanduel.markets || []) {
        for (const outcome of market.outcomes || []) {
          await pool.query(
            `INSERT INTO line_snapshots (sport, game_id, team, market, odds) VALUES ($1,$2,$3,$4,$5)`,
            [sport, game.id, outcome.name, market.key, Math.round(outcome.price)]
          ).catch(() => {});
        }
      }
    }
  } catch (err) { console.error('Line snapshot error:', err.message); }
}

async function getLineMovement(sport, gameId, teamName, market) {
  try {
    const result = await pool.query(
      `SELECT odds, recorded_at FROM line_snapshots
       WHERE sport=$1 AND game_id=$2 AND team=$3 AND market=$4
       ORDER BY recorded_at ASC LIMIT 20`,
      [sport, gameId, teamName, market]
    );
    const rows = result.rows;
    if (rows.length < 2) return null;
    const first = rows[0].odds;
    const last = rows[rows.length - 1].odds;
    const movement = last - first;
    if (Math.abs(movement) < 5) return null;
    return { opening: first, current: last, movement, direction: movement > 0 ? 'steam' : 'fade' };
  } catch { return null; }
}

// ── WEATHER ──
async function getMLBWeather(homeTeam) {
  const stadium = MLB_STADIUMS[homeTeam];
  if (!stadium) return null;

  // Tropicana Field and Chase Field are domes — weather irrelevant
  const domes = ['Tropicana Field', 'Chase Field', 'Rogers Centre', 'loanDepot park', 'American Family Field', 'Globe Life Field', 'Minute Maid Park'];
  if (domes.includes(stadium.name)) return { dome: true, stadium: stadium.name };

  const cacheKey = `weather_${homeTeam}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    // Open-Meteo is completely free, no API key needed
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${stadium.lat}&longitude=${stadium.lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation_probability,weather_code&wind_speed_unit=mph&temperature_unit=fahrenheit&forecast_days=1`;
    const res = await fetch(url);
    const data = await res.json();
    const curr = data.current;

    const windDir = curr.wind_direction_10m;
    const windSpeed = Math.round(curr.wind_speed_10m);
    const temp = Math.round(curr.temperature_2m);
    const precipChance = curr.precipitation_probability;

    // Determine wind direction relative to "blowing out" (rough estimate)
    let windImpact = 'neutral';
    if (windSpeed >= 15) windImpact = 'significant';
    if (windSpeed >= 10 && windSpeed < 15) windImpact = 'moderate';

    const weather = {
      dome: false,
      stadium: stadium.name,
      temp,
      windSpeed,
      windDir,
      windImpact,
      precipChance,
      // Coors Field altitude always inflates totals
      isCoorsField: stadium.name === 'Coors Field'
    };

    setCache(cacheKey, weather, 60 * 60 * 1000);
    return weather;
  } catch (err) {
    console.error('Weather error:', err.message);
    return null;
  }
}

// Weather adjustment for MLB totals
function weatherTotalAdjustment(weather, isOver) {
  if (!weather || weather.dome) return { adjustment: 0, factors: [] };
  const factors = [];
  let adj = 0;

  if (weather.isCoorsField) {
    adj += isOver ? 6 : -6;
    factors.push({ label: 'Coors Field', value: 'High altitude — ball carries', positive: isOver });
  }
  if (weather.windSpeed >= 15) {
    // Significant wind — hard to determine direction so just flag it
    adj += isOver ? 3 : -3;
    factors.push({ label: `Wind ${weather.windSpeed}mph`, value: `${weather.windDir}° — significant`, positive: isOver });
  } else if (weather.windSpeed >= 10) {
    adj += isOver ? 1 : -1;
    factors.push({ label: `Wind ${weather.windSpeed}mph`, value: 'Moderate wind', positive: isOver });
  }
  if (weather.temp <= 45) {
    adj += isOver ? -4 : 4;
    factors.push({ label: `Temp ${weather.temp}°F`, value: 'Cold suppresses offense', positive: !isOver });
  } else if (weather.temp >= 85) {
    adj += isOver ? 2 : -2;
    factors.push({ label: `Temp ${weather.temp}°F`, value: 'Heat favors offense', positive: isOver });
  }
  if (weather.precipChance >= 50) {
    adj += isOver ? -3 : 3;
    factors.push({ label: `Rain ${weather.precipChance}%`, value: 'Precipitation risk', positive: !isOver });
  }

  return { adjustment: adj, factors };
}

// ── INJURY & CONTEXTUAL DATA ──
async function getInjuries(sport) {
  const cacheKey = `injuries_${sport}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const espnSport = { nba: 'basketball/nba', mlb: 'baseball/mlb', nhl: 'hockey/nhl' }[sport];
  if (!espnSport) return {};
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${espnSport}/injuries`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await res.json();
    const injuries = {};
    data.injuries?.forEach(teamEntry => {
      const teamName = teamEntry.team?.displayName || '';
      const injured = [];
      teamEntry.injuries?.forEach(inj => {
        const status = inj.status?.toLowerCase() || '';
        const name = inj.athlete?.displayName || '';
        const pos = inj.athlete?.position?.abbreviation || '';
        if (['out','doubtful','questionable','day-to-day'].some(s => status.includes(s))) {
          injured.push({ name, status, pos });
        }
      });
      if (injured.length) injuries[teamName] = injured;
    });
    setCache(cacheKey, injuries, 15 * 60 * 1000);
    return injuries;
  } catch (err) { console.error(`Injury error (${sport}):`, err.message); return {}; }
}

async function getMLBProbablePitchers() {
  const cached = getCache('mlb_pitchers');
  if (cached) return cached;
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher(note),team`);
    const data = await res.json();
    const pitchers = {};
    data.dates?.[0]?.games?.forEach(game => {
      ['home','away'].forEach(side => {
        const t = game.teams?.[side];
        if (t?.team?.name && t?.probablePitcher) {
          pitchers[t.team.name] = { name: t.probablePitcher.fullName, era: t.probablePitcher.era || null };
        }
      });
    });
    setCache('mlb_pitchers', pitchers, 60 * 60 * 1000);
    return pitchers;
  } catch (err) { console.error('Pitcher error:', err.message); return {}; }
}

async function getNBARestDays() {
  const cached = getCache('nba_rest');
  if (cached) return cached;
  try {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0].replace(/-/g,'');
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yesterday}`);
    const data = await res.json();
    const playedYesterday = new Set();
    data.events?.forEach(event => {
      event.competitions?.[0]?.competitors?.forEach(c => {
        playedYesterday.add(c.team?.displayName);
        playedYesterday.add(c.team?.shortDisplayName);
      });
    });
    setCache('nba_rest', playedYesterday, 60 * 60 * 1000);
    return playedYesterday;
  } catch (err) { console.error('Rest error:', err.message); return new Set(); }
}

// H2H records
async function getH2H(sport, homeTeam, awayTeam) {
  const cacheKey = `h2h_${sport}_${homeTeam}_${awayTeam}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    if (sport === 'mlb') {
      const today = new Date().toISOString().split('T')[0];
      const seasonStart = `${new Date().getFullYear()}-01-01`;
      const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${seasonStart}&endDate=${today}&hydrate=team,linescore&teamId=&opponent=`);
      // Simplified — return null if complex lookup needed
      setCache(cacheKey, null, 60 * 60 * 1000);
      return null;
    }
    return null;
  } catch { return null; }
}

function calcInjuryPenalty(teamName, injuryMap, sport) {
  if (!injuryMap || !teamName) return { penalty: 0, injuredPlayers: [] };
  let injured = null;
  const tLower = teamName.toLowerCase();
  for (const [key, val] of Object.entries(injuryMap)) {
    if (key.toLowerCase().includes(tLower) || tLower.includes(key.toLowerCase().split(' ').pop())) {
      injured = val; break;
    }
  }
  if (!injured || !injured.length) return { penalty: 0, injuredPlayers: [] };
  let penalty = 0;
  const injuredPlayers = [];
  injured.forEach(player => {
    const status = player.status?.toLowerCase() || '';
    const pos = player.pos?.toUpperCase() || '';
    const isOut = status.includes('out') || status.includes('doubtful');
    const multiplier = isOut ? 1.0 : 0.5;
    let importance = 0;
    if (sport === 'nba') importance = ['PG','SG','SF','PF'].includes(pos) ? 6 : pos === 'C' ? 4 : 2;
    else if (sport === 'mlb') importance = pos === 'SP' ? 12 : ['OF','1B','2B','3B','SS'].includes(pos) ? 4 : pos === 'C' ? 3 : 2;
    else if (sport === 'nhl') importance = pos === 'G' ? 12 : ['F','LW','RW','C'].includes(pos) ? 5 : pos === 'D' ? 3 : 2;
    const playerPenalty = importance * multiplier;
    penalty += playerPenalty;
    if (playerPenalty >= 2) injuredPlayers.push({ name: player.name, status: player.status, pos, penalty: playerPenalty });
  });
  return { penalty: Math.min(18, penalty), injuredPlayers: injuredPlayers.sort((a,b) => b.penalty - a.penalty).slice(0,3) };
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
  // Record line snapshots asynchronously
  recordLineSnapshot(sport, data).catch(() => {});
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
        const homeW = home.wins||0, homeL = home.losses||0;
        const awayW = away.wins||0, awayL = away.losses||0;
        teamData[name] = {
          wins: record.wins||0, losses: record.losses||0,
          winPct: parseFloat(record.winningPercentage)||0,
          homeWinPct: homeW/Math.max(1,homeW+homeL),
          awayWinPct: awayW/Math.max(1,awayW+awayL),
          last10WinPct: (last10.wins||0)/10,
          runDiff: record.runDifferential||0,
          runsScored: record.runsScored||0,
          runsAllowed: record.runsAllowed||0,
          streak: record.streak?.streakCode||''
        };
      });
    });
    setCache('mlb_stats', teamData, 20*60*1000);
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
      headers.forEach((h,i) => obj[h] = row[i]);
      teamData[obj.TEAM_NAME] = {
        wins: obj.W||0, losses: obj.L||0, winPct: obj.W_PCT||0,
        offRating: obj.OFF_RATING||0, defRating: obj.DEF_RATING||0,
        netRating: obj.NET_RATING||0, pace: obj.PACE||0,
        tsPct: obj.TS_PCT||0, tovPct: obj.TM_TOV_PCT||0,
        piePct: obj.PIE||0, efgPct: obj.EFG_PCT||0
      };
    });
    setCache('nba_stats', teamData, 20*60*1000);
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
      const fullName = `${team.placeName?.default||''} ${team.teamName?.default||''}`.trim();
      const gp = (team.wins||0)+(team.losses||0)+(team.otLosses||0);
      teamData[fullName] = {
        wins: team.wins||0, losses: team.losses||0, otLosses: team.otLosses||0,
        points: team.points||0,
        winPct: (team.wins||0)/Math.max(1,gp),
        goalsForPerGame: (team.goalFor||0)/Math.max(1,gp),
        goalsAgainstPerGame: (team.goalAgainst||0)/Math.max(1,gp),
        goalDiff: team.goalDifferential||0,
        homeWinPct: (team.homeWins||0)/Math.max(1,(team.homeWins||0)+(team.homeLosses||0)+(team.homeOtLosses||0)),
        roadWinPct: (team.roadWins||0)/Math.max(1,(team.roadWins||0)+(team.roadLosses||0)+(team.roadOtLosses||0)),
        l10Wins: team.l10Wins||0,
        streak: team.streakCode||'',
        ppPct: team.powerPlayPct||0,
        pkPct: team.penaltyKillPct||0
      };
    });
    setCache('nhl_stats', teamData, 20*60*1000);
    return teamData;
  } catch (err) { console.error('NHL stats error:', err.message); return {}; }
}

// ── TEAM NAME FUZZY MATCH ──
function findTeam(name, statsMap) {
  if (!name||!statsMap) return null;
  const n = name.toLowerCase().trim();
  for (const [key, val] of Object.entries(statsMap)) {
    const k = key.toLowerCase().trim();
    if (k===n||k.includes(n)||n.includes(k)) return val;
    const kLast = k.split(' ').pop();
    const nLast = n.split(' ').pop();
    if (kLast===nLast&&kLast.length>3) return val;
  }
  return null;
}

// ── SCORING ──
function scoreMLB(myStats, oppStats, isHome) {
  if (!myStats||!oppStats) return 45;
  let s = 50;
  s += (myStats.winPct-oppStats.winPct)*15;
  const locPct = isHome?myStats.homeWinPct:myStats.awayWinPct;
  const oppLocPct = isHome?oppStats.awayWinPct:oppStats.homeWinPct;
  s += (locPct-oppLocPct)*10;
  s += (myStats.last10WinPct-oppStats.last10WinPct)*10;
  const myGP = Math.max(1,myStats.wins+myStats.losses);
  const oppGP = Math.max(1,oppStats.wins+oppStats.losses);
  s += Math.min(8,Math.max(-8,(myStats.runDiff/myGP-oppStats.runDiff/oppGP)*2));
  s += Math.min(5,Math.max(-5,myStats.runsScored/myGP-oppStats.runsScored/oppGP));
  s += Math.min(5,Math.max(-5,oppStats.runsAllowed/oppGP-myStats.runsAllowed/myGP));
  const streak = myStats.streak||'';
  if (streak.startsWith('W')) s += Math.min(5,parseInt(streak.slice(1))||0);
  if (streak.startsWith('L')) s -= Math.min(5,parseInt(streak.slice(1))||0);
  return Math.min(95,Math.max(20,Math.round(s)));
}

function scoreNBA(myStats, oppStats, isHome) {
  if (!myStats||!oppStats) return 45;
  let s = 50;
  s += Math.min(12,Math.max(-12,(myStats.netRating-oppStats.netRating)*1.2));
  s += Math.min(8,Math.max(-8,(myStats.offRating-oppStats.offRating)*0.5));
  s += Math.min(8,Math.max(-8,(oppStats.defRating-myStats.defRating)*0.5));
  s += (myStats.winPct-oppStats.winPct)*8;
  s += Math.min(5,Math.max(-5,(myStats.tsPct-oppStats.tsPct)*50));
  s += Math.min(4,Math.max(-4,(oppStats.tovPct-myStats.tovPct)*10));
  s += Math.min(5,Math.max(-5,(myStats.piePct-oppStats.piePct)*100));
  if (isHome) s += 3;
  return Math.min(95,Math.max(20,Math.round(s)));
}

function scoreNHL(myStats, oppStats, isHome) {
  if (!myStats||!oppStats) return 45;
  let s = 50;
  s += (myStats.winPct-oppStats.winPct)*12;
  s += Math.min(10,Math.max(-10,(myStats.goalsForPerGame-oppStats.goalsForPerGame)*4));
  s += Math.min(10,Math.max(-10,(oppStats.goalsAgainstPerGame-myStats.goalsAgainstPerGame)*4));
  const locPct = isHome?myStats.homeWinPct:myStats.roadWinPct;
  const oppLocPct = isHome?oppStats.roadWinPct:oppStats.homeWinPct;
  s += (locPct-oppLocPct)*8;
  s += (myStats.l10Wins/10-oppStats.l10Wins/10)*8;
  s += Math.min(5,Math.max(-5,(myStats.ppPct-oppStats.ppPct)*2));
  s += Math.min(4,Math.max(-4,(myStats.pkPct-oppStats.pkPct)*2));
  const streak = myStats.streak||'';
  if (streak.startsWith('W')) s += Math.min(4,parseInt(streak.slice(1))||0);
  if (streak.startsWith('L')) s -= Math.min(4,parseInt(streak.slice(1))||0);
  if (isHome) s += 3;
  return Math.min(95,Math.max(20,Math.round(s)));
}

function buildFactors(sport, myStats, oppStats, isHome) {
  const f = [];
  if (!myStats||!oppStats) return f;
  if (sport==='mlb') {
    if (Math.abs(myStats.winPct-oppStats.winPct)>0.04) f.push({label:'Win %',value:`${(myStats.winPct*100).toFixed(0)}% vs ${(oppStats.winPct*100).toFixed(0)}%`,positive:myStats.winPct>oppStats.winPct});
    if (myStats.last10WinPct!==0.5) f.push({label:'Last 10',value:`${Math.round(myStats.last10WinPct*10)}-${10-Math.round(myStats.last10WinPct*10)}`,positive:myStats.last10WinPct>0.5});
    const myGP=Math.max(1,myStats.wins+myStats.losses);const oppGP=Math.max(1,oppStats.wins+oppStats.losses);
    const rdDiff=myStats.runDiff/myGP-oppStats.runDiff/oppGP;
    if (Math.abs(rdDiff)>0.3) f.push({label:'Run Diff/G',value:`${rdDiff>0?'+':''}${rdDiff.toFixed(1)}`,positive:rdDiff>0});
    const locPct=isHome?myStats.homeWinPct:myStats.awayWinPct;
    f.push({label:isHome?'Home Record':'Road Record',value:`${(locPct*100).toFixed(0)}%`,positive:locPct>0.5});
    const streak=myStats.streak||'';
    if (streak) f.push({label:'Streak',value:streak,positive:streak.startsWith('W')});
  }
  if (sport==='nba') {
    f.push({label:'Net Rating',value:`${myStats.netRating>0?'+':''}${(myStats.netRating||0).toFixed(1)} vs ${oppStats.netRating>0?'+':''}${(oppStats.netRating||0).toFixed(1)}`,positive:myStats.netRating>oppStats.netRating});
    f.push({label:'Off Rating',value:`${(myStats.offRating||0).toFixed(1)} vs ${(oppStats.offRating||0).toFixed(1)}`,positive:myStats.offRating>oppStats.offRating});
    f.push({label:'Def Rating',value:`${(myStats.defRating||0).toFixed(1)} vs ${(oppStats.defRating||0).toFixed(1)}`,positive:myStats.defRating<oppStats.defRating});
    f.push({label:'True Shooting',value:`${((myStats.tsPct||0)*100).toFixed(1)}% vs ${((oppStats.tsPct||0)*100).toFixed(1)}%`,positive:myStats.tsPct>oppStats.tsPct});
    if (isHome) f.push({label:'Home Court',value:'Home advantage',positive:true});
  }
  if (sport==='nhl') {
    f.push({label:'Goals/Game',value:`${(myStats.goalsForPerGame||0).toFixed(2)} vs ${(oppStats.goalsForPerGame||0).toFixed(2)}`,positive:myStats.goalsForPerGame>oppStats.goalsForPerGame});
    f.push({label:'GA/Game',value:`${(myStats.goalsAgainstPerGame||0).toFixed(2)} vs ${(oppStats.goalsAgainstPerGame||0).toFixed(2)}`,positive:myStats.goalsAgainstPerGame<oppStats.goalsAgainstPerGame});
    f.push({label:'Power Play %',value:`${(myStats.ppPct||0).toFixed(1)}% vs ${(oppStats.ppPct||0).toFixed(1)}%`,positive:myStats.ppPct>oppStats.ppPct});
    f.push({label:'Last 10',value:`${myStats.l10Wins}-${10-myStats.l10Wins}`,positive:myStats.l10Wins>5});
    if (isHome) f.push({label:'Home Ice',value:`${(myStats.homeWinPct*100).toFixed(0)}% at home`,positive:myStats.homeWinPct>0.5});
  }
  return f.slice(0,5);
}

// ── BUILD PICKS ──
async function buildPicks(sport) {
  const cached = getCache(`picks_${sport}`);
  if (cached) return cached;

  const games = await fetchOddsRaw(sport);
  if (!games.length) return [];

  let statsMap = {};
  if (sport==='mlb') statsMap = await getMLBStats();
  else if (sport==='nba') statsMap = await getNBAStats();
  else if (sport==='nhl') statsMap = await getNHLStats();

  const [injuryMap, pitchers, b2bSet] = await Promise.all([
    getInjuries(sport).catch(()=>({})),
    sport==='mlb'?getMLBProbablePitchers().catch(()=>({})):Promise.resolve({}),
    sport==='nba'?getNBARestDays().catch(()=>new Set()):Promise.resolve(new Set())
  ]);

  const picks = [];

  for (const game of games) {
    const home = game.home_team, away = game.away_team;
    const bookmakers = game.bookmakers||[];
    const homeStats = findTeam(home, statsMap);
    const awayStats = findTeam(away, statsMap);
    const homeB2B = sport==='nba' && [...b2bSet].some(t=>home.toLowerCase().includes(t.toLowerCase()));
    const awayB2B = sport==='nba' && [...b2bSet].some(t=>away.toLowerCase().includes(t.toLowerCase()));
    const homePitcher = pitchers[home]||null;
    const awayPitcher = pitchers[away]||null;

    // Weather for MLB
    const weather = sport==='mlb' ? await getMLBWeather(home).catch(()=>null) : null;

    for (const [name, isHome] of [[home,true],[away,false]]) {
      const myStats = isHome?homeStats:awayStats;
      const oppStats = isHome?awayStats:homeStats;
      const isB2B = isHome?homeB2B:awayB2B;
      const oppIsB2B = isHome?awayB2B:homeB2B;

      let statScore = 50;
      if (sport==='mlb') statScore = scoreMLB(myStats,oppStats,isHome);
      else if (sport==='nba') statScore = scoreNBA(myStats,oppStats,isHome);
      else if (sport==='nhl') statScore = scoreNHL(myStats,oppStats,isHome);

      if (sport==='nba') {
        if (isB2B) statScore -= 5;
        if (oppIsB2B) statScore += 3;
      }

      const myInjury = calcInjuryPenalty(name, injuryMap, sport);
      const oppInjury = calcInjuryPenalty(isHome?away:home, injuryMap, sport);
      statScore -= myInjury.penalty;
      statScore += oppInjury.penalty*0.5;
      statScore = Math.min(95,Math.max(15,statScore));

      const contextFactors = [];
      if (sport==='nba'&&isB2B) contextFactors.push({label:'Back-to-Back',value:'Fatigue risk',positive:false});
      if (sport==='nba'&&oppIsB2B) contextFactors.push({label:'Opp B2B',value:'Opponent fatigued',positive:true});
      if (sport==='mlb') {
        const myPitcher=isHome?homePitcher:awayPitcher;
        const oppPitcher=isHome?awayPitcher:homePitcher;
        if (myPitcher) contextFactors.push({label:'SP',value:myPitcher.era?`${myPitcher.name} (${myPitcher.era} ERA)`:myPitcher.name,positive:parseFloat(myPitcher.era)<4.0});
        if (oppPitcher) contextFactors.push({label:'Opp SP',value:oppPitcher.era?`${oppPitcher.name} (${oppPitcher.era} ERA)`:oppPitcher.name,positive:parseFloat(oppPitcher.era)>=4.0});
      }
      if (weather&&!weather.dome&&weather.windSpeed>=10) contextFactors.push({label:`Wind ${weather.windSpeed}mph`,value:`${weather.temp}°F`,positive:false});
      myInjury.injuredPlayers.forEach(p=>contextFactors.push({label:`INJ ${p.pos}`,value:`${p.name} (${p.status})`,positive:false}));
      oppInjury.injuredPlayers.slice(0,1).forEach(p=>contextFactors.push({label:'OPP INJ',value:`${p.name} (${p.status})`,positive:true}));

      const allFactors = [...buildFactors(sport,myStats,oppStats,isHome),...contextFactors].slice(0,6);

      // Moneyline
      const mlEdge = calcMarketEdge(name, bookmakers, 'h2h');
      if (mlEdge.bestOdds!==null&&oddsPassesFilter(mlEdge.bestOdds)) {
        const marketBonus = Math.min(10,Math.max(-5,mlEdge.edge));
        const confidence = Math.min(95,Math.max(20,Math.round(statScore*0.82+marketBonus)));
        const ev = ((mlEdge.avgProb*toDecimal(mlEdge.bestOdds))-1)*100;
        const lineMove = await getLineMovement(sport, game.id, name, 'h2h').catch(()=>null);
        const units = kellyUnits(ev, mlEdge.avgProb, fmtOdds(mlEdge.bestOdds));
        picks.push({
          sport, game:`${away} @ ${home}`, gameId:game.id, team:name, betType:'Moneyline',
          selection:name, bestOdds:fmtOdds(mlEdge.bestOdds),
          edge:mlEdge.edge.toFixed(1), confidence, ev:ev.toFixed(1), units,
          commence:game.commence_time, statsAvailable:!!(homeStats&&awayStats),
          factors:allFactors, lineMovement:lineMove,
          warnings:myInjury.injuredPlayers.length>0?`${myInjury.injuredPlayers.length} key injury/injuries`:null
        });
      }

      // Spread
      const spreadBm = bookmakers.find(b=>b.markets?.find(m=>m.key==='spreads'));
      if (spreadBm) {
        const spreadMarket = spreadBm.markets.find(m=>m.key==='spreads');
        const spreadOut = spreadMarket?.outcomes.find(o=>o.name===name);
        if (spreadOut&&oddsPassesFilter(spreadOut.price)) {
          const sEdge = calcMarketEdge(name, bookmakers, 'spreads');
          const confidence = Math.min(92,Math.max(20,Math.round(statScore*0.75+Math.min(8,sEdge.edge))));
          const ev = ((sEdge.avgProb*toDecimal(spreadOut.price))-1)*100;
          const pt = spreadOut.point;
          const lineMove = await getLineMovement(sport, game.id, name, 'spreads').catch(()=>null);
          const units = kellyUnits(ev, sEdge.avgProb, fmtOdds(spreadOut.price));
          picks.push({
            sport, game:`${away} @ ${home}`, gameId:game.id, team:name, betType:'Spread',
            selection:`${name} ${pt>0?'+':''}${pt}`, bestOdds:fmtOdds(spreadOut.price),
            edge:sEdge.edge.toFixed(1), confidence, ev:ev.toFixed(1), units,
            commence:game.commence_time, statsAvailable:!!(homeStats&&awayStats),
            factors:allFactors, lineMovement:lineMove,
            warnings:myInjury.injuredPlayers.length>0?`${myInjury.injuredPlayers.length} key injury/injuries`:null
          });
        }
      }
    }

    // Totals
    const totalsBm = bookmakers.find(b=>b.markets?.find(m=>m.key==='totals'));
    if (totalsBm) {
      const totalsMarket = totalsBm.markets.find(m=>m.key==='totals');
      for (const out of totalsMarket?.outcomes||[]) {
        if (!oddsPassesFilter(out.price)) continue;
        const tEdge = calcMarketEdge(out.name, bookmakers, 'totals');
        const ev = ((tEdge.avgProb*toDecimal(out.price))-1)*100;
        const isOver = out.name==='Over';

        let totalStatScore = 50;
        const totalFactors = [];

        if (homeStats&&awayStats) {
          if (sport==='mlb') {
            const homeGP=Math.max(1,homeStats.wins+homeStats.losses);
            const awayGP=Math.max(1,awayStats.wins+awayStats.losses);
            const combinedRPG=(homeStats.runsScored/homeGP)+(awayStats.runsScored/awayGP);
            let offensiveBias=(combinedRPG-9)*4;
            const homeERA=parseFloat(homePitcher?.era)||4.5;
            const awayERA=parseFloat(awayPitcher?.era)||4.5;
            offensiveBias -= ((4.5-homeERA)+(4.5-awayERA))*2;
            // Weather adjustment
            const {adjustment:weatherAdj, factors:weatherFactors} = weatherTotalAdjustment(weather, isOver);
            offensiveBias += weatherAdj;
            totalStatScore = isOver?Math.min(85,Math.max(20,50+offensiveBias)):Math.min(85,Math.max(20,50-offensiveBias));
            totalFactors.push({label:`${home} RS/G`,value:(homeStats.runsScored/homeGP).toFixed(1),positive:isOver});
            totalFactors.push({label:`${away} RS/G`,value:(awayStats.runsScored/awayGP).toFixed(1),positive:isOver});
            if (homePitcher) totalFactors.push({label:`${home} SP`,value:homePitcher.era?`${homePitcher.name} (${homePitcher.era})`:homePitcher.name,positive:isOver?parseFloat(homePitcher.era)>=4.5:parseFloat(homePitcher.era)<3.5});
            if (awayPitcher) totalFactors.push({label:`${away} SP`,value:awayPitcher.era?`${awayPitcher.name} (${awayPitcher.era})`:awayPitcher.name,positive:isOver?parseFloat(awayPitcher.era)>=4.5:parseFloat(awayPitcher.era)<3.5});
            totalFactors.push(...weatherFactors);
          } else if (sport==='nba') {
            const combinedPace=((homeStats.pace||0)+(awayStats.pace||0))/2;
            const combinedOffRating=((homeStats.offRating||0)+(awayStats.offRating||0))/2;
            let paceBias=(combinedPace-99)*0.8;
            const offBias=(combinedOffRating-115)*0.5;
            if (homeB2B||awayB2B) paceBias-=3;
            totalStatScore = isOver?Math.min(85,Math.max(20,50+paceBias+offBias)):Math.min(85,Math.max(20,50-paceBias-offBias));
            totalFactors.push({label:`${home} Pace`,value:(homeStats.pace||0).toFixed(1),positive:isOver});
            totalFactors.push({label:`${away} Pace`,value:(awayStats.pace||0).toFixed(1),positive:isOver});
            totalFactors.push({label:'Combined Off Rtg',value:`${combinedOffRating.toFixed(1)}`,positive:isOver});
            if (homeB2B||awayB2B) totalFactors.push({label:'B2B Factor',value:`${homeB2B?home:away} on B2B`,positive:!isOver});
          } else if (sport==='nhl') {
            const combinedGPG=(homeStats.goalsForPerGame||0)+(awayStats.goalsForPerGame||0);
            const goalBias=(combinedGPG-6.2)*5;
            totalStatScore = isOver?Math.min(85,Math.max(20,50+goalBias)):Math.min(85,Math.max(20,50-goalBias));
            totalFactors.push({label:`${home} GF/G`,value:(homeStats.goalsForPerGame||0).toFixed(2),positive:isOver});
            totalFactors.push({label:`${away} GF/G`,value:(awayStats.goalsForPerGame||0).toFixed(2),positive:isOver});
          }
        }

        const confidence = Math.min(85,Math.max(20,Math.round(totalStatScore*0.7+(50+Math.min(15,tEdge.edge*2))*0.3)));
        const units = kellyUnits(ev, tEdge.avgProb, fmtOdds(out.price));
        picks.push({
          sport, game:`${away} @ ${home}`, gameId:game.id,
          team:`${out.name} ${out.point}`, betType:'Total',
          selection:`${out.name} ${out.point}`, bestOdds:fmtOdds(out.price),
          edge:tEdge.edge.toFixed(1), confidence, ev:ev.toFixed(1), units,
          commence:game.commence_time, statsAvailable:!!(homeStats&&awayStats),
          factors:totalFactors.slice(0,5), lineMovement:null, warnings:null
        });
      }
    }
  }

  picks.sort((a,b)=>b.confidence-a.confidence);
  setCache(`picks_${sport}`, picks, 10*60*1000);
  return picks;
}

// ── PLAYER PROPS ──
async function fetchProps(sport) {
  const cacheKey = `props_${sport}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const sportKey = SPORT_KEYS[sport];
  const propMarkets = {
    mlb: 'batter_hits,batter_total_bases,pitcher_strikeouts,batter_rbis,batter_home_runs',
    nba: 'player_points,player_rebounds,player_assists,player_threes,player_blocks_steals',
    nhl: 'player_points,player_goals,player_assists,player_shots_on_goal'
  }[sport];
  if (!propMarkets) return [];

  try {
    const url = `${ODDS_BASE}/sports/${sportKey}/events`;
    const eventsRes = await fetch(`${url}?apiKey=${ODDS_API_KEY}&dateFormat=iso`);
    const events = await eventsRes.json();
    if (!Array.isArray(events)||!events.length) return [];

    const todayEvents = events.slice(0,8); // limit API calls
    const allProps = [];

    for (const event of todayEvents) {
      try {
        const propUrl = `${ODDS_BASE}/sports/${sportKey}/events/${event.id}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${propMarkets}&oddsFormat=american`;
        const propRes = await fetch(propUrl);
        const propData = await propRes.json();
        if (!propData.bookmakers?.length) continue;

        const fanduel = propData.bookmakers.find(b=>b.key==='fanduel')||propData.bookmakers[0];
        fanduel?.markets?.forEach(market => {
          market.outcomes?.forEach(outcome => {
            const allPrices = [];
            propData.bookmakers.forEach(bm => {
              const bMarket = bm.markets?.find(m=>m.key===market.key);
              const bOut = bMarket?.outcomes?.find(o=>o.name===outcome.name&&o.description===outcome.description&&o.point===outcome.point);
              if (bOut) allPrices.push(bOut.price);
            });
            const bestOdds = allPrices.length?Math.max(...allPrices):outcome.price;
            const avgProb = allPrices.length?(allPrices.map(p=>impliedProb(p)).reduce((a,b)=>a+b,0)/allPrices.length):impliedProb(outcome.price);
            const edge = allPrices.length>=2?((avgProb-impliedProb(bestOdds))/avgProb)*100:0;

            if (oddsPassesFilter(bestOdds)) {
              allProps.push({
                sport, game:`${event.away_team} @ ${event.home_team}`,
                player:outcome.description||outcome.name,
                market:market.key, marketLabel:market.key.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()),
                line:outcome.point, side:outcome.name,
                bestOdds:fmtOdds(bestOdds), edge:edge.toFixed(1),
                commence:event.commence_time,
                ev:((avgProb*toDecimal(bestOdds))-1)*100
              });
            }
          });
        });
      } catch { continue; }
    }

    setCache(cacheKey, allProps, 15*60*1000);
    return allProps;
  } catch (err) { console.error('Props error:', err.message); return []; }
}

// ── PARLAY SUGGESTIONS ──
function buildBestParlay(picks) {
  const eligible = picks.filter(p=>parseFloat(p.ev)>0&&oddsPassesFilter(parseFloat(String(p.bestOdds).replace('+','')))&&p.confidence>=52);
  const chosen = [];
  const usedGames = new Set();
  for (const pick of eligible) {
    if (usedGames.has(pick.game)) continue;
    chosen.push(pick);
    usedGames.add(pick.game);
    if (chosen.length===3) break;
  }
  if (chosen.length<2) return null;
  const combinedDecimal = chosen.reduce((acc,p)=>acc*toDecimal(p.bestOdds),1);
  const combinedAmerican = combinedDecimal>=2?Math.round((combinedDecimal-1)*100):Math.round(-100/(combinedDecimal-1));
  return {
    legs:chosen.map(p=>({game:p.game,selection:p.selection,betType:p.betType,odds:p.bestOdds,confidence:p.confidence,sport:p.sport,factors:(p.factors||[]).slice(0,2)})),
    combinedOdds:combinedAmerican>0?`+${combinedAmerican}`:`${combinedAmerican}`,
    impliedProb:(1/combinedDecimal*100).toFixed(1),
    payoutPer100:((combinedDecimal-1)*100).toFixed(2),
    avgConfidence:Math.round(chosen.reduce((a,p)=>a+p.confidence,0)/chosen.length)
  };
}

// ── TRACK RECORD STATS ──
async function getTrackRecord() {
  try {
    const result = await pool.query(`
      SELECT
        sport, bet_type, result,
        CASE
          WHEN confidence_tier IS NULL THEN 'unknown'
          ELSE confidence_tier
        END as tier,
        COUNT(*) as count,
        COALESCE(SUM(stake),0) as total_staked
      FROM bets
      WHERE result != 'pending'
      GROUP BY sport, bet_type, result, confidence_tier
    `);
    return result.rows;
  } catch {
    // confidence_tier column may not exist yet — add it
    try {
      await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS confidence_tier TEXT`);
    } catch {}
    return [];
  }
}

// ── ENDPOINTS ──

// Track API credits from response headers
let lastCreditsUsed = null;
let lastCreditsRemaining = null;

app.get('/api/credits', (req, res) => {
  res.json({
    used: lastCreditsUsed,
    remaining: lastCreditsRemaining,
    total: lastCreditsUsed !== null && lastCreditsRemaining !== null
      ? lastCreditsUsed + lastCreditsRemaining
      : 500
  });
});

app.get('/api/odds/:sport', async (req, res) => {
  const sport = req.params.sport.toLowerCase();
  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) return res.status(400).json({error:'Invalid sport'});
  const cached = getCache(`odds_${sport}`);
  if (cached) return res.json(cached);
  try {
    const url = `${ODDS_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso`;
    const response = await fetch(url);
    // Track credits
    const used = response.headers.get('x-requests-used');
    const remaining = response.headers.get('x-requests-remaining');
    if (used) lastCreditsUsed = parseInt(used);
    if (remaining) lastCreditsRemaining = parseInt(remaining);
    const data = await response.json();
    if (!Array.isArray(data)) return res.json({games:[],message:data.message||'No games available'});
    const games = data.map(game=>{
      const fanduel = game.bookmakers?.find(b=>b.key==='fanduel')||game.bookmakers?.[0];
      const markets = {};
      fanduel?.markets?.forEach(m=>{markets[m.key]=m.outcomes;});
      return {id:game.id,sport,home:game.home_team,away:game.away_team,commence:game.commence_time,bookmaker:fanduel?.title||'N/A',h2h:markets['h2h']||[],spreads:markets['spreads']||[],totals:markets['totals']||[]};
    });
    const result = {games};
    setCache(`odds_${sport}`, result);
    res.json(result);
  } catch (err) { res.status(500).json({error:'Failed to fetch odds'}); }
});

app.get('/api/picks/all', async (req, res) => {
  try {
    const [mlb,nba,nhl] = await Promise.all([
      buildPicks('mlb').catch(()=>[]),
      buildPicks('nba').catch(()=>[]),
      buildPicks('nhl').catch(()=>[])
    ]);
    const all = [...mlb,...nba,...nhl].sort((a,b)=>b.confidence-a.confidence);
    res.json({overall:{top5:all.slice(0,5),all},mlb:{top5:mlb.slice(0,5),all:mlb},nba:{top5:nba.slice(0,5),all:nba},nhl:{top5:nhl.slice(0,5),all:nhl}});
  } catch (err) { res.status(500).json({error:'Failed to generate picks'}); }
});

app.get('/api/parlays/suggested', async (req, res) => {
  try {
    const [mlb,nba,nhl] = await Promise.all([
      buildPicks('mlb').catch(()=>[]),
      buildPicks('nba').catch(()=>[]),
      buildPicks('nhl').catch(()=>[])
    ]);
    const all = [...mlb,...nba,...nhl].sort((a,b)=>b.confidence-a.confidence);
    res.json({overall:buildBestParlay(all),mlb:buildBestParlay(mlb),nba:buildBestParlay(nba),nhl:buildBestParlay(nhl)});
  } catch (err) { res.status(500).json({error:'Failed to generate parlays'}); }
});

app.get('/api/props/:sport', async (req, res) => {
  const sport = req.params.sport.toLowerCase();
  if (!['mlb','nba','nhl'].includes(sport)) return res.status(400).json({error:'Invalid sport'});
  try {
    const props = await fetchProps(sport);
    res.json({props});
  } catch (err) { res.status(500).json({error:'Failed to fetch props'}); }
});

app.post('/api/parlay', (req, res) => {
  const {legs} = req.body;
  if (!legs||legs.length<2||legs.length>3) return res.status(400).json({error:'Parlay requires 2-3 legs'});
  const combinedDecimal = legs.reduce((acc,leg)=>acc*toDecimal(leg.odds),1);
  const combinedAmerican = combinedDecimal>=2?Math.round((combinedDecimal-1)*100):Math.round(-100/(combinedDecimal-1));
  res.json({legs,combinedOdds:combinedAmerican>0?`+${combinedAmerican}`:`${combinedAmerican}`,impliedProb:(1/combinedDecimal*100).toFixed(1),payoutPer100:((combinedDecimal-1)*100).toFixed(2)});
});

app.get('/api/bets', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM bets ORDER BY created_at DESC'); res.json({bets:r.rows}); }
  catch (err) { res.status(500).json({error:'Failed to fetch bets'}); }
});

app.post('/api/bets', async (req, res) => {
  const {sport,game,bet_type,selection,odds,stake,notes,confidence_tier} = req.body;
  if (!sport||!game||!bet_type||!selection||!odds) return res.status(400).json({error:'Missing required fields'});
  try {
    const r = await pool.query(
      'INSERT INTO bets (sport,game,bet_type,selection,odds,stake,notes,confidence_tier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [sport,game,bet_type,selection,odds,stake||null,notes||null,confidence_tier||null]
    );
    res.json({bet:r.rows[0]});
  } catch (err) {
    // Fallback without confidence_tier if column doesn't exist yet
    try {
      const r = await pool.query('INSERT INTO bets (sport,game,bet_type,selection,odds,stake,notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',[sport,game,bet_type,selection,odds,stake||null,notes||null]);
      res.json({bet:r.rows[0]});
    } catch (err2) { res.status(500).json({error:'Failed to log bet'}); }
  }
});

app.patch('/api/bets/:id', async (req, res) => {
  const {result} = req.body;
  if (!['win','loss','push','pending'].includes(result)) return res.status(400).json({error:'Invalid result'});
  try { const r = await pool.query('UPDATE bets SET result=$1 WHERE id=$2 RETURNING *',[result,req.params.id]); res.json({bet:r.rows[0]}); }
  catch (err) { res.status(500).json({error:'Failed to update'}); }
});

app.delete('/api/bets/:id', async (req, res) => {
  try { await pool.query('DELETE FROM bets WHERE id=$1',[req.params.id]); res.json({success:true}); }
  catch (err) { res.status(500).json({error:'Failed to delete'}); }
});

app.get('/api/bets/stats', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE result='win') as wins,
        COUNT(*) FILTER (WHERE result='loss') as losses,
        COUNT(*) FILTER (WHERE result='push') as pushes,
        COUNT(*) FILTER (WHERE result='pending') as pending,
        COALESCE(SUM(stake),0) as total_staked,
        COALESCE(SUM(stake) FILTER (WHERE result='win'),0) as won_staked,
        COALESCE(SUM(stake) FILTER (WHERE result='loss'),0) as lost_staked
      FROM bets
    `);
    // Per sport breakdown
    const bySport = await pool.query(`
      SELECT sport,
        COUNT(*) FILTER (WHERE result='win') as wins,
        COUNT(*) FILTER (WHERE result='loss') as losses,
        COUNT(*) FILTER (WHERE result!='pending') as settled
      FROM bets GROUP BY sport
    `);
    // Per bet type
    const byType = await pool.query(`
      SELECT bet_type,
        COUNT(*) FILTER (WHERE result='win') as wins,
        COUNT(*) FILTER (WHERE result='loss') as losses,
        COUNT(*) FILTER (WHERE result!='pending') as settled
      FROM bets GROUP BY bet_type
    `);
    res.json({...r.rows[0], bySport:bySport.rows, byType:byType.rows});
  } catch (err) { res.status(500).json({error:'Failed to get stats'}); }
});

app.listen(PORT, () => console.log(`Edge Pro running on port ${PORT}`));

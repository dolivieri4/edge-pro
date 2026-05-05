const express = require('express');
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database table
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

// Get odds for a sport
app.get('/api/odds/:sport', async (req, res) => {
  const sport = req.params.sport.toLowerCase();
  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) return res.status(400).json({ error: 'Invalid sport' });

  try {
    const url = `${ODDS_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso`;
    const response = await fetch(url);
    const data = await response.json();

    if (!Array.isArray(data)) {
      return res.json({ games: [], message: data.message || 'No games available' });
    }

    const games = data.map(game => {
      const fanduel = game.bookmakers?.find(b => b.key === 'fanduel') || game.bookmakers?.[0];
      const markets = {};

      fanduel?.markets?.forEach(m => {
        markets[m.key] = m.outcomes;
      });

      return {
        id: game.id,
        sport,
        home: game.home_team,
        away: game.away_team,
        commence: game.commence_time,
        bookmaker: fanduel?.title || 'N/A',
        h2h: markets['h2h'] || [],
        spreads: markets['spreads'] || [],
        totals: markets['totals'] || []
      };
    });

    res.json({ games });
  } catch (err) {
    console.error('Odds fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch odds' });
  }
});

// Get value picks (edges where implied prob differs from fair value estimate)
app.get('/api/value/:sport', async (req, res) => {
  const sport = req.params.sport.toLowerCase();
  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) return res.status(400).json({ error: 'Invalid sport' });

  try {
    const url = `${ODDS_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american&dateFormat=iso`;
    const response = await fetch(url);
    const data = await response.json();

    if (!Array.isArray(data)) return res.json({ picks: [] });

    const picks = [];

    data.forEach(game => {
      const bookmakerOdds = {};

      game.bookmakers?.forEach(bm => {
        const h2h = bm.markets?.find(m => m.key === 'h2h');
        if (h2h) {
          h2h.outcomes.forEach(o => {
            if (!bookmakerOdds[o.name]) bookmakerOdds[o.name] = [];
            bookmakerOdds[o.name].push(o.price);
          });
        }
      });

      Object.entries(bookmakerOdds).forEach(([team, prices]) => {
        if (prices.length < 2) return;

        const toDecimal = p => p > 0 ? (p / 100) + 1 : (100 / Math.abs(p)) + 1;
        const impliedProbs = prices.map(p => 1 / toDecimal(p));
        const avgProb = impliedProbs.reduce((a, b) => a + b, 0) / impliedProbs.length;
        const bestPrice = Math.max(...prices);
        const bestDecimal = toDecimal(bestPrice);
        const bestImplied = 1 / bestDecimal;
        const edge = ((avgProb - bestImplied) / bestImplied) * 100;

        if (edge > 2) {
          picks.push({
            sport,
            game: `${game.away_team} @ ${game.home_team}`,
            team,
            bestOdds: bestPrice > 0 ? `+${bestPrice}` : `${bestPrice}`,
            edge: edge.toFixed(1),
            commence: game.commence_time
          });
        }
      });
    });

    picks.sort((a, b) => parseFloat(b.edge) - parseFloat(a.edge));
    res.json({ picks: picks.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate value picks' });
  }
});

// Parlay calculator
app.post('/api/parlay', (req, res) => {
  const { legs } = req.body;
  if (!legs || legs.length < 2 || legs.length > 3) {
    return res.status(400).json({ error: 'Parlay requires 2-3 legs' });
  }

  const toDecimal = p => {
    const n = parseFloat(p);
    return n > 0 ? (n / 100) + 1 : (100 / Math.abs(n)) + 1;
  };

  const combinedDecimal = legs.reduce((acc, leg) => acc * toDecimal(leg.odds), 1);
  const combinedAmerican = combinedDecimal >= 2
    ? Math.round((combinedDecimal - 1) * 100)
    : Math.round(-100 / (combinedDecimal - 1));

  const impliedProb = (1 / combinedDecimal * 100).toFixed(1);

  res.json({
    legs,
    combinedOdds: combinedAmerican > 0 ? `+${combinedAmerican}` : `${combinedAmerican}`,
    impliedProb,
    payoutPer100: ((combinedDecimal - 1) * 100).toFixed(2)
  });
});

// Bet logger routes
app.get('/api/bets', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bets ORDER BY created_at DESC');
    res.json({ bets: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
});

app.post('/api/bets', async (req, res) => {
  const { sport, game, bet_type, selection, odds, stake, notes } = req.body;
  if (!sport || !game || !bet_type || !selection || !odds) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO bets (sport, game, bet_type, selection, odds, stake, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [sport, game, bet_type, selection, odds, stake || null, notes || null]
    );
    res.json({ bet: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to log bet' });
  }
});

app.patch('/api/bets/:id', async (req, res) => {
  const { result } = req.body;
  if (!['win', 'loss', 'push', 'pending'].includes(result)) {
    return res.status(400).json({ error: 'Invalid result' });
  }
  try {
    const r = await pool.query(
      'UPDATE bets SET result = $1 WHERE id = $2 RETURNING *',
      [result, req.params.id]
    );
    res.json({ bet: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update bet' });
  }
});

app.delete('/api/bets/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bets WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete bet' });
  }
});

// Bet stats
app.get('/api/bets/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE result = 'win') as wins,
        COUNT(*) FILTER (WHERE result = 'loss') as losses,
        COUNT(*) FILTER (WHERE result = 'push') as pushes,
        COUNT(*) FILTER (WHERE result = 'pending') as pending,
        COALESCE(SUM(stake) FILTER (WHERE result = 'win'), 0) as total_staked_wins,
        COALESCE(SUM(stake), 0) as total_staked
      FROM bets
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.listen(PORT, () => console.log(`Edge Pro running on port ${PORT}`));

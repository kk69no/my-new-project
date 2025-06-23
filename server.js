require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.NEON_DB_URL,
});

app.post('/user', async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });
  try {
    const client = await pool.connect();
    let result = await client.query('SELECT id FROM users WHERE telegram_id = $1', [telegram_id]);
    if (result.rows.length === 0) {
      result = await client.query('INSERT INTO users (telegram_id) VALUES ($1) RETURNING id', [telegram_id]);
    }
    client.release();
    res.json({ user_id: result.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/circles/:user_id', async (req, res) => {
  const user_id = req.params.user_id;
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT * FROM circles WHERE user_id = $1 ORDER BY created_at DESC', [user_id]);
    client.release();
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/circle', async (req, res) => {
  const { user_id, currency, buy_rub, buy_price } = req.body;
  if (!user_id || !currency || !buy_rub || !buy_price) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const buy_qty = buy_rub / buy_price;
    const client = await pool.connect();
    const result = await client.query(
      `INSERT INTO circles (user_id, currency, buy_rub, buy_price, buy_qty, remaining_qty, sell_qty, sell_rub, closed) 
       VALUES ($1,$2,$3,$4,$5,$5,0,0,false) RETURNING *`,
      [user_id, currency, buy_rub, buy_price, buy_qty]
    );
    client.release();
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/circle/:circle_id/sell', async (req, res) => {
  const circle_id = req.params.circle_id;
  const { qty, price, rub, note } = req.body;
  if (!qty || !price || !rub) return res.status(400).json({ error: 'Missing sell data' });
  try {
    const client = await pool.connect();
    const circleRes = await client.query('SELECT * FROM circles WHERE id = $1', [circle_id]);
    if (circleRes.rows.length === 0) {
      client.release();
      return res.status(404).json({ error: 'Circle not found' });
    }
    const circle = circleRes.rows[0];
    if (circle.closed) {
      client.release();
      return res.status(400).json({ error: 'Circle is closed' });
    }
    if (qty > circle.remaining_qty) {
      client.release();
      return res.status(400).json({ error: 'Sell qty exceeds remaining qty' });
    }

    await client.query(
      'INSERT INTO sells (circle_id, qty, price, rub, note) VALUES ($1, $2, $3, $4, $5)',
      [circle_id, qty, price, rub, note || '']
    );

    const newRemaining = circle.remaining_qty - qty;
    const newSellQty = circle.sell_qty + qty;
    const newSellRub = parseFloat(circle.sell_rub) + parseFloat(rub);
    const closed = newRemaining <= 0;

    await client.query(
      'UPDATE circles SET remaining_qty=$1, sell_qty=$2, sell_rub=$3, closed=$4 WHERE id=$5',
      [newRemaining, newSellQty, newSellRub, closed, circle_id]
    );

    client.release();
    res.json({ message: 'Sell added', closed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/circle/:circle_id', async (req, res) => {
  const circle_id = req.params.circle_id;
  try {
    const client = await pool.connect();
    await client.query('DELETE FROM sells WHERE circle_id = $1', [circle_id]);
    await client.query('DELETE FROM circles WHERE id = $1', [circle_id]);
    client.release();
    res.json({ message: 'Circle deleted' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const redis = require('redis');
const Joi = require('joi');
const winston = require('winston');

const app = express();
const PORT = process.env.PORT || 3002;

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'banking_accounts',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password'
});

// Redis connection
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});
redisClient.connect();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Validation schemas
const createAccountSchema = Joi.object({
  accountType: Joi.string().valid('checking', 'savings').required(),
  initialDeposit: Joi.number().min(0).default(0)
});

// JWT middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-jwt-secret', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Generate account number
const generateAccountNumber = () => {
  return Math.floor(Math.random() * 9000000000) + 1000000000;
};

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'account-service' });
});

// Create account
app.post('/', authenticateToken, async (req, res) => {
  try {
    const { error, value } = createAccountSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { accountType, initialDeposit } = value;
    const accountNumber = generateAccountNumber().toString();

    const result = await pool.query(
      'INSERT INTO accounts (user_id, account_number, account_type, balance) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.userId, accountNumber, accountType, initialDeposit]
    );

    const account = result.rows[0];
    
    // Cache account data
    await redisClient.setEx(`account:${account.id}`, 3600, JSON.stringify(account));

    logger.info(`Account created: ${account.account_number} for user ${req.user.userId}`);

    res.status(201).json({
      message: 'Account created successfully',
      account: {
        id: account.id,
        accountNumber: account.account_number,
        accountType: account.account_type,
        balance: parseFloat(account.balance),
        currency: account.currency,
        status: account.status,
        createdAt: account.created_at
      }
    });
  } catch (error) {
    logger.error(`Account creation error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user accounts
app.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM accounts WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.userId]
    );

    const accounts = result.rows.map(account => ({
      id: account.id,
      accountNumber: account.account_number,
      accountType: account.account_type,
      balance: parseFloat(account.balance),
      currency: account.currency,
      status: account.status,
      createdAt: account.created_at,
      updatedAt: account.updated_at
    }));

    res.json({ accounts });
  } catch (error) {
    logger.error(`Get accounts error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get account by ID
app.get('/:accountId', authenticateToken, async (req, res) => {
  try {
    const { accountId } = req.params;

    // Try cache first
    const cachedAccount = await redisClient.get(`account:${accountId}`);
    if (cachedAccount) {
      const account = JSON.parse(cachedAccount);
      if (account.user_id === req.user.userId) {
        return res.json({
          account: {
            id: account.id,
            accountNumber: account.account_number,
            accountType: account.account_type,
            balance: parseFloat(account.balance),
            currency: account.currency,
            status: account.status,
            createdAt: account.created_at,
            updatedAt: account.updated_at
          }
        });
      }
    }

    // Get from database
    const result = await pool.query(
      'SELECT * FROM accounts WHERE id = $1 AND user_id = $2',
      [accountId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = result.rows[0];

    // Update cache
    await redisClient.setEx(`account:${account.id}`, 3600, JSON.stringify(account));

    res.json({
      account: {
        id: account.id,
        accountNumber: account.account_number,
        accountType: account.account_type,
        balance: parseFloat(account.balance),
        currency: account.currency,
        status: account.status,
        createdAt: account.created_at,
        updatedAt: account.updated_at
      }
    });
  } catch (error) {
    logger.error(`Get account error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get account balance
app.get('/:accountId/balance', authenticateToken, async (req, res) => {
  try {
    const { accountId } = req.params;

    const result = await pool.query(
      'SELECT balance, currency FROM accounts WHERE id = $1 AND user_id = $2',
      [accountId, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = result.rows[0];

    res.json({
      balance: parseFloat(account.balance),
      currency: account.currency
    });
  } catch (error) {
    logger.error(`Get balance error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(`Error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info(`Account Service running on port ${PORT}`);
});
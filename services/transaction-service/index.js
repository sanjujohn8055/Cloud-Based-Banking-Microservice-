const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const amqp = require('amqplib');
const Joi = require('joi');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
const Decimal = require('decimal.js');

const app = express();
const PORT = process.env.PORT || 3003;

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'transaction-service.log' })
  ]
});

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'banking_transactions',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password'
});

// RabbitMQ connection
let channel;
const connectRabbitMQ = async () => {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost:5672');
    channel = await connection.createChannel();
    
    // Declare exchanges and queues
    await channel.assertExchange('banking.events', 'topic', { durable: true });
    await channel.assertQueue('transaction.events', { durable: true });
    await channel.assertQueue('account.updates', { durable: true });
    
    logger.info('Connected to RabbitMQ');
  } catch (error) {
    logger.error(`RabbitMQ connection error: ${error.message}`);
    setTimeout(connectRabbitMQ, 5000);
  }
};

connectRabbitMQ();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Validation schemas
const transactionSchema = Joi.object({
  accountId: Joi.number().integer().positive().required(),
  amount: Joi.number().positive().precision(2).required(),
  type: Joi.string().valid('debit', 'credit').required(),
  description: Joi.string().max(255).required(),
  referenceId: Joi.string().optional()
});

const transferSchema = Joi.object({
  fromAccountId: Joi.number().integer().positive().required(),
  toAccountId: Joi.number().integer().positive().required(),
  amount: Joi.number().positive().precision(2).required(),
  description: Joi.string().max(255).required()
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

// Event publishing
const publishEvent = async (eventType, data) => {
  if (channel) {
    const event = {
      id: uuidv4(),
      type: eventType,
      timestamp: new Date().toISOString(),
      data
    };
    
    await channel.publish('banking.events', eventType, Buffer.from(JSON.stringify(event)));
    logger.info(`Event published: ${eventType}`, { eventId: event.id });
  }
};

// Account balance verification (simulate call to account service)
const verifyAccountBalance = async (accountId, amount, type) => {
  // In a real implementation, this would call the account service
  // For now, we'll simulate it with a database query
  try {
    const result = await pool.query(
      'SELECT balance FROM account_balances WHERE account_id = $1',
      [accountId]
    );
    
    if (result.rows.length === 0) {
      return { valid: false, error: 'Account not found' };
    }
    
    const currentBalance = new Decimal(result.rows[0].balance);
    const transactionAmount = new Decimal(amount);
    
    if (type === 'debit' && currentBalance.lt(transactionAmount)) {
      return { valid: false, error: 'Insufficient funds' };
    }
    
    return { valid: true, currentBalance: currentBalance.toNumber() };
  } catch (error) {
    logger.error(`Balance verification error: ${error.message}`);
    return { valid: false, error: 'Balance verification failed' };
  }
};

// Routes
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'transaction-service',
    timestamp: new Date().toISOString()
  });
});

// Create transaction
app.post('/', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { error, value } = transactionSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { accountId, amount, type, description, referenceId } = value;
    const transactionId = uuidv4();

    // Verify account ownership (simplified - in real app, call account service)
    const ownershipCheck = await client.query(
      'SELECT user_id FROM account_ownership WHERE account_id = $1 AND user_id = $2',
      [accountId, req.user.userId]
    );

    if (ownershipCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Account access denied' });
    }

    // Verify balance for debit transactions
    if (type === 'debit') {
      const balanceCheck = await verifyAccountBalance(accountId, amount, type);
      if (!balanceCheck.valid) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: balanceCheck.error });
      }
    }

    // Create transaction record
    const result = await client.query(
      `INSERT INTO transactions 
       (id, account_id, transaction_type, amount, description, reference_id, status, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', NOW()) 
       RETURNING *`,
      [transactionId, accountId, type, amount, description, referenceId]
    );

    const transaction = result.rows[0];

    // Update account balance
    const balanceUpdate = type === 'credit' ? amount : -amount;
    await client.query(
      `INSERT INTO account_balances (account_id, balance) 
       VALUES ($1, $2) 
       ON CONFLICT (account_id) 
       DO UPDATE SET balance = account_balances.balance + $2, updated_at = NOW()`,
      [accountId, balanceUpdate]
    );

    await client.query('COMMIT');

    // Publish transaction event
    await publishEvent('transaction.created', {
      transactionId: transaction.id,
      accountId: transaction.account_id,
      amount: parseFloat(transaction.amount),
      type: transaction.transaction_type,
      userId: req.user.userId
    });

    logger.info(`Transaction created: ${transaction.id}`, {
      userId: req.user.userId,
      accountId,
      amount,
      type
    });

    res.status(201).json({
      message: 'Transaction completed successfully',
      transaction: {
        id: transaction.id,
        accountId: transaction.account_id,
        type: transaction.transaction_type,
        amount: parseFloat(transaction.amount),
        description: transaction.description,
        referenceId: transaction.reference_id,
        status: transaction.status,
        createdAt: transaction.created_at
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Transaction error: ${error.message}`);
    res.status(500).json({ error: 'Transaction failed' });
  } finally {
    client.release();
  }
});

// Transfer between accounts
app.post('/transfer', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { error, value } = transferSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { fromAccountId, toAccountId, amount, description } = value;
    const transferId = uuidv4();

    // Verify source account ownership
    const ownershipCheck = await client.query(
      'SELECT user_id FROM account_ownership WHERE account_id = $1 AND user_id = $2',
      [fromAccountId, req.user.userId]
    );

    if (ownershipCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Source account access denied' });
    }

    // Verify sufficient balance
    const balanceCheck = await verifyAccountBalance(fromAccountId, amount, 'debit');
    if (!balanceCheck.valid) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: balanceCheck.error });
    }

    // Create debit transaction
    const debitResult = await client.query(
      `INSERT INTO transactions 
       (id, account_id, transaction_type, amount, description, reference_id, status, created_at) 
       VALUES ($1, $2, 'debit', $3, $4, $5, 'completed', NOW()) 
       RETURNING *`,
      [uuidv4(), fromAccountId, amount, `Transfer: ${description}`, transferId]
    );

    // Create credit transaction
    const creditResult = await client.query(
      `INSERT INTO transactions 
       (id, account_id, transaction_type, amount, description, reference_id, status, created_at) 
       VALUES ($1, $2, 'credit', $3, $4, $5, 'completed', NOW()) 
       RETURNING *`,
      [uuidv4(), toAccountId, amount, `Transfer received: ${description}`, transferId]
    );

    // Update balances
    await client.query(
      `INSERT INTO account_balances (account_id, balance) 
       VALUES ($1, $2) 
       ON CONFLICT (account_id) 
       DO UPDATE SET balance = account_balances.balance - $2, updated_at = NOW()`,
      [fromAccountId, amount]
    );

    await client.query(
      `INSERT INTO account_balances (account_id, balance) 
       VALUES ($1, $2) 
       ON CONFLICT (account_id) 
       DO UPDATE SET balance = account_balances.balance + $2, updated_at = NOW()`,
      [toAccountId, amount]
    );

    await client.query('COMMIT');

    // Publish transfer event
    await publishEvent('transfer.completed', {
      transferId,
      fromAccountId,
      toAccountId,
      amount: parseFloat(amount),
      userId: req.user.userId
    });

    logger.info(`Transfer completed: ${transferId}`, {
      userId: req.user.userId,
      fromAccountId,
      toAccountId,
      amount
    });

    res.status(201).json({
      message: 'Transfer completed successfully',
      transfer: {
        id: transferId,
        fromAccountId,
        toAccountId,
        amount: parseFloat(amount),
        description,
        debitTransaction: debitResult.rows[0],
        creditTransaction: creditResult.rows[0]
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Transfer error: ${error.message}`);
    res.status(500).json({ error: 'Transfer failed' });
  } finally {
    client.release();
  }
});

// Get transaction history
app.get('/history/:accountId', authenticateToken, async (req, res) => {
  try {
    const { accountId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    // Verify account ownership
    const ownershipCheck = await pool.query(
      'SELECT user_id FROM account_ownership WHERE account_id = $1 AND user_id = $2',
      [accountId, req.user.userId]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Account access denied' });
    }

    const result = await pool.query(
      `SELECT * FROM transactions 
       WHERE account_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [accountId, limit, offset]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM transactions WHERE account_id = $1',
      [accountId]
    );

    const transactions = result.rows.map(tx => ({
      id: tx.id,
      accountId: tx.account_id,
      type: tx.transaction_type,
      amount: parseFloat(tx.amount),
      description: tx.description,
      referenceId: tx.reference_id,
      status: tx.status,
      createdAt: tx.created_at
    }));

    res.json({
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(countResult.rows[0].count / limit)
      }
    });

  } catch (error) {
    logger.error(`Get history error: ${error.message}`);
    res.status(500).json({ error: 'Failed to retrieve transaction history' });
  }
});

// Error handler
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info(`Transaction Service running on port ${PORT}`);
});
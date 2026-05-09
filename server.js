```javascript
// ═══════════════════════════════════════════════════════════════
//  ConciliaML — Backend Node.js + MySQL
//  Instalar:
//  npm install express mysql2 bcryptjs jsonwebtoken cors dotenv multer xlsx
//
//  Rodar:
//  node server.js
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const app = express();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'concilia_secret_2024';

app.use(cors({
  origin: '*',
  credentials: true
}));

app.use(express.json({
  limit: '50mb'
}));

app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

// ═══════════════════════════════════════════════════════════════
// MYSQL POOL
// ═══════════════════════════════════════════════════════════════

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  connectTimeout: 20000,

  ssl: {
    rejectUnauthorized: false
  },

  charset: 'utf8mb4'
});

// ═══════════════════════════════════════════════════════════════
// INIT DATABASE
// ═══════════════════════════════════════════════════════════════

async function initDB() {

  const c = await pool.getConnection();

  try {

    console.log('🔌 Conectado ao MySQL');

    // ───────────────────────────────────────────────────────────
    // USUÁRIOS
    // ───────────────────────────────────────────────────────────

    await c.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id            VARCHAR(64) PRIMARY KEY,
        username      VARCHAR(64) UNIQUE NOT NULL,
        password      VARCHAR(255) NOT NULL,
        nome          VARCHAR(128),
        role          ENUM('master','user') DEFAULT 'user',
        ativo         TINYINT(1) DEFAULT 1,
        criado_em     DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ───────────────────────────────────────────────────────────
    // MESES
    // ───────────────────────────────────────────────────────────

    await c.query(`
      CREATE TABLE IF NOT EXISTS meses (
        arquivo_id        VARCHAR(128) PRIMARY KEY,
        periodo           VARCHAR(64) NOT NULL,

        stats             JSON,
        pedidos           LONGTEXT,
        tarifas_ml        LONGTEXT,
        tarifas_mp        LONGTEXT,
        pagamentos        LONGTEXT,
        det_pagamentos    LONGTEXT,

        tarifas_por_tipo JSON,
        divergencias      JSON,
        produtos          JSON,

        importado_em      DATETIME DEFAULT CURRENT_TIMESTAMP,
        importado_por     VARCHAR(64),

        saldo_anterior    DECIMAL(15,2) DEFAULT 0,
        saldo_conciliado  TINYINT(1) DEFAULT 0

      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ───────────────────────────────────────────────────────────
    // CUSTOS
    // ───────────────────────────────────────────────────────────

    await c.query(`
      CREATE TABLE IF NOT EXISTS custos (
        mlb           VARCHAR(64) PRIMARY KEY,
        custo         DECIMAL(15,4) NOT NULL,
        atualizado    DATETIME DEFAULT CURRENT_TIMESTAMP
                      ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ───────────────────────────────────────────────────────────
    // BACKUPS
    // ───────────────────────────────────────────────────────────

    await c.query(`
      CREATE TABLE IF NOT EXISTS backups (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        ts            DATETIME DEFAULT CURRENT_TIMESTAMP,
        tipo          VARCHAR(32),
        tamanho       INT,
        periodos      JSON,
        criado_por    VARCHAR(64)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ───────────────────────────────────────────────────────────
    // CRIAR MASTER
    // ───────────────────────────────────────────────────────────

    const [rows] = await c.query(`
      SELECT id
      FROM usuarios
      WHERE id = 'master'
    `);

    if (!rows.length) {

      const hash = await bcrypt.hash('Admin@2024', 10);

      await c.query(`
        INSERT INTO usuarios
        (id, username, password, nome, role, ativo)
        VALUES
        ('master', 'admin', ?, 'Administrador', 'master', 1)
      `, [hash]);

      console.log('✅ Usuário master criado');
      console.log('👤 Login: admin');
      console.log('🔑 Senha: Admin@2024');
    }

    console.log('✅ Banco inicializado');

  } finally {
    c.release();
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function safeJSON(v) {

  if (!v) return null;

  if (typeof v === 'object') {
    return v;
  }

  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function toJS(v) {

  if (!v) return null;

  if (typeof v === 'string') {
    return v;
  }

  return JSON.stringify(v);
}

// ═══════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

function auth(req, res, next) {

  const h = req.headers.authorization;

  if (!h) {
    return res.status(401).json({
      error: 'Token ausente'
    });
  }

  try {

    req.user = jwt.verify(
      h.replace('Bearer ', ''),
      JWT_SECRET
    );

    next();

  } catch {

    return res.status(401).json({
      error: 'Token inválido'
    });
  }
}

function master(req, res, next) {

  if (req.user.role !== 'master') {

    return res.status(403).json({
      error: 'Acesso negado'
    });
  }

  next();
}

// ═══════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════

app.post('/api/login', async (req, res) => {

  try {

    const {
      username,
      password
    } = req.body;

    const [rows] = await pool.query(`
      SELECT *
      FROM usuarios
      WHERE username = ?
      AND ativo = 1
    `, [username]);

    if (!rows.length) {

      return res.status(401).json({
        error: 'Usuário ou senha inválidos'
      });
    }

    const u = rows[0];

    const ok = await bcrypt.compare(
      password,
      u.password
    );

    if (!ok) {

      return res.status(401).json({
        error: 'Usuário ou senha inválidos'
      });
    }

    const token = jwt.sign({
      id: u.id,
      username: u.username,
      nome: u.nome,
      role: u.role
    },
    JWT_SECRET,
    {
      expiresIn: '12h'
    });

    res.json({
      token,
      user: {
        id: u.id,
        username: u.username,
        nome: u.nome,
        role: u.role
      }
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// HEALTHCHECK
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {

  res.json({
    ok: true,
    app: 'ConciliaML',
    status: 'online'
  });
});

// ═══════════════════════════════════════════════════════════════
// MESES
// ═══════════════════════════════════════════════════════════════

app.get('/api/meses', auth, async (req, res) => {

  try {

    const [rows] = await pool.query(`
      SELECT
        arquivo_id,
        periodo,
        stats,
        produtos,
        tarifas_por_tipo,
        divergencias,
        importado_em,
        importado_por,
        saldo_anterior,
        saldo_conciliado
      FROM meses
      ORDER BY arquivo_id
    `);

    res.json(rows.map(r => ({
      ...r,

      stats: safeJSON(r.stats),
      produtos: safeJSON(r.produtos),
      tarifas_por_tipo: safeJSON(r.tarifas_por_tipo),
      divergencias: safeJSON(r.divergencias)
    })));

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// RECALCULAR SALDOS
// ═══════════════════════════════════════════════════════════════

async function recalcCadeia() {

  const [meses] = await pool.query(`
    SELECT arquivo_id, stats, pagamentos
    FROM meses
    ORDER BY arquivo_id
  `);

  let saldoAnterior = 0;

  for (const m of meses) {

    const st = safeJSON(m.stats) || {};
    const pags = safeJSON(m.pagamentos) || [];

    const totalPago = pags
      .filter(p => p.num_pagamento)
      .reduce((s, p) => {

        return s + (
          parseFloat(p.valor_total) || 0
        );

      }, 0);

    const totalTarML = parseFloat(st.totalTarML) || 0;

    const saldoCoberto = parseFloat(
      (totalPago - totalTarML).toFixed(2)
    );

    const conciliado =
      saldoAnterior <= 0.01 ||
      saldoCoberto >= (saldoAnterior - 0.01);

    const novoSaldo = parseFloat(
      (totalTarML - totalPago).toFixed(2)
    );

    await pool.query(`
      UPDATE meses
      SET
        saldo_anterior = ?,
        saldo_conciliado = ?
      WHERE arquivo_id = ?
    `, [
      parseFloat(saldoAnterior.toFixed(2)),
      conciliado ? 1 : 0,
      m.arquivo_id
    ]);

    saldoAnterior = novoSaldo > 0
      ? novoSaldo
      : 0;
  }
}

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

initDB()

  .then(() => {

    app.listen(PORT, '0.0.0.0', () => {

      console.log('');
      console.log('════════════════════════════════════');
      console.log('🚀 ConciliaML ONLINE');
      console.log(`🌐 Porta: ${PORT}`);
      console.log('════════════════════════════════════');
      console.log('');

    });

  })

  .catch(err => {

    console.error('❌ Erro ao iniciar:', err);

    process.exit(1);

  });
```

// ═══════════════════════════════════════════════════════════════
//  ConciliaML — Backend Node.js + MySQL
//  Instalar: npm install express mysql2 bcryptjs jsonwebtoken cors dotenv multer xlsx
//  Rodar:    node server.js
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const express    = require('express');
const mysql      = require('mysql2/promise');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const multer     = require('multer');
const XLSX       = require('xlsx');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'concilia_secret_2024';

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── MySQL Pool ──────────────────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASS     || '',
  database: process.env.DB_NAME     || 'conciliaml',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

// ── Init DB ─────────────────────────────────────────────────────
async function initDB() {
  const c = await pool.getConnection();
  try {
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'conciliaml'}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await c.query(`USE \`${process.env.DB_NAME || 'conciliaml'}\``);

    await c.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id          VARCHAR(64)  PRIMARY KEY,
        username    VARCHAR(64)  UNIQUE NOT NULL,
        password    VARCHAR(255) NOT NULL,
        nome        VARCHAR(128),
        role        ENUM('master','user') DEFAULT 'user',
        ativo       TINYINT(1) DEFAULT 1,
        criado_em   DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`);

    await c.query(`
      CREATE TABLE IF NOT EXISTS meses (
        arquivo_id  VARCHAR(128) PRIMARY KEY,
        periodo     VARCHAR(64)  NOT NULL,
        stats       JSON,
        pedidos     LONGTEXT,
        tarifas_ml  LONGTEXT,
        tarifas_mp  LONGTEXT,
        pagamentos  LONGTEXT,
        det_pagamentos LONGTEXT,
        tarifas_por_tipo JSON,
        divergencias JSON,
        produtos    JSON,
        importado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        importado_por VARCHAR(64),
        saldo_anterior DECIMAL(15,2) DEFAULT 0,
        saldo_conciliado TINYINT(1) DEFAULT 0
      ) ENGINE=InnoDB`);

    await c.query(`
      CREATE TABLE IF NOT EXISTS custos (
        mlb         VARCHAR(64)  PRIMARY KEY,
        custo       DECIMAL(15,4) NOT NULL,
        atualizado  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`);

    await c.query(`
      CREATE TABLE IF NOT EXISTS backups (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        ts          DATETIME DEFAULT CURRENT_TIMESTAMP,
        tipo        VARCHAR(32),
        tamanho     INT,
        periodos    JSON,
        criado_por  VARCHAR(64)
      ) ENGINE=InnoDB`);

    // Criar usuário master se não existir
    const [rows] = await c.query(`SELECT id FROM usuarios WHERE id = 'master'`);
    if (!rows.length) {
      const hash = await bcrypt.hash('Admin@2024', 10);
      await c.query(`INSERT INTO usuarios (id,username,password,nome,role,ativo) VALUES ('master','admin',?,'Administrador','master',1)`, [hash]);
      console.log('✅ Usuário master criado: admin / Admin@2024');
    }
    console.log('✅ Banco de dados inicializado.');
  } finally {
    c.release();
  }
}

// ── Auth Middleware ─────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: 'Token ausente' });
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
}
function master(req, res, next) {
  if (req.user.role !== 'master') return res.status(403).json({ error: 'Acesso negado' });
  next();
}

// ══════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const [rows] = await pool.query(`SELECT * FROM usuarios WHERE username=? AND ativo=1`, [username]);
  if (!rows.length) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  const u = rows[0];
  const ok = await bcrypt.compare(password, u.password);
  if (!ok) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  const token = jwt.sign({ id: u.id, username: u.username, nome: u.nome, role: u.role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: u.id, username: u.username, nome: u.nome, role: u.role } });
});

// ══════════════════════════════════════════════════════════════
//  MESES ROUTES
// ══════════════════════════════════════════════════════════════
app.get('/api/meses', auth, async (req, res) => {
  const [rows] = await pool.query(`SELECT arquivo_id,periodo,stats,produtos,tarifas_por_tipo,divergencias,importado_em,importado_por,saldo_anterior,saldo_conciliado FROM meses ORDER BY arquivo_id`);
  res.json(rows.map(r => ({
    ...r,
    stats:           safeJSON(r.stats),
    produtos:        safeJSON(r.produtos),
    tarifas_por_tipo:safeJSON(r.tarifas_por_tipo),
    divergencias:    safeJSON(r.divergencias),
  })));
});

app.get('/api/meses/:id', auth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM meses WHERE arquivo_id=?`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
  const r = rows[0];
  res.json({
    ...r,
    stats:            safeJSON(r.stats),
    pedidos:          safeJSON(r.pedidos),
    tarifas_ml:       safeJSON(r.tarifas_ml),
    tarifas_mp:       safeJSON(r.tarifas_mp),
    pagamentos:       safeJSON(r.pagamentos),
    det_pagamentos:   safeJSON(r.det_pagamentos),
    tarifas_por_tipo: safeJSON(r.tarifas_por_tipo),
    divergencias:     safeJSON(r.divergencias),
    produtos:         safeJSON(r.produtos),
  });
});

app.post('/api/meses', auth, async (req, res) => {
  const d = req.body;
  await pool.query(`
    INSERT INTO meses (arquivo_id,periodo,stats,pedidos,tarifas_ml,tarifas_mp,pagamentos,det_pagamentos,tarifas_por_tipo,divergencias,produtos,importado_em,importado_por,saldo_anterior,saldo_conciliado)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),?,?,?)
    ON DUPLICATE KEY UPDATE
      periodo=VALUES(periodo),stats=VALUES(stats),pedidos=VALUES(pedidos),
      tarifas_ml=VALUES(tarifas_ml),tarifas_mp=VALUES(tarifas_mp),
      pagamentos=VALUES(pagamentos),det_pagamentos=VALUES(det_pagamentos),
      tarifas_por_tipo=VALUES(tarifas_por_tipo),divergencias=VALUES(divergencias),
      produtos=VALUES(produtos),importado_em=NOW(),importado_por=VALUES(importado_por),
      saldo_anterior=VALUES(saldo_anterior),saldo_conciliado=VALUES(saldo_conciliado)
  `, [
    d.arquivo_id, d.periodo,
    JSON.stringify(d.stats),
    JSON.stringify(d.pedidos),
    JSON.stringify(d.tarifas_ml),
    JSON.stringify(d.tarifas_mp),
    JSON.stringify(d.pagamentos),
    JSON.stringify(d.det_pagamentos),
    JSON.stringify(d.tarifas_por_tipo),
    JSON.stringify(d.divergencias),
    JSON.stringify(d.produtos),
    req.user.username,
    d.saldo_anterior || 0,
    d.saldo_conciliado ? 1 : 0,
  ]);
  // Recalcular cadeia de saldos
  await recalcCadeia();
  res.json({ ok: true });
});

app.delete('/api/meses/:id', auth, async (req, res) => {
  await pool.query(`DELETE FROM meses WHERE arquivo_id=?`, [req.params.id]);
  await recalcCadeia();
  res.json({ ok: true });
});

// ── Cadeia de Saldos ──────────────────────────────────────────
// Para cada mês, verifica se o saldo_aberto do mês anterior
// aparece como pago no total de pagamentos do mês atual.
async function recalcCadeia() {
  const [meses] = await pool.query(`SELECT arquivo_id, stats, pagamentos FROM meses ORDER BY arquivo_id`);
  let saldoAnterior = 0;

  for (let i = 0; i < meses.length; i++) {
    const m   = meses[i];
    const st  = safeJSON(m.stats) || {};
    const pags = safeJSON(m.pagamentos) || [];

    // Total pago neste mês
    const totalPago = pags.filter(p => p.num_pagamento)
                          .reduce((s, p) => s + (parseFloat(p.valor_total) || 0), 0);

    // O saldo anterior foi quitado se totalPago >= totalTarML anterior?
    // Mais robusto: verificar se (totalPago - totalTarML_atual) cobre saldoAnterior
    const totalTarML = parseFloat(st.totalTarML) || 0;
    const saldoCoberto = parseFloat((totalPago - totalTarML).toFixed(2));
    const conciliado   = saldoAnterior <= 0.01 || saldoCoberto >= (saldoAnterior - 0.01);

    // Novo saldo aberto deste mês
    const novoSaldo = parseFloat((totalTarML - totalPago).toFixed(2));

    await pool.query(
      `UPDATE meses SET saldo_anterior=?, saldo_conciliado=? WHERE arquivo_id=?`,
      [parseFloat(saldoAnterior.toFixed(2)), conciliado ? 1 : 0, m.arquivo_id]
    );

    saldoAnterior = novoSaldo > 0 ? novoSaldo : 0;
  }
}

// GET cadeia de saldos para o frontend
app.get('/api/cadeia-saldos', auth, async (req, res) => {
  const [meses] = await pool.query(`
    SELECT arquivo_id, periodo, stats, saldo_anterior, saldo_conciliado
    FROM meses ORDER BY arquivo_id`);
  res.json(meses.map(m => ({
    arquivo_id:       m.arquivo_id,
    periodo:          m.periodo,
    stats:            safeJSON(m.stats),
    saldo_anterior:   parseFloat(m.saldo_anterior) || 0,
    saldo_conciliado: !!m.saldo_conciliado,
  })));
});

// ══════════════════════════════════════════════════════════════
//  CUSTOS ROUTES
// ══════════════════════════════════════════════════════════════
app.get('/api/custos', auth, async (req, res) => {
  const [rows] = await pool.query(`SELECT mlb, custo FROM custos`);
  res.json(rows);
});

app.post('/api/custos', auth, async (req, res) => {
  const { mlb, custo } = req.body;
  await pool.query(`INSERT INTO custos (mlb,custo) VALUES (?,?) ON DUPLICATE KEY UPDATE custo=VALUES(custo)`, [mlb, custo]);
  res.json({ ok: true });
});

app.delete('/api/custos/:mlb', auth, async (req, res) => {
  await pool.query(`DELETE FROM custos WHERE mlb=?`, [req.params.mlb]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
//  USUARIOS ROUTES
// ══════════════════════════════════════════════════════════════
app.get('/api/usuarios', auth, master, async (req, res) => {
  const [rows] = await pool.query(`SELECT id,username,nome,role,ativo,criado_em FROM usuarios`);
  res.json(rows);
});

app.post('/api/usuarios', auth, master, async (req, res) => {
  const { nome, username, password, role } = req.body;
  const [ex] = await pool.query(`SELECT id FROM usuarios WHERE username=?`, [username]);
  if (ex.length) return res.status(400).json({ error: 'Login já existe' });
  const hash = await bcrypt.hash(password, 10);
  const id = 'u_' + Date.now();
  await pool.query(`INSERT INTO usuarios (id,username,password,nome,role,ativo) VALUES (?,?,?,?,?,1)`, [id, username, hash, nome, role || 'user']);
  res.json({ ok: true });
});

app.put('/api/usuarios/:id', auth, master, async (req, res) => {
  const { nome, username, password, role, ativo } = req.body;
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(`UPDATE usuarios SET nome=?,username=?,password=?,role=?,ativo=? WHERE id=?`, [nome, username, hash, role, ativo ? 1 : 0, req.params.id]);
  } else {
    await pool.query(`UPDATE usuarios SET nome=?,username=?,role=?,ativo=? WHERE id=?`, [nome, username, role, ativo ? 1 : 0, req.params.id]);
  }
  res.json({ ok: true });
});

app.delete('/api/usuarios/:id', auth, master, async (req, res) => {
  if (req.params.id === 'master') return res.status(400).json({ error: 'Não pode excluir o mestre' });
  await pool.query(`DELETE FROM usuarios WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
//  BACKUP ROUTES
// ══════════════════════════════════════════════════════════════
app.get('/api/backup/export', auth, async (req, res) => {
  const [meses]    = await pool.query(`SELECT * FROM meses`);
  const [custos]   = await pool.query(`SELECT * FROM custos`);
  const [usuarios] = await pool.query(`SELECT id,username,nome,role,ativo,criado_em FROM usuarios`);
  const payload = { ts: new Date().toISOString(), versao: '2.0', meses, custos, usuarios };
  const json = JSON.stringify(payload);
  await pool.query(`INSERT INTO backups (tipo,tamanho,periodos,criado_por) VALUES (?,?,?,?)`,
    ['manual_export', json.length, JSON.stringify(meses.map(m => m.periodo)), req.user.username]);
  res.setHeader('Content-Disposition', `attachment; filename="conciliaml_backup_${new Date().toISOString().slice(0,10)}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(json);
});

app.post('/api/backup/import', auth, master, async (req, res) => {
  const { meses, custos } = req.body;
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    for (const m of (meses || [])) {
      await c.query(`
        INSERT INTO meses (arquivo_id,periodo,stats,pedidos,tarifas_ml,tarifas_mp,pagamentos,det_pagamentos,tarifas_por_tipo,divergencias,produtos,importado_por,saldo_anterior,saldo_conciliado)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE periodo=VALUES(periodo),stats=VALUES(stats)`,
        [m.arquivo_id, m.periodo,
         toJS(m.stats), toJS(m.pedidos), toJS(m.tarifas_ml), toJS(m.tarifas_mp),
         toJS(m.pagamentos), toJS(m.det_pagamentos), toJS(m.tarifas_por_tipo),
         toJS(m.divergencias), toJS(m.produtos),
         m.importado_por||'restore', m.saldo_anterior||0, m.saldo_conciliado?1:0]);
    }
    for (const cu of (custos || [])) {
      await c.query(`INSERT INTO custos (mlb,custo) VALUES (?,?) ON DUPLICATE KEY UPDATE custo=VALUES(custo)`, [cu.mlb, cu.custo]);
    }
    await c.commit();
    await recalcCadeia();
    res.json({ ok: true });
  } catch (e) {
    await c.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    c.release();
  }
});

app.get('/api/backups', auth, async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM backups ORDER BY ts DESC LIMIT 50`);
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════
function safeJSON(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}
function toJS(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

// ══════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 ConciliaML rodando em http://localhost:${PORT}`));
}).catch(err => { console.error('❌ Erro ao iniciar:', err); process.exit(1); });

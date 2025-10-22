// require('dotenv').config(); // NÃO USAR EM PRODUÇÃO
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const app = express();
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session); // Vamos manter a sessão em SQLite por simplicidade
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { Pool } = require('pg'); // <-- NOVO: Pacote do PostgreSQL

// --- CONFIGURAÇÃO DO BANCO DE DADOS (PostgreSQL) ---
// O OnRender nos dará esta URL. No .env, ela parecerá com:
// DATABASE_URL="postgres://usuario:senha@host:5432/nomedb"
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Necessário para conexões no OnRender
  }
});

// Substitui db.run e db.all por uma função única
const db = {
  query: (text, params) => pool.query(text, params),
};

// --- CONFIGURAÇÃO DO NODEMAILER ---
const transporter = nodemailer.createTransport({
    service: 'gmail', // <-- MUDANÇA PRINCIPAL
    auth: {
        user: 'petsearch2025@gmail.com',
        pass: process.env.GMAIL_PASS
    }
});

// --- CONFIGURAÇÃO DE GEOLOCALIZAÇÃO ---
const OPENCAGE_API_KEY = process.env.OPENCAGE_API_KEY;

async function geocodeAddress(addressString) {
  // ... (código existente, sem alteração)
  const { default: fetch } = await import('node-fetch');
  if (!addressString || addressString.trim() === '') {
      console.warn("Geocoding cancelado: Endereço vazio.");
      return null;
  }
  console.log(`Geocoding (OpenCage) para: "${addressString}"`);
  const apiUrl = `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(addressString)}&key=${OPENCAGE_API_KEY}&countrycode=br&limit=1&no_annotations=1`;
  try {
      const response = await fetch(apiUrl);
      const data = await response.json();
      if (!response.ok) {
          console.error(`Erro OpenCage (${response.status} - ${data?.status?.message}):`, data);
          return null;
      }
      if (data.results && data.results.length > 0) {
          const location = data.results[0].geometry;
          if (typeof location.lat === 'number' && typeof location.lng === 'number') {
            console.log("Coordenadas encontradas (OpenCage):", { lat: location.lat, lon: location.lng });
            return { lat: location.lat, lon: location.lng };
          } else {
            console.warn("Resultado inválido do OpenCage (lat/lng não são números):", location);
            return null;
          }
      } else {
          console.warn("Nenhum resultado encontrado no OpenCage para:", addressString);
          return null;
      }
  } catch (error) {
      console.error('Erro na chamada da API OpenCage ou processamento:', error);
      return null;
  }
}

// --- CONFIGURAÇÃO DO CLOUDINARY ---
cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'pet-search',
    format: async (req, file) => 'jpg',
    public_id: (req, file) => Date.now() + '-' + Math.round(Math.random() * 1E9),
  },
});

const upload = multer({ storage: storage });

// --- MIDDLEWARES ---
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ATENÇÃO: Ainda usaremos o SQLite para sessões, pois é mais simples no OnRender
// O OnRender vai criar um disco persistente para isso.
const SESSAO_DB_PATH = '/var/data/sessions.db'; // Caminho especial do OnRender
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: './' }), // Salva no disco persistente
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function isLoggedIn(req, res, next) {
  // ... (código existente, sem alteração)
  if (req.session.userId) {
    return next();
  }
  if (req.originalUrl.startsWith('/api/')) {
     res.status(401).json({ error: "Acesso não autorizado." });
  } else {
     res.redirect('/login.html');
  }
}

async function isAdmin(req, res, next) {
   // ... (código existente, MODIFICADO PARA PG)
   if (!req.session || !req.session.userId) {
       return res.redirect('/');
   }
   try {
       const result = await db.query("SELECT is_admin FROM usuarios WHERE id = $1", [req.session.userId]);
       const user = result.rows[0];
       if (!user || user.is_admin !== 1) {
          console.warn(`Tentativa acesso admin negada: User ID ${req.session.userId}`);
          return res.redirect('/');
       }
       return next();
   } catch (err) {
       console.error("Erro ao verificar admin:", err);
       return res.redirect('/');
   }
}

// --- BANCO DE DADOS (Criação de Tabelas PG) ---
// Esta função será chamada na inicialização do servidor
async function criarTabelas() {
  const queryUsuarios = `
  CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    reset_token TEXT,
    reset_expires BIGINT
  );`;
  
  const queryAnimais = `
  CREATE TABLE IF NOT EXISTS animais (
    id SERIAL PRIMARY KEY,
    nome TEXT,
    status TEXT NOT NULL,
    foto TEXT,
    porte TEXT,
    cor TEXT,
    raca TEXT,
    genero TEXT,
    descricao TEXT,
    localizacao TEXT NOT NULL,
    tutor TEXT NOT NULL,
    email TEXT NOT NULL,
    telefone TEXT NOT NULL,
    data_cadastro TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    latitude REAL,
    longitude REAL,
    usuario_id INTEGER REFERENCES usuarios(id),
    foto_public_id TEXT
  );`;

  try {
    await db.query(queryUsuarios);
    console.log("Tabela 'usuarios' verificada/criada.");
    await db.query(queryAnimais);
    console.log("Tabela 'animais' verificada/criada.");
  } catch (err) {
    console.error("Erro ao criar tabelas:", err);
    process.exit(1); // Para o servidor se não conseguir criar as tabelas
  }
}

// --- ROTAS API (MODIFICADAS PARA PG) ---

app.get('/api/cep/:cep', async (req, res) => {
    // ... (código existente, sem alteração)
    const { default: fetch } = await import('node-fetch');
    const cep = req.params.cep.replace(/\D/g, '');
    if (cep.length !== 8) { return res.status(400).json({ error: 'CEP inválido' }); }
    try {
        const url = `https://viacep.com.br/ws/${cep}/json/`; const response = await fetch(url);
        if (!response.ok) { const txt = await response.text(); throw new Error(`ViaCEP ${response.status}: ${txt}`); }
        const data = await response.json(); if (data.erro) { return res.status(404).json({ error: 'CEP não encontrado' }); }
        res.json({ cep: data.cep, logradouro: data.logradouro, bairro: data.bairro, localidade: data.localidade, uf: data.uf });
    } catch (error) { console.error('Erro API ViaCEP:', error); res.status(500).json({ error: 'Erro consulta CEP' }); }
});

// ROTA: Cadastrar animal (ATUALIZADA PARA PG)
app.post('/api/animais', isLoggedIn, upload.single('foto'), async (req, res) => {
  const { nome, status, porte, cor, raca, genero, descricao, localizacao, logradouro, numero, cidade, estado, tutor, email, telefone } = req.body;
  if (!status || !(logradouro || localizacao) || !tutor || !email || !telefone) { return res.status(400).json({ error: "Campos obrigatórios" }); }
  if (!/\S+@\S+\.\S+/.test(email)) { return res.status(400).json({ error: "E-mail inválido." }); }
  
  let latitude = null; let longitude = null;
  let address = [logradouro, numero, cidade, estado].filter(p => p && p.trim()).join(', ');
  if (!address || address.split(',').length < 2) { address = localizacao; }
  const coords = await geocodeAddress(address);
  if (coords) { latitude = coords.lat; longitude = coords.lon; } else { console.warn(`Coords não obtidas: "${address}".`); }

  const foto = req.file ? req.file.path : null; 
  const foto_public_id = req.file ? req.file.filename : null;
  const uid = req.session.userId;
  
  const sql = `INSERT INTO animais (nome, status, foto, porte, cor, raca, genero, descricao, localizacao, tutor, email, telefone, usuario_id, latitude, longitude, foto_public_id) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
               RETURNING id`; // $1, $2... é a sintaxe do PG
  const params = [nome||null, status, foto, porte||null, cor||null, raca||null, genero||null, descricao||null, localizacao, tutor, email, telefone, uid, latitude, longitude, foto_public_id];

  try {
    const result = await db.query(sql, params);
    const novoId = result.rows[0].id;
    console.log(`Animal cadastrado ID: ${novoId} (Cloudinary: ${foto_public_id})`);
    res.status(201).json({ id: novoId, status: status, redirect: status === 'perdido' ? '/perdidos.html' : '/encontrados.html' });
  } catch (err) {
    console.error("Erro DB insert:", err.message); 
    if (foto_public_id) {
      cloudinary.uploader.destroy(foto_public_id, (destroyErr) => {
          if(destroyErr) console.error("Erro ao deletar foto órfã do Cloudinary:", destroyErr);
      });
    }
    return res.status(500).json({ error: "Erro ao salvar." }); 
  }
});

// ROTA: Buscar animais (ATUALIZADA PARA PG)
app.get('/api/animais', async (req, res) => {
    const { default: fetch } = await import('node-fetch');
    const { status, nome, localizacao, porte, cep, limit } = req.query;
    const RAIO_KM = 5;
    const statusList = Array.isArray(status) ? status : (status ? [status] : []);
    
    if (statusList.length === 0 && limit !== 'all') { return res.status(400).json({ error: "'status' obrigatório" }); }
    
    let params = [];
    let sqlSelect = 'SELECT *';
    let sqlFrom = 'FROM animais';
    let sqlWhere = '';
    let sqlOrderBy = 'ORDER BY data_cadastro DESC';
    let searchCoords = null;
    let isGeoSearch = false;
    let address = null;

    if (statusList.length > 0) {
        sqlWhere = `WHERE status IN (${statusList.map((s, i) => `$${i + 1}`).join(',')})`; // $1, $2...
        params.push(...statusList);
    } else {
        sqlWhere = 'WHERE 1=1';
    }
    
    // Obter Coordenadas (igual)
    if (cep && cep.replace(/\D/g, '').length === 8) {
        const c = cep.replace(/\D/g, ''); console.log(`Buscando CEP: ${c}`);
        try { const r = await fetch(`https://viacep.com.br/ws/${c}/json/`); if (r.ok) { const d = await r.json(); if(!d.erro) address = [d.logradouro, d.bairro, d.localidade, d.uf].filter(Boolean).join(', '); } else { console.warn(`ViaCEP falhou (${r.status})`); } } catch(e){ console.error("Erro ViaCEP:", e); }
        if (!address) address = c;
    } else if (localizacao) { address = localizacao; }
    if (address) { searchCoords = await geocodeAddress(address); }

    // Montar Query SQL Haversine (Sintaxe PG)
    if (searchCoords && typeof searchCoords.lat === 'number' && typeof searchCoords.lon === 'number') {
        isGeoSearch = true;
        const lat = searchCoords.lat;
        const lon = searchCoords.lon;
        if (!isNaN(lat) && !isNaN(lon)) {
            // Fórmula Haversine adaptada para PG (radians() não existe, usa * pi()/180)
            const hav = `acos( cos( (${lat} * pi()/180) ) * cos( ( latitude * pi()/180 ) ) * cos( ( longitude * pi()/180 ) - (${lon} * pi()/180) ) + sin( (${lat} * pi()/180) ) * sin( ( latitude * pi()/180 ) ) )`;
            const dist = `( 6371 * ${hav} )`;
            sqlSelect = `SELECT *, ${dist} AS distancia`;
            sqlWhere += ` AND (latitude IS NOT NULL AND longitude IS NOT NULL AND ${dist} < $${params.length + 1})`;
            params.push(RAIO_KM);
            sqlOrderBy = `ORDER BY distancia ASC`;
        } else {
            isGeoSearch = false;
            if (localizacao) {
                sqlWhere += ` AND localizacao ILIKE $${params.length + 1}`; // ILIKE = case-insensitive
                params.push(`%${localizacao}%`);
            }
        }
    } else if (localizacao) {
        sqlWhere += ` AND localizacao ILIKE $${params.length + 1}`;
        params.push(`%${localizacao}%`);
    }

    if (nome) {
        sqlWhere += ` AND nome ILIKE $${params.length + 1}`;
        params.push(`%${nome}%`);
    }
    if (porte) {
        sqlWhere += ` AND porte = $${params.length + 1}`;
        params.push(porte);
    }
    
    const sqlLimit = (limit === 'all' && req.session?.isAdmin === 1) ? '' : 'LIMIT 50';
    const sql = `${sqlSelect} ${sqlFrom} ${sqlWhere} ${sqlOrderBy} ${sqlLimit}`;

    console.log("SQL (PG):", sql);
    console.log("Params (PG):", params);
    
    try {
        const result = await db.query(sql, params);
        const rows = result.rows;
        if(isGeoSearch){ rows.forEach(r => { if(r.distancia !== null && typeof r.distancia === 'number'){ r.distanciaFormatada = r.distancia < 1 ? (r.distancia * 1000).toFixed(0) + ' m' : r.distancia.toFixed(1) + ' km'; }}); }
        res.json(rows);
    } catch (err) {
        console.error("Erro SQL (PG):", err.message);
        return res.status(500).json({ error: "Erro busca" });
    }
});

// *** ROTA ADMIN API (ATUALIZADA PARA PG) ***
app.get('/api/admin/animais', isLoggedIn, isAdmin, async (req, res) => {
    const sql = `SELECT a.*, u.nome as nome_usuario, u.email as email_usuario
                 FROM animais a LEFT JOIN usuarios u ON a.usuario_id = u.id ORDER BY a.data_cadastro DESC`;
    try {
        const result = await db.query(sql);
        res.json(result.rows);
    } catch (err) {
        console.error("Erro admin busca:", err.message);
        return res.status(500).json({ error: "Erro interno" });
    }
});

// ROTA: Buscar animais do PRÓPRIO usuário (ATUALIZADA PARA PG)
app.get('/api/meus-animais', isLoggedIn, async (req, res) => {
  const uid = req.session.userId;
  const sql = "SELECT * FROM animais WHERE usuario_id = $1 ORDER BY data_cadastro DESC";
  try {
      const result = await db.query(sql, [uid]);
      res.json(result.rows);
  } catch (err) {
      console.error("Erro meus animais:", err.message);
      return res.status(500).json({ error: "Erro interno" });
  }
});

// ROTA: Deletar um animal (ATUALIZADA PARA PG)
app.delete('/api/animais/:id', isLoggedIn, async (req, res) => {
  const aid = req.params.id; 
  const uid = req.session.userId;

  try {
      // 1. Pega o ID da foto e permissão
      const userResult = await db.query("SELECT is_admin FROM usuarios WHERE id = $1", [uid]);
      const user = userResult.rows[0];
      if (!user) return res.status(500).json({ error: "Erro permissões" }); 
      const isAdmin = user.is_admin;
      
      // 2. Busca o animal para pegar o ID da foto
      const animalResult = await db.query("SELECT usuario_id, foto_public_id FROM animais WHERE id = $1", [aid]);
      const animal = animalResult.rows[0];
      if (!animal) return res.status(404).json({ error: "Animal não encontrado." });
      
      // 3. Verifica permissão
      if (animal.usuario_id !== uid && !isAdmin) {
          return res.status(403).json({ error: "Sem permissão para deletar este animal." });
      }

      // 4. Deleta do Banco de Dados
      const sql = "DELETE FROM animais WHERE id = $1";
      await db.query(sql, [aid]);

      // 5. Deleta do Cloudinary
      if (animal.foto_public_id) {
          cloudinary.uploader.destroy(animal.foto_public_id, (destroyErr, destroyResult) => {
              if (destroyErr) {
                  console.error(`Falha ao deletar ${animal.foto_public_id} do Cloudinary:`, destroyErr);
              } else {
                  console.log(`Cloudinary delete OK: ${animal.foto_public_id}`, destroyResult.result ? destroyResult.result : '');
              }
          });
      } else {
          console.log(`Animal ID: ${aid} deletado (sem foto no Cloudinary).`);
      }
      
      console.log(`Animal ID: ${aid} deletado do DB por User ID: ${uid}`); 
      res.json({ message: "Deletado" });
      
  } catch (err) {
      console.error("Erro ao deletar (PG):", err);
      res.status(500).json({ error: "Erro interno." });
  }
});

// ROTA: Mudar status de um animal (ATUALIZADA PARA PG)
app.put('/api/animais/:id/status', isLoggedIn, async (req, res) => {
  const aid = req.params.id;
  const uid = req.session.userId;
  const { status } = req.body;

  if (!status || !['perdido', 'encontrado'].includes(status)) { return res.status(400).json({ error: "Status inválido" }); }
  
  try {
      const userResult = await db.query("SELECT is_admin FROM usuarios WHERE id = $1", [uid]);
      const user = userResult.rows[0];
      if (!user) return res.status(500).json({ error: "Erro permissões" });
      const isAdmin = user.is_admin;
      
      const sql = `UPDATE animais SET status = $1 WHERE id = $2 AND (usuario_id = $3 OR $4 = 1)`;
      const result = await db.query(sql, [status, aid, uid, isAdmin ? 1 : 0]);

      if (result.rowCount === 0) {
          const animalResult = await db.query("SELECT id FROM animais WHERE id = $1", [aid]);
          if (animalResult.rows.length > 0) {
              return res.status(403).json({ error: "Sem permissão" });
          } else {
              return res.status(404).json({ error: "Não encontrado" });
          }
      } else {
          console.log(`Status Animal ID: ${aid} para ${status} por User ID: ${uid}`);
          res.json({ message: `Status alterado` });
      }
  } catch (err) {
      console.error("Erro update status (PG):", err.message);
      return res.status(500).json({ error: "Erro interno" });
  }
});

// ROTA: Notificar que animal foi encontrado (ATUALIZADA PARA PG)
app.post('/api/animais/:id/notificar-encontrado', async (req, res) => {
    const animalId = req.params.id;
    const { notificadorEmail, mensagemAdicional } = req.body; 

    try {
        const sql = "SELECT nome, tutor, email FROM animais WHERE id = $1";
        const result = await db.query(sql, [animalId]);
        const animal = result.rows[0];

        if (!animal) {
            return res.status(404).json({ error: "Animal não encontrado." });
        }
        if (!animal.email) {
            return res.status(400).json({ error: "O tutor deste animal não possui e-mail cadastrado." });
        }

        const animalNome = animal.nome || 'O animal';
        const donoEmail = animal.email;
        const donoNome = animal.tutor;

        const mailOptions = {
            from: '"Pet Search" <petsearch2025@gmail.com>',
            to: donoEmail,
            subject: `Alguém viu o(a) ${animalNome}! - Pet Search`,
            html: `
                <p>Olá, ${donoNome}!</p>
                <p>Uma pessoa reportou ter visto o(a) <strong>${animalNome}</strong>.</p>
                <hr>
                <p><strong>Mensagem de quem o viu:</strong></p>
                <p style="font-style: italic;">${mensagemAdicional || '(Nenhuma mensagem adicional)'}</p>
                <hr>
                ${notificadorEmail ? `<p><strong>E-mail para contato (de quem viu):</strong> ${notificadorEmail}</p>` : ''}
                <p>Esperamos que vocês se reencontrem logo!</p>
                <p><strong>Equipe Pet Search</strong></p>
            `
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error("Erro ao enviar notificação:", error);
                return res.status(500).json({ error: "Erro ao enviar e-mail." });
            }
            console.log('Notificação enviada: %s', info.messageId);
            res.json({ message: "Notificação enviada com sucesso para o tutor!" });
        });
    } catch (err) {
        console.error("Erro ao notificar (PG):", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

// --- ROTAS DE AUTENTICAÇÃO (MODIFICADAS PARA PG) ---

// ROTA: Registrar novo usuário (ATUALIZADA PARA PG)
app.post('/api/register', async (req, res) => {
  const { nome, email, senha } = req.body;
  
  if (!nome || !email || !senha) { return res.status(400).json({ error: "Campos obrigatórios" }); }
  if (!/\S+@\S+\.\S+/.test(email)) { return res.status(400).json({ error: "E-mail inválido." }); }
  if (senha.length < 6) { return res.status(400).json({ error: "Senha muito curta." }); }

  try {
    const hash = await bcrypt.hash(senha, 10); 
    const sql = "INSERT INTO usuarios (nome, email, senha_hash) VALUES ($1, $2, $3) RETURNING id";
    
    const result = await db.query(sql, [nome, email, hash]);
    const novoUsuarioId = result.rows[0].id;
    
    // Envia e-mail de boas-vindas (sem alteração)
    const mailOptions = {
        from: '"Pet Search" <petsearch2025@gmail.com>',
        to: email,
        subject: 'Bem-vindo(a) ao Pet Search!',
        html: `
            <h1>Olá, ${nome}!</h1>
            <p>Seu cadastro no Pet Search foi realizado com sucesso.</p>
            <p>Seu e-mail de login é: <strong>${email}</strong></p>
            <p>Aproveite a plataforma!</p>
        `
    };
    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error(`Erro ao enviar e-mail de boas-vindas para ${email}:`, error);
        } else {
            console.log(`E-mail de boas-vindas enviado para ${email}: ${info.messageId}`);
        }
    });

    // Cria a sessão (sem alteração)
    req.session.regenerate( (errR) => { 
      if(errR) console.error("Erro regen sessão:", errR); 
      req.session.userId = novoUsuarioId;
      req.session.isAdmin = 0; 
      console.log(`User registrado: ${email} (ID: ${novoUsuarioId})`); 
      res.status(201).json({ id: novoUsuarioId, redirect: '/' }); 
    });
    
  } catch (err) { 
    if (err.code === '23505') { // Código de erro do PG para 'UNIQUE violation'
        return res.status(409).json({ error: "E-mail já cadastrado" });
    }
    console.error("Erro DB registro (PG):", err); 
    res.status(500).json({ error: "Erro interno" }); 
  }
});

// ROTA: Esqueci Minha Senha (ATUALIZADA PARA PG)
app.post('/api/esqueci-senha', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: "E-mail obrigatório" });
    }

    try {
        const userResult = await db.query("SELECT * FROM usuarios WHERE email = $1", [email]);
        const user = userResult.rows[0];

        if (!user) {
            console.warn(`Tentativa de reset de senha para e-mail não encontrado: ${email}`);
            return res.json({ message: "Se um usuário com este e-mail existir, um link de redefinição será enviado." });
        }

        const token = crypto.randomBytes(20).toString('hex');
        const expires = Date.now() + 3600000; // 1 hora

        const sql = "UPDATE usuarios SET reset_token = $1, reset_expires = $2 WHERE id = $3";
        await db.query(sql, [token, expires, user.id]);
            
        const host = req.get('host');
        const protocol = req.protocol;
        const resetLink = `${protocol}://${host}/redefinir.html?token=${token}`;

        const mailOptions = {
            from: '"Pet Search" <petsearch2025@gmail.com>',
            to: user.email,
            subject: 'Redefinição de Senha - Pet Search',
            html: `
                <p>Olá, ${user.nome}.</p>
                <p>Você solicitou a redefinição de senha. Clique no link abaixo para criar uma nova senha:</p>
                <p><a href="${resetLink}" target="_blank">${resetLink}</a></p>
                <p>Este link expira em 1 hora. Se você não solicitou isso, ignore este e-mail.</p>
            `
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error("Erro ao enviar e-mail de reset:", error);
                return res.status(500).json({ error: "Erro ao enviar e-mail." });
            }
            console.log(`E-mail de reset enviado para ${user.email}`);
            res.json({ message: "Se um usuário com este e-mail existir, um link de redefinição será enviado." });
        });
        
    } catch (err) {
        console.error("Erro ao salvar token no DB (PG):", err);
        return res.status(500).json({ error: "Erro interno." });
    }
});

// ROTA: Redefinir Senha (ATUALIZADA PARA PG)
app.post('/api/redefinir-senha', async (req, res) => {
    const { token, senha } = req.body;

    if (!token || !senha) { return res.status(400).json({ error: "Token e nova senha são obrigatórios." }); }
    if (senha.length < 6) { return res.status(400).json({ error: "Senha deve ter no mínimo 6 caracteres." }); }

    try {
        const sql = "SELECT * FROM usuarios WHERE reset_token = $1 AND reset_expires > $2";
        const userResult = await db.query(sql, [token, Date.now()]);
        const user = userResult.rows[0];

        if (!user) {
            console.warn(`Tentativa de reset com token inválido/expirado: ${token}`);
            return res.status(400).json({ error: "Token inválido ou expirado. Solicite um novo link." });
        }
        
        const hash = await bcrypt.hash(senha, 10);
        const sqlUpdate = "UPDATE usuarios SET senha_hash = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2";
        await db.query(sqlUpdate, [hash, user.id]);
        
        console.log(`Senha redefinida para usuário: ${user.email}`);
        res.json({ message: "Senha redefinida com sucesso! Você já pode fazer login." });

    } catch (e) {
        console.error("Erro no bcrypt/db (redefinir):", e);
        res.status(500).json({ error: "Erro interno." });
    }
});

// ROTA: Login de usuário (ATUALIZADA PARA PG)
app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body; 
  if (!email || !senha) { return res.status(400).json({ error: "Campos obrigatórios" }); }
  
  const sql = "SELECT * FROM usuarios WHERE email = $1";
  
  try {
      const result = await db.query(sql, [email]);
      const user = result.rows[0];
      
      if (!user) { return res.status(401).json({ error: "Credenciais inválidas" }); }
    
      const match = await bcrypt.compare(senha, user.senha_hash);
      if (match) {
        req.session.regenerate( (errR) => { 
            if(errR){ console.error("Erro regen sessão:", errR); return res.status(500).json({ error: "Erro interno" }); }
            
            req.session.userId = user.id; 
            req.session.isAdmin = user.is_admin; 
            console.log(`User logado: ${email} (ID: ${user.id}, Admin: ${user.is_admin})`);
            
            const redirect = user.is_admin ? '/admin.html' : '/'; 
            res.json({ message: "Login OK", redirect });
        });
      } else { 
        res.status(401).json({ error: "Credenciais inválidas" }); 
      }
  } catch(e) { 
      console.error("Erro login (PG):", e); 
      res.status(500).json({ error: "Erro interno" }); 
  }
});

app.get('/api/logout', (req, res) => {
  // ... (código existente, sem alteração)
  const uid = req.session.userId; 
  req.session.destroy((err) => { 
      if (err) { console.error("Erro destroy sessão:", err); } 
      console.log(`User deslogado: ID ${uid || 'N/A'}`); 
      res.clearCookie('connect.sid', { path: '/' }); 
      res.redirect('/'); 
  });
});

app.get('/api/session', async (req, res) => {
  // ... (código existente, MODIFICADO PARA PG)
  if (req.session.userId) {
    const sql = "SELECT id, nome, email, is_admin FROM usuarios WHERE id = $1";
    try {
        const result = await db.query(sql, [req.session.userId]);
        const user = result.rows[0];
        if (!user) { 
            req.session.destroy(); 
            res.clearCookie('connect.sid', { path: '/' }); 
            return res.json({ loggedIn: false }); 
        } 
        res.json({ loggedIn: true, nome: user.nome, isAdmin: user.is_admin });
    } catch (err) {
        req.session.destroy(); 
        res.clearCookie('connect.sid', { path: '/' }); 
        return res.json({ loggedIn: false }); 
    }
  } else { 
    res.json({ loggedIn: false }); 
  }
});

// --- ROTAS HTML ---
// ... (código existente, sem alteração)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/perdidos.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'perdidos.html')));
app.get('/encontrados.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'encontrados.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/esqueci-senha.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'esqueci-senha.html')));
app.get('/redefinir.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'redefinir.html')));

// Arquivos PROTEGIDOS (na pasta views)
app.get('/cadastro.html', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'cadastro.html'));
});
app.get('/meus-animais.html', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'meus-animais.html'));
});
app.get('/admin.html', isLoggedIn, isAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 3000;
// Inicia o servidor e cria as tabelas
app.listen(PORT, async () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    // Garante que as tabelas do PG existam antes de aceitar conexões
    await criarTabelas();
});
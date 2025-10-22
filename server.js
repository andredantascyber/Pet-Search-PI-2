require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const app = express();
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2; // <-- NOVO
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const db = new sqlite3.Database('./database.db');

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: 'petsearch2025@gmail.com',
        pass: process.env.GMAIL_PASS
    }
});

const OPENCAGE_API_KEY = process.env.OPENCAGE_API_KEY;

async function geocodeAddress(addressString) {
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

app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SQLiteStore({ db: 'database.db', dir: './' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function isLoggedIn(req, res, next) {
  if (req.session.userId) {
    return next();
  }
  if (req.originalUrl.startsWith('/api/')) {
     res.status(401).json({ error: "Acesso não autorizado." });
  } else {
     res.redirect('/login.html');
  }
}

function isAdmin(req, res, next) {
   if (!req.session || !req.session.userId) {
       return res.redirect('/');
   }
   db.get("SELECT is_admin FROM usuarios WHERE id = ?", [req.session.userId], (err, user) => {
       if (err || !user || user.is_admin !== 1) {
          console.warn(`Tentativa acesso admin negada: User ID ${req.session.userId}`);
          return res.redirect('/');
       }
       return next();
   });
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS animais (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, status TEXT NOT NULL, foto TEXT, porte TEXT, cor TEXT, raca TEXT, genero TEXT, descricao TEXT, localizacao TEXT NOT NULL, tutor TEXT NOT NULL, email TEXT NOT NULL, telefone TEXT NOT NULL, data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP, latitude REAL, longitude REAL, usuario_id INTEGER REFERENCES usuarios(id), foto_public_id TEXT);`, (err) => { if(err) console.error("Erro Tabela animais:", err.message); });
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, email TEXT NOT NULL UNIQUE, senha_hash TEXT NOT NULL, is_admin INTEGER DEFAULT 0, reset_token TEXT, reset_expires INTEGER);`, (err) => { if(err) console.error("Erro Tabela usuarios:", err.message); });

  const addColumn = (colName, colType, tableName = 'animais') => {
      db.run(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colType}`, (err) => {
          if (err && !err.message.includes('duplicate column name')) { console.error(`Erro add coluna ${colName}:`, err.message); }
      });
  };
  addColumn('latitude', 'REAL');
  addColumn('longitude', 'REAL');
  addColumn('usuario_id', 'INTEGER REFERENCES usuarios(id)');
  addColumn('foto_public_id', 'TEXT');
});

app.get('/api/cep/:cep', async (req, res) => {
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
  
  const sql = `INSERT INTO animais (nome, status, foto, porte, cor, raca, genero, descricao, localizacao, tutor, email, telefone, usuario_id, latitude, longitude, foto_public_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [nome||null, status, foto, porte||null, cor||null, raca||null, genero||null, descricao||null, localizacao, tutor, email, telefone, uid, latitude, longitude, foto_public_id], function(err) {
    if (err) { 
      console.error("Erro DB insert:", err.message); 
      if (foto_public_id) {
        cloudinary.uploader.destroy(foto_public_id, (destroyErr) => {
            if(destroyErr) console.error("Erro ao deletar foto órfã do Cloudinary:", destroyErr);
        });
      }
      return res.status(500).json({ error: "Erro ao salvar." }); 
    }
    console.log(`Animal cadastrado ID: ${this.lastID} (Cloudinary: ${foto_public_id})`);
    res.status(201).json({ id: this.lastID, status: status, redirect: status === 'perdido' ? '/perdidos.html' : '/encontrados.html' });
  });
});

app.get('/api/animais', async (req, res) => {
    const { default: fetch } = await import('node-fetch');
    const { status, nome, localizacao, porte, cep, limit } = req.query;
    const RAIO_KM = 5;
    const statusList = Array.isArray(status) ? status : (status ? [status] : []);
    if (statusList.length === 0 && limit !== 'all') { return res.status(400).json({ error: "'status' obrigatório" }); }
    let params = []; let sqlSelect = 'SELECT *'; let sqlFrom = 'FROM animais'; let sqlWhere = '';
    let sqlOrderBy = 'ORDER BY data_cadastro DESC'; let searchCoords = null; let isGeoSearch = false; let address = null;
    if (statusList.length > 0) { sqlWhere = `WHERE status IN (${statusList.map(() => '?').join(',')})`; params.push(...statusList); }
    else { sqlWhere = 'WHERE 1=1'; }
    if (cep && cep.replace(/\D/g, '').length === 8) {
        const c = cep.replace(/\D/g, ''); console.log(`Buscando CEP: ${c}`);
        try { const r = await fetch(`https://viacep.com.br/ws/${c}/json/`); if (r.ok) { const d = await r.json(); if(!d.erro) address = [d.logradouro, d.bairro, d.localidade, d.uf].filter(Boolean).join(', '); } else { console.warn(`ViaCEP falhou (${r.status})`); } } catch(e){ console.error("Erro ViaCEP:", e); }
        if (!address) address = c;
    } else if (localizacao) { address = localizacao; }
    if (address) { searchCoords = await geocodeAddress(address); }
    if (searchCoords && typeof searchCoords.lat === 'number' && typeof searchCoords.lon === 'number') {
        isGeoSearch = true; const lat = searchCoords.lat; const lon = searchCoords.lon;
        if (!isNaN(lat) && !isNaN(lon)) {
            const hav = `acos( cos( radians(${lat}) ) * cos( radians( latitude ) ) * cos( radians( longitude ) - radians(${lon}) ) + sin( radians(${lat}) ) * sin( radians( latitude ) ) )`;
            sqlSelect = `SELECT *, ( 6371 * ${hav} ) AS distancia`; sqlWhere += ` AND (latitude IS NOT NULL AND longitude IS NOT NULL AND ( 6371 * ${hav} ) < ?)`; params.push(RAIO_KM); sqlOrderBy = `ORDER BY distancia ASC`;
        } else { isGeoSearch = false; if (localizacao) { sqlWhere += ' AND localizacao LIKE ?'; params.push(`%${localizacao}%`); } }
    } else if (localizacao) { sqlWhere += ' AND localizacao LIKE ?'; params.push(`%${localizacao}%`); }
    if (nome) { sqlWhere += ' AND nome LIKE ?'; params.push(`%${nome}%`); }
    if (porte) { sqlWhere += ' AND porte = ?'; params.push(porte); }
    const sqlLimit = (limit === 'all' && req.session?.isAdmin === 1) ? '' : 'LIMIT 50';
    const sql = `${sqlSelect} ${sqlFrom} ${sqlWhere} ${sqlOrderBy} ${sqlLimit}`;
    console.log("SQL:", sql); console.log("Params:", params);
    db.all(sql, params, (err, rows) => {
        if (err) { console.error("Erro SQL:", err.message); return res.status(500).json({ error: "Erro busca" }); }
        if(isGeoSearch){ rows.forEach(r => { if(r.distancia !== null && typeof r.distancia === 'number'){ r.distanciaFormatada = r.distancia < 1 ? (r.distancia * 1000).toFixed(0) + ' m' : r.distancia.toFixed(1) + ' km'; }}); }
        res.json(rows);
    });
});

app.get('/api/admin/animais', isLoggedIn, isAdmin, (req, res) => {
    const sql = `SELECT a.*, u.nome as nome_usuario, u.email as email_usuario
                 FROM animais a LEFT JOIN usuarios u ON a.usuario_id = u.id ORDER BY a.data_cadastro DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) { console.error("Erro admin busca:", err.message); return res.status(500).json({ error: "Erro interno" }); }
        res.json(rows);
    });
});

app.get('/api/meus-animais', isLoggedIn, (req, res) => {
  const uid = req.session.userId; const sql = "SELECT * FROM animais WHERE usuario_id = ? ORDER BY data_cadastro DESC";
  db.all(sql, [uid], (err, rows) => { if (err) { console.error("Erro meus animais:", err.message); return res.status(500).json({ error: "Erro interno" }); } res.json(rows); });
});

app.delete('/api/animais/:id', isLoggedIn, (req, res) => {
  const aid = req.params.id; 
  const uid = req.session.userId;

  db.get("SELECT is_admin FROM usuarios WHERE id = ?", [uid], (errU, user) => {
      if(errU || !user) return res.status(500).json({ error: "Erro permissões" }); 
      const isAdmin = user.is_admin;
    
      db.get("SELECT usuario_id, foto_public_id FROM animais WHERE id = ?", [aid], (errA, animal) => {
          if (errA) return res.status(500).json({ error: "Erro ao buscar animal." });
          if (!animal) return res.status(404).json({ error: "Animal não encontrado." });
          
          if (animal.usuario_id !== uid && !isAdmin) {
              return res.status(403).json({ error: "Sem permissão para deletar este animal." });
          }

          const sql = "DELETE FROM animais WHERE id = ?";
          db.run(sql, [aid], function(errD) {
            if (errD) { console.error("Erro delete DB:", errD.message); return res.status(500).json({ error: "Erro interno ao deletar do DB" }); }

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
          });
      });
  });
});

app.put('/api/animais/:id/status', isLoggedIn, (req, res) => {
  const aid = req.params.id; const uid = req.session.userId; const { status } = req.body;
  if (!status || !['perdido', 'encontrado'].includes(status)) { return res.status(400).json({ error: "Status inválido" }); }
  db.get("SELECT is_admin FROM usuarios WHERE id = ?", [uid], (errU, user) => {
      if(errU || !user) return res.status(500).json({ error: "Erro permissões" }); const isAdmin = user.is_admin;
      const sql = `UPDATE animais SET status = ? WHERE id = ? AND (usuario_id = ? OR ? = 1)`;
      db.run(sql, [status, aid, uid, isAdmin], function(errU) {
        if (errU) { console.error("Erro update status:", errU.message); return res.status(500).json({ error: "Erro interno" }); }
        if (this.changes === 0) { db.get("SELECT id FROM animais WHERE id = ?", [aid], (e, a) => { if (a) { return res.status(403).json({ error: "Sem permissão" }); } else { return res.status(404).json({ error: "Não encontrado" }); }}); }
        else { console.log(`Status Animal ID: ${aid} para ${status} por User ID: ${uid}`); res.json({ message: `Status alterado` }); }
      });
  });
});

app.post('/api/animais/:id/notificar-encontrado', async (req, res) => {
    const animalId = req.params.id;
    const { notificadorEmail, mensagemAdicional } = req.body; 
    const sql = "SELECT nome, tutor, email FROM animais WHERE id = ?";
    db.get(sql, [animalId], (err, animal) => {
        if (err || !animal) { return res.status(404).json({ error: "Animal não encontrado." }); }
        if (!animal.email) { return res.status(400).json({ error: "O tutor deste animal não possui e-mail cadastrado." }); }
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
    });
});

app.post('/api/register', async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) { return res.status(400).json({ error: "Campos obrigatórios" }); }
  if (!/\S+@\S+\.\S+/.test(email)) { return res.status(400).json({ error: "E-mail inválido." }); }
  if (senha.length < 6) { return res.status(400).json({ error: "Senha muito curta." }); }
  try {
    const hash = await bcrypt.hash(senha, 10); 
    const sql = "INSERT INTO usuarios (nome, email, senha_hash) VALUES (?, ?, ?)";
    db.run(sql, [nome, email, hash], function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) { return res.status(409).json({ error: "E-mail já cadastrado" }); }
        console.error("Erro DB registro:", err.message); 
        return res.status(500).json({ error: "Erro interno" });
      }
      const novoUsuarioId = this.lastID;
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
      req.session.regenerate( (errR) => { 
        if(errR) console.error("Erro regen sessão:", errR); 
        req.session.userId = novoUsuarioId;
        req.session.isAdmin = 0; 
        console.log(`User registrado: ${email} (ID: ${novoUsuarioId})`); 
        res.status(201).json({ id: novoUsuarioId, redirect: '/' }); 
      });
    });
  } catch (e) { 
      console.error("Erro bcrypt registro:", e); 
      res.status(500).json({ error: "Erro interno" }); 
  }
});

app.post('/api/esqueci-senha', (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: "E-mail obrigatório" });
    }

    db.get("SELECT * FROM usuarios WHERE email = ?", [email], (err, user) => {
        if (err || !user) {
            console.warn(`Tentativa de reset de senha para e-mail não encontrado: ${email}`);
            return res.json({ message: "Se um usuário com este e-mail existir, um link de redefinição será enviado." });
        }
        const token = crypto.randomBytes(20).toString('hex');
        const expires = Date.now() + 3600000;
        const sql = "UPDATE usuarios SET reset_token = ?, reset_expires = ? WHERE id = ?";
        db.run(sql, [token, expires, user.id], function(errUpdate) {
            if (errUpdate) {
                console.error("Erro ao salvar token no DB:", errUpdate);
                return res.status(500).json({ error: "Erro interno." });
            }

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
        });
    });
});

app.post('/api/redefinir-senha', async (req, res) => {
    const { token, senha } = req.body;
    if (!token || !senha) { return res.status(400).json({ error: "Token e nova senha são obrigatórios." }); }
    if (senha.length < 6) { return res.status(400).json({ error: "Senha deve ter no mínimo 6 caracteres." }); }
    const sql = "SELECT * FROM usuarios WHERE reset_token = ? AND reset_expires > ?";
    db.get(sql, [token, Date.now()], async (err, user) => {
        if (err || !user) {
            console.warn(`Tentativa de reset com token inválido/expirado: ${token}`);
            return res.status(400).json({ error: "Token inválido ou expirado. Solicite um novo link." });
        }
        try {
            const hash = await bcrypt.hash(senha, 10);
            const sqlUpdate = "UPDATE usuarios SET senha_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?";
            db.run(sqlUpdate, [hash, user.id], function(errUpdate) {
                if (errUpdate) {
                    console.error("Erro ao atualizar senha no DB:", errUpdate);
                    return res.status(500).json({ error: "Erro interno ao salvar senha." });
                }
                console.log(`Senha redefinida para usuário: ${user.email}`);
                res.json({ message: "Senha redefinida com sucesso! Você já pode fazer login." });
            });
        } catch (e) {
            console.error("Erro no bcrypt (redefinir):", e);
            res.status(500).json({ error: "Erro interno." });
        }
    });
});

app.post('/api/login', (req, res) => {
  const { email, senha } = req.body; 
  if (!email || !senha) { return res.status(400).json({ error: "Campos obrigatórios" }); }
  const sql = "SELECT * FROM usuarios WHERE email = ?";
  db.get(sql, [email], async (err, user) => {
    if (err) { console.error("Erro DB login:", err.message); return res.status(500).json({ error: "Erro interno" }); }
    if (!user) { return res.status(401).json({ error: "Credenciais inválidas" }); }
    try {
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
        console.error("Erro bcrypt compare:", e); 
        res.status(500).json({ error: "Erro interno" }); 
    }
  });
});

app.get('/api/logout', (req, res) => {
  const uid = req.session.userId; 
  req.session.destroy((err) => { 
      if (err) { console.error("Erro destroy sessão:", err); } 
      console.log(`User deslogado: ID ${uid || 'N/A'}`); 
      res.clearCookie('connect.sid', { path: '/' }); 
      res.redirect('/'); 
  });
});

app.get('/api/session', (req, res) => {
  if (req.session.userId) {
    const sql = "SELECT id, nome, email, is_admin FROM usuarios WHERE id = ?";
    db.get(sql, [req.session.userId], (err, user) => { 
        if (err || !user) { 
            req.session.destroy(); 
            res.clearCookie('connect.sid', { path: '/' }); 
            return res.json({ loggedIn: false }); 
        } 
        res.json({ loggedIn: true, nome: user.nome, isAdmin: user.is_admin }); 
    });
  } else { 
    res.json({ loggedIn: false }); 
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/perdidos.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'perdidos.html')));
app.get('/encontrados.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'encontrados.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/esqueci-senha.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'esqueci-senha.html')));
app.get('/redefinir.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'redefinir.html')));

app.get('/cadastro.html', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'cadastro.html'));
});

app.get('/meus-animais.html', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'meus-animais.html'));
});

app.get('/admin.html', isLoggedIn, isAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
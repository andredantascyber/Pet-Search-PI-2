async function atualizarNavegacao() {
  const navLinksList = document.getElementById('nav-links');
  const userActionsContainer = document.getElementById('user-actions');
  if (!navLinksList || !userActionsContainer) { console.error("Elementos #nav-links ou #user-actions não encontrados!"); return; }
  const heroBtn = document.getElementById('hero-cadastrar-btn');
  try {
    const response = await fetch('/api/session');
    const data = await response.json();
    let linksPrincipaisHTML = `<li><a href="index.html">Início</a></li><li><a href="perdidos.html">Animais Perdidos</a></li><li><a href="encontrados.html">Animais Encontrados</a></li>`;
    let userActionsHTML = '';
    if (data.loggedIn) {
      linksPrincipaisHTML += `<li><a href="cadastro.html">Cadastrar Animal</a></li><li><a href="meus-animais.html">Meus Animais</a></li>`;
      userActionsHTML = `<span class="ola-usuario">Olá, ${data.nome}</span><a href="/api/logout" class="sair-link">Sair</a>`;
      if (data.isAdmin) { userActionsHTML += `<a href="admin.html" class="admin-link">Admin</a>`; }
      if (heroBtn) { heroBtn.textContent = 'Cadastrar Animal'; heroBtn.href = 'cadastro.html'; heroBtn.style.display = 'inline-block'; }
    } else {
      userActionsHTML = `<a href="login.html" class="login-link">Login</a><a href="register.html" class="register-link">Cadastrar-se</a>`;
      if (heroBtn) { heroBtn.textContent = 'Conecte-se'; heroBtn.href = 'login.html'; heroBtn.style.display = 'inline-block'; }
    }
    navLinksList.innerHTML = linksPrincipaisHTML;
    userActionsContainer.innerHTML = userActionsHTML;
  } catch (error) {
    console.error('Erro ao verificar sessão:', error);
    navLinksList.innerHTML = `<li><a href="/">Início</a></li>`;
    userActionsContainer.innerHTML = `<a href="/login.html" style="color:red;">Erro</a>`;
  }
}
const API_URL = '/api';

async function salvarCadastroAnimal(event) {
  event.preventDefault();
  montarLocalizacaoCompleta();
  const formData = new FormData(event.target);
  try {
    const response = await fetch(`${API_URL}/animais`, { method: 'POST', body: formData });
    const data = await response.json();
    if (response.ok || response.status === 201) {
      alert('Animal cadastrado com sucesso!'); event.target.reset(); window.location.href = data.redirect || '/';
    } else { alert(`Erro: ${data.error}`); }
  } catch (error) { console.error('Erro:', error); alert('Erro de conexão.'); }
}
let cepTimeout;
async function buscarCep(cepValue) {
    clearTimeout(cepTimeout);
    const cepInput = document.getElementById('cep'); const logInput = document.getElementById('logradouro');
    const baiInput = document.getElementById('bairro'); const cidInput = document.getElementById('cidade');
    const estInput = document.getElementById('estado'); const numInput = document.getElementById('numero');
    const cepErr = document.getElementById('cep-error');
    const cep = cepValue.replace(/\D/g, '');
    if(cepInput) cepInput.value = cep.replace(/^(\d{5})(\d)/, '$1-$2'); if(cepErr) cepErr.textContent = '';
    if (cep.length !== 8) {
        if(logInput) logInput.value = ''; if(baiInput) baiInput.value = ''; if(cidInput) cidInput.value = ''; if(estInput) estInput.value = '';
        montarLocalizacaoCompleta(); return;
    }
    cepTimeout = setTimeout(async () => {
        console.log('Buscando CEP:', cep); try {
            if(cepErr) cepErr.textContent = 'Buscando...'; const res = await fetch(`/api/cep/${cep}`); const data = await res.json();
            if (res.ok) {
                if(cepErr) cepErr.textContent = ''; if(logInput) logInput.value = data.logradouro || ''; if(baiInput) baiInput.value = data.bairro || '';
                if(cidInput) cidInput.value = data.localidade || ''; if(estInput) estInput.value = data.uf || '';
                if(logInput) logInput.readOnly = !!data.logradouro; if(baiInput) baiInput.readOnly = !!data.bairro;
                if(cidInput) cidInput.readOnly = true; if(estInput) estInput.readOnly = true; if(numInput) numInput.focus(); montarLocalizacaoCompleta();
            } else {
                console.warn('CEP erro:', data.error); if(cepErr) cepErr.textContent = data.error || 'CEP não encontrado.';
                if(logInput){ logInput.value = ''; logInput.readOnly = false; } if(baiInput){ baiInput.value = ''; baiInput.readOnly = false; }
                if(cidInput){ cidInput.value = ''; cidInput.readOnly = true; } if(estInput){ estInput.value = ''; estInput.readOnly = true; } montarLocalizcacaoCompleta();
            }
        } catch (error) {
            console.error('Erro buscar CEP:', error); if(cepErr) cepErr.textContent = 'Erro de rede.';
            if(logInput){ logInput.value = ''; logInput.readOnly = false; } if(baiInput){ baiInput.value = ''; baiInput.readOnly = false; }
            if(cidInput){ cidInput.value = ''; cidInput.readOnly = true; } if(estInput){ estInput.value = ''; estInput.readOnly = true; } montarLocalizacaoCompleta();
        }
    }, 500);
}

function montarLocalizacaoCompleta() {
    const log = document.getElementById('logradouro')?.value || ''; const num = document.getElementById('numero')?.value || '';
    const comp = document.getElementById('complemento')?.value || ''; const bai = document.getElementById('bairro')?.value || '';
    const cid = document.getElementById('cidade')?.value || ''; const est = document.getElementById('estado')?.value || '';
    const hiddenInput = document.getElementById('localizacao_completa');
    let parts = [log]; if (num) parts.push(num); if (comp) parts.push(comp); if (bai) parts.push(bai); if (cid) parts.push(cid); if (est) parts.push(est);
    const fullAddr = parts.filter(p => p && p.trim() !== '').join(', ');
    if (hiddenInput) { hiddenInput.value = fullAddr; console.log("Localização:", hiddenInput.value); }
}

async function carregarAnimais(tipo) {
  try {
    const filtros = {
      nome: document.getElementById(`filtro-nome-${tipo}`)?.value.trim(), localizacao: document.getElementById(`filtro-local-${tipo}`)?.value.trim(),
      porte: document.getElementById(`filtro-porte-${tipo}`)?.value, cep: document.getElementById(`filtro-cep-${tipo}`)?.value.trim()
    };
    const params = new URLSearchParams({ status: tipo });
    if (filtros.nome) params.append('nome', filtros.nome);
    if (filtros.cep && filtros.cep.replace(/\D/g, '').length === 8) {
        params.append('cep', filtros.cep); const lIn = document.getElementById(`filtro-local-${tipo}`); if(lIn) lIn.value = '';
    } else if (filtros.localizacao) { params.append('localizacao', filtros.localizacao); }
    if (filtros.porte) params.append('porte', filtros.porte);
    const res = await fetch(`${API_URL}/animais?${params}`);
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Erro'); }
    const animais = await res.json(); const cont = document.getElementById(`lista-${tipo}`); if (!cont) return;
    cont.innerHTML = animais.length ? animais.map(a => { const isPerdido = tipo === 'perdido'; return `
      <div class="animal-card"> <div class="animal-imagen"><img src="${a.foto || 'src/img/placeholder.png'}" alt="Foto"></div>
        <div class="animal-info"> <h3>${a.nome || '-'}</h3> <p><strong>Porte:</strong> ${a.porte || '-'}</p> <p><strong>Raça:</strong> ${a.raca || '-'}</p>
          ${a.distanciaFormatada ? `<p><strong>Dist:</strong> ${a.distanciaFormatada}</p>` : ''}
          <div class="card-actions"> 
            <button class="btn-detalhes" onclick="toggleDetalhes(this)">Detalhes</button>
            ${isPerdido ? `<button class="btn-notificar" onclick="prepararNotificacaoDono(${a.id}, '${a.nome || 'animal'}', '${a.email}')">✉️ Notificar</button>` : ''}
          </div> 
          <div class="detalhes-completos" style="display:none;"> <p>Cor: ${a.cor||'-'}</p> <p>Gênero: ${a.genero||'-'}</p> <p>Desc: ${a.descricao||'-'}</p> <p>Local: ${a.localizacao||'-'}</p> <p>Tutor: ${a.tutor||'-'}</p> <p>Email: ${a.email||'-'}</p> <p>Tel: ${a.telefone||'-'}</p> </div>
        </div> </div> `
    }).join('') : '<p style="text-align: center; grid-column: 1 / -1; padding: 20px;">Nenhum animal encontrado para estes filtros.</p>';
  } catch (e) { console.error('Erro carregar:', e); const c = document.getElementById(`lista-${tipo}`); if (c) c.innerHTML = `<p style="color:red; text-align: center; grid-column: 1 / -1;">Erro: ${e.message}</p>`; }
}

function limparFiltro(tipo) {
  const n = document.getElementById(`filtro-nome-${tipo}`); const l = document.getElementById(`filtro-local-${tipo}`);
  const p = document.getElementById(`filtro-porte-${tipo}`); const c = document.getElementById(`filtro-cep-${tipo}`);
  if(n) n.value = ''; if(l) l.value = ''; if(p) p.value = ''; if(c) c.value = ''; carregarAnimais(tipo);
}

function configurarEventosBusca(tipo) {
  const n = document.getElementById(`filtro-nome-${tipo}`); const l = document.getElementById(`filtro-local-${tipo}`);
  const p = document.getElementById(`filtro-porte-${tipo}`); const c = document.getElementById(`filtro-cep-${tipo}`);
  if (n) n.addEventListener('input', debounce(() => carregarAnimais(tipo), 500));
  if (l) l.addEventListener('input', debounce(() => carregarAnimais(tipo), 500));
  if (p) p.addEventListener('change', () => carregarAnimais(tipo));
  if (c) c.addEventListener('input', debounce(() => carregarAnimais(tipo), 700));
}

async function carregarMeusAnimais() {
  try {
    const res = await fetch(`${API_URL}/meus-animais`);
    if (!res.ok) { const d = await res.json(); if(res.status === 401) window.location.href = '/login.html'; throw new Error(d.error || 'Erro'); }
    const animais = await res.json(); const cont = document.getElementById('lista-meus-animais'); if (!cont) return;
    cont.innerHTML = animais.length ? animais.map(a => {
      const isP = a.status === 'perdido'; const nS = isP ? 'encontrado' : 'perdido';
      const tB = isP ? 'Marcar Encontrado' : 'Marcar Perdido'; const cB = isP ? 'btn-encontrado' : 'btn-perdido';
      const dC = a.data_cadastro ? new Date(a.data_cadastro).toLocaleDateString('pt-BR') : 'N/A';
      return `
      <div class="animal-card"> <div class="animal-imagen"><img src="${a.foto || 'src/img/placeholder.png'}" alt="Foto"></div>
        <div class="animal-info"> <h3>${a.nome || '-'}</h3> <p><strong>Status:</strong> ${a.status}</p> <p><strong>Local:</strong> ${a.localizacao||'-'}</p>
          
          <div class="card-actions"> 
            <button class="btn-detalhes" onclick="toggleDetalhes(this)">Detalhes</button>
            <button class="btn-deletar" onclick="deletarAnimal(this, ${a.id})">Deletar</button>
            <button class="${cB}" onclick="mudarStatus(this, ${a.id}, '${nS}')">${tB}</button>
          </div> 
          
          <div class="detalhes-completos" style="display:none;"> <p>Porte: ${a.porte||'-'}</p> <p>Raça: ${a.raca||'-'}</p> <p>Cor: ${a.cor||'-'}</p> <p>Gênero: ${a.genero||'-'}</p> <p>Desc: ${a.descricao||'-'}</p> <hr> <p>Tutor: ${a.tutor||'-'}</p> <p>Email: ${a.email||'-'}</p> <p>Tel: ${a.telefone||'-'}</p> <p>Cad: ${dC}</p> </div>
        </div> </div> `
    }).join('') : '<p style="text-align: center; grid-column: 1 / -1; padding: 20px;">Você ainda não cadastrou nenhum animal.</p>';
  } catch (e) { console.error('Erro meus animais:', e); const c = document.getElementById('lista-meus-animais'); if (c) c.innerHTML = `<p style="color:red; text-align: center; grid-column: 1 / -1;">Erro: ${e.message}</p>`; }
}

async function deletarAnimal(button, animalId) {
  if (!confirm('Deletar cadastro?')) { return; }
  try {
    const res = await fetch(`${API_URL}/animais/${animalId}`, { method: 'DELETE' }); const d = await res.json();
    if (res.ok) {
      alert(d.message); button.closest('.animal-card').remove();
      const cont = document.getElementById('lista-meus-animais');
      // Atualiza a contagem de cards no grid
      if (cont && cont.querySelectorAll('.animal-card').length === 0) {
          cont.innerHTML = '<p style="text-align: center; grid-column: 1 / -1; padding: 20px;">Você não tem mais animais cadastrados.</p>';
      }
    } else { alert(`Erro: ${d.error}`); }
  } catch (e) { console.error('Erro deletar:', e); alert('Erro conexão.'); }
}

async function mudarStatus(button, animalId, novoStatus) {
  if (!confirm(`Alterar status para "${novoStatus}"?`)) { return; }
  try {
    const res = await fetch(`${API_URL}/animais/${animalId}/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: novoStatus }) });
    const d = await res.json();
    if (res.ok) { alert(d.message); carregarMeusAnimais(); } else { alert(`Erro: ${d.error}`); }
  } catch (e) { console.error('Erro mudar status:', e); alert('Erro conexão.'); }
}

function prepararNotificacaoDono(animalId, animalNome, donoEmail) {
    if (!donoEmail || donoEmail === 'null' || donoEmail.indexOf('@') === -1) { alert("Cadastro sem e-mail válido."); return; }
    const notificadorEmail = prompt(`Notificar dono de "${animalNome}". Informe SEU e-mail (opcional):`, "");
    const msg = prompt("Mensagem adicional? (Ex: Onde viu, seu telefone - opcional)", "");
    if (confirm(`Enviar notificação para ${donoEmail}?`)) { enviarNotificacaoDono(animalId, notificadorEmail, msg); }
}

async function enviarNotificacaoDono(animalId, notificadorEmail, msg) {
    console.log(`Notificando dono animal ${animalId}`); try {
        const res = await fetch(`${API_URL}/animais/${animalId}/notificar-encontrado`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notificadorEmail: notificadorEmail || null, mensagemAdicional: msg || null }) });
        const result = await res.json(); alert(result.message || result.error || "OK.");
    } catch (e) { console.error("Erro notificação:", e); alert("Erro conexão."); }
}

function toggleDetalhes(button) {
  let det = button.closest('.animal-info').querySelector('.detalhes-completos');
  if (det) {
      if (det.style.display === 'none' || !det.style.display) { det.style.display = 'block'; button.textContent = 'Ocultar'; }
      else { det.style.display = 'none'; button.textContent = 'Detalhes'; }
  } else { console.error('.detalhes-completos não encontrado.'); }
}

document.addEventListener('DOMContentLoaded', function() {
    console.log("DOM Carregado.");
    atualizarNavegacao();
    
    const formCadastro = document.getElementById('formCadastro');
    if (formCadastro) {
        console.log("Página Cadastro: listeners de endereço OK.");
        ['logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'estado'].forEach(id => { const i = document.getElementById(id); if (i) { i.addEventListener('input', montarLocalizacaoCompleta); i.addEventListener('change', montarLocalizacaoCompleta); } });
        montarLocalizacaoCompleta();
    }

    const path = window.location.pathname;
    if (path.includes('/perdidos') || path.endsWith('/perdidos.html')) {
        console.log("Página Perdidos: carregando...");
        carregarAnimais('perdido'); configurarEventosBusca('perdido');
    }
    if (path.includes('/encontrados') || path.endsWith('/encontrados.html')) {
        console.log("Página Encontrados: carregando...");
        carregarAnimais('encontrado'); configurarEventosBusca('encontrado');
    }
    if (path.includes('/meus-animais') || path.endsWith('/meus-animais.html')) {
        console.log("Página Meus Animais: carregando...");
        carregarMeusAnimais();
    }
});

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) { const later = () => { clearTimeout(timeout); func.apply(this, args); }; clearTimeout(timeout); timeout = setTimeout(later, wait); };
}

async function handleRegister(event) {
  event.preventDefault(); const form = event.target; const formData = new FormData(form); const data = Object.fromEntries(formData.entries());
  if (data.senha !== data.senha_confirm) { alert('Erro: As senhas não coincidem!'); return; }
  if (!data.senha || data.senha.length < 6) { alert('Erro: A senha deve ter no mínimo 6 caracteres.'); return; }
  try {
    delete data.senha_confirm;
    const res = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await res.json();
    if (res.ok || res.status === 201) { alert('Cadastro OK! Verifique seu e-mail.'); window.location.href = result.redirect || '/'; }
    else { alert(`Erro cadastro: ${result.error}`); }
  } catch (e) { console.error('Erro cadastro:', e); alert('Erro conexão.'); }
}

async function handleLogin(event) {
  event.preventDefault(); const form = event.target; const formData = new FormData(form); const data = Object.fromEntries(formData.entries());
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await res.json();
    if (res.ok) { alert('Login OK!'); window.location.href = result.redirect || '/'; }
    else { alert(`Erro: ${result.error}`); }
  } catch (e) { console.error('Erro login:', e); alert('Erro conexão.'); }
}

async function handleEsqueciSenha(event) {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    const email = form.email.value;
    button.disabled = true;
    button.innerHTML = '<span class="loader"></span>';

    try {
        const res = await fetch('/api/esqueci-senha', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email })
        });
        const result = await res.json();
        
        alert(result.message || result.error); 
        
        if (res.ok) {
            window.location.href = '/login.html';
        }
    } catch (e) {
        console.error('Erro esqueci senha:', e);
        alert('Erro de conexão.');
    } finally {
        button.disabled = false;
        button.innerHTML = 'Enviar Link';
    }
}

async function handleRedefinirSenha(event) {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    const erroDiv = document.getElementById('redefinir-erro');
    if (erroDiv) erroDiv.textContent = '';

    const senha = form.senha.value;
    const senha_confirm = form.senha_confirm.value;
    
    if (senha !== senha_confirm) {
        if (erroDiv) erroDiv.textContent = 'As senhas não coincidem!';
        return;
    }
    if (senha.length < 6) {
        if (erroDiv) erroDiv.textContent = 'Senha deve ter no mínimo 6 caracteres.';
        return;
    }
    
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    
    if (!token) {
        if (erroDiv) erroDiv.textContent = 'Token de redefinição não encontrado na URL.';
        return;
    }

    button.disabled = true;
    button.innerHTML = '<span class="loader"></span>';

    try {
        const res = await fetch('/api/redefinir-senha', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, senha: senha })
        });
        const result = await res.json();
        
        if (res.ok) {
            alert(result.message);
            window.location.href = '/login.html';
        } else {
            if (erroDiv) erroDiv.textContent = `Erro: ${result.error}`;
        }

    } catch (e) {
        console.error('Erro redefinir senha:', e);
        if (erroDiv) erroDiv.textContent = 'Erro de conexão.';
    } finally {
        button.disabled = false;
        button.innerHTML = 'Salvar Nova Senha';
    }
}
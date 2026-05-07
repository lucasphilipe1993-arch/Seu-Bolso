// public/api.js — Cliente de API compatível com dashboard.html
// <script src="/api.js"></script>

const API = {
  base: '/api',

  // ── Autenticação ──────────────────────────────────────────────
  token()   { return localStorage.getItem('gz_token'); },
  usuario() { return JSON.parse(localStorage.getItem('gz_usuario') || 'null'); },

  logout() {
    localStorage.removeItem('gz_token');
    localStorage.removeItem('gz_usuario');
    window.location.href = '/login.html';
  },

  requireAuth() {
    if (!this.token()) window.location.href = '/login.html';
  },

  headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token()}`,
    };
  },

  async _fetch(path, opts = {}) {
    try {
      const r = await fetch(this.base + path, { headers: this.headers(), ...opts });
      if (r.status === 401) { this.logout(); return null; }
      const data = await r.json();
      if (!r.ok) return { erro: data.erro || 'Erro desconhecido' };
      return data;
    } catch (err) {
      console.error('API error:', err);
      return { erro: 'Falha na conexão' };
    }
  },

  // ── Cadastro / Login ──────────────────────────────────────────
  async cadastro(nome, email, senha, telefone, plano = 'gratuito') {
    const r = await fetch(this.base + '/auth/cadastro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome, email, senha, telefone, plano }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.erro || 'Erro no cadastro');
    localStorage.setItem('gz_token', data.token);
    localStorage.setItem('gz_usuario', JSON.stringify(data.usuario));
    return data;
  },

  async login(email, senha) {
    const r = await fetch(this.base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, senha }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.erro || 'Credenciais inválidas');
    localStorage.setItem('gz_token', data.token);
    localStorage.setItem('gz_usuario', JSON.stringify(data.usuario));
    return data;
  },

  // ── Perfil ────────────────────────────────────────────────────
  // Chamado pelo dashboard como: await API.me()
  async me() {
    return this._fetch('/auth/me');
  },

  // Chamado como: await API.salvarPerfil({ nome, sobrenome, telefone })
  async salvarPerfil(dados) {
    return this._fetch('/auth/perfil', {
      method: 'PUT',
      body: JSON.stringify(dados),
    });
  },

  // Chamado como: await API.trocarSenha({ senhaAtual, novaSenha })
  async trocarSenha(dados) {
    return this._fetch('/auth/senha', {
      method: 'PUT',
      body: JSON.stringify(dados),
    });
  },

  // ── Dashboard ─────────────────────────────────────────────────
  // Chamado como: await API.resumo(mes, ano)
  // Retorna: { receita_total, despesa_total, saldo }
  async resumo(mes, ano) {
    return this._fetch(`/transactions/resumo?mes=${mes}&ano=${ano}`);
  },

  // Chamado como: await API.porCategoria(mes, ano)
  // Retorna: [{ categoria, total }]
  async porCategoria(mes, ano) {
    return this._fetch(`/transactions/por-categoria?mes=${mes}&ano=${ano}`);
  },

  // ── Transações ────────────────────────────────────────────────
  // Chamado como: await API.transacoes({ mes, ano, limit })
  // Retorna: { transacoes: [...], total }
  async transacoes(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this._fetch(`/transactions?${qs}`);
  },

  // Chamado como: await API.criarTransacao({ tipo, descricao, valor, ... })
  async criarTransacao(dados) {
    // dashboard envia: data_transacao — mapeia para data_vencimento
    const payload = {
      tipo:             dados.tipo,
      descricao:        dados.descricao,
      valor:            dados.valor,
      categoria_id:     dados.categoria_id || null,
      conta_id:         dados.conta_id || null,
      data_vencimento:  dados.data_transacao || dados.data_vencimento || null,
      pago:             true,
      origem:           'web',
    };
    return this._fetch('/transactions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // ── Contas e Categorias ───────────────────────────────────────
  async contas() {
    return this._fetch('/transactions/contas');
  },

  async categorias() {
    return this._fetch('/transactions/categorias');
  },

  // ── WhatsApp ──────────────────────────────────────────────────
  // Chamado como: await API.waStatus()
  // Retorna: { status: 'conectado'|'desconectado', numero }
  async waStatus() {
    const res = await this._fetch('/whatsapp/status');
    if (!res) return { status: 'desconectado' };
    return {
      status:  res.conectado ? 'conectado' : 'desconectado',
      numero:  res.numero || null,
    };
  },

  // Chamado como: await API.waReconectar()
  async waReconectar() {
    return this._fetch('/whatsapp/reconectar', { method: 'POST' });
  },
};

// ── Helpers de formatação usados no dashboard ────────────────
// O dashboard chama Fmt.moeda(), Fmt.data(), Fmt.mesAtual(), Fmt.anoAtual()
const Fmt = {
  moeda(valor) {
    return parseFloat(valor || 0).toLocaleString('pt-BR', {
      style: 'currency', currency: 'BRL',
    });
  },
  data(iso) {
    if (!iso) return '—';
    const d = new Date(iso + (iso.includes('T') ? '' : 'T00:00:00'));
    return d.toLocaleDateString('pt-BR');
  },
  mesAtual()  { return new Date().getMonth() + 1; },
  anoAtual()  { return new Date().getFullYear(); },
};

// ── Socket.io: repassa eventos do servidor para o dashboard ──
// O dashboard escuta window events: wa:status, wa:qr, wa:qr_clear, wa:transacao
function initSocket() {
  if (typeof io === 'undefined') return;

  // Evita múltiplas conexões
  if (window._gzSocket) {
    if (!window._gzSocket.connected) window._gzSocket.connect();
    return;
  }

  const socket = io({ transports: ['websocket', 'polling'] });
  window._gzSocket = socket;

  socket.on('status', (data) => {
    window.dispatchEvent(new CustomEvent('wa:status', { detail: data }));
  });

  socket.on('qr', (data) => {
    window.dispatchEvent(new CustomEvent('wa:qr', { detail: data }));
  });

  socket.on('qr_clear', () => {
    window.dispatchEvent(new CustomEvent('wa:qr_clear'));
  });

  // Servidor emite 'nova_transacao' — dashboard escuta 'wa:transacao'
  socket.on('nova_transacao', (data) => {
    window.dispatchEvent(new CustomEvent('wa:transacao', { detail: data }));
  });

  socket.on('numero', (data) => {
    window.dispatchEvent(new CustomEvent('wa:numero', { detail: data }));
  });

  socket.on('disconnect', () => {
    console.warn('Socket desconectado');
  });
}

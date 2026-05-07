// public/api.js — Cliente de API para o front-end
// Inclua no dashboard.html: <script src="/api.js"></script>

const GZ = {
  base: '/api',

  // ── Auth ──────────────────────────────────────────────
  token() { return localStorage.getItem('gz_token'); },
  usuario() { return JSON.parse(localStorage.getItem('gz_usuario') || 'null'); },
  logout() { localStorage.clear(); window.location.href = '/login'; },
  requireAuth() { if (!this.token()) window.location.href = '/login'; },

  headers() {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token()}` };
  },

  async fetch(path, opts = {}) {
    const r = await fetch(this.base + path, { headers: this.headers(), ...opts });
    if (r.status === 401) { this.logout(); return; }
    const data = await r.json();
    if (!r.ok) throw new Error(data.erro || 'Erro desconhecido');
    return data;
  },

  // ── Resumo dashboard ──────────────────────────────────
  async resumo(mes, ano) {
    return this.fetch(`/transactions/resumo?mes=${mes}&ano=${ano}`);
  },

  // ── Transações ────────────────────────────────────────
  async listarTransacoes(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.fetch(`/transactions?${qs}`);
  },

  async criarTransacao(dados) {
    return this.fetch('/transactions', {
      method: 'POST', body: JSON.stringify(dados)
    });
  },

  async atualizarTransacao(id, dados) {
    return this.fetch(`/transactions/${id}`, {
      method: 'PUT', body: JSON.stringify(dados)
    });
  },

  async deletarTransacao(id) {
    return this.fetch(`/transactions/${id}`, { method: 'DELETE' });
  },

  // ── Contas e categorias ───────────────────────────────
  async contas() { return this.fetch('/transactions/contas'); },
  async categorias() { return this.fetch('/transactions/categorias'); },

  // ── WhatsApp ──────────────────────────────────────────
  async statusWhatsapp() { return this.fetch('/whatsapp/status'); },
  async vincularWhatsapp(telefone) {
    return this.fetch('/whatsapp/vincular', {
      method: 'POST', body: JSON.stringify({ telefone })
    });
  },

  // ── Helpers de formatação ────────────────────────────
  formatarMoeda(valor) {
    return parseFloat(valor || 0).toLocaleString('pt-BR', {
      style: 'currency', currency: 'BRL'
    });
  },

  mesAtual() { return new Date().getMonth() + 1; },
  anoAtual() { return new Date().getFullYear(); },
};

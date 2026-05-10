// routes/auth.js
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const Stripe   = require('stripe');
const db       = require('../database/db');
const autenticar = require('../middleware/auth');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_IDS = {
  basico_mensal: process.env.STRIPE_PRICE_BASICO_MENSAL,
  basico_anual:  process.env.STRIPE_PRICE_BASICO_ANUAL,
  pro_mensal:    process.env.STRIPE_PRICE_PRO_MENSAL,
  pro_anual:     process.env.STRIPE_PRICE_PRO_ANUAL,
};

// ── Normaliza telefone → sempre sem DDI, 10 ou 11 dígitos ────
function normalizarTelefone(telefone) {
  if (!telefone) return null;
  let digits = telefone.replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length > 11) digits = digits.slice(2);
  if (digits.length < 10 || digits.length > 11) return null;
  return digits;
}

function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, email: usuario.email },
    process.env.JWT_SECRET || 'seu-segredo-super-secreto-aqui',
    { expiresIn: '30d' }
  );
}

// ── POST /api/auth/cadastro ──────────────────────────────────
router.post('/cadastro', async (req, res) => {
  const { nome, email, senha, telefone, plano, cupomCodigo, paymentMethodId } = req.body;

  if (!nome || !email || !senha)
    return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios' });

  const telefoneLimpo = normalizarTelefone(telefone);

  try {
    const existe = await db.query('SELECT id FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (existe.rows.length > 0)
      return res.status(409).json({ erro: 'E-mail já cadastrado' });

    if (telefoneLimpo) {
      const telExiste = await db.query('SELECT id FROM usuarios WHERE telefone = $1', [telefoneLimpo]);
      if (telExiste.rows.length > 0)
        return res.status(409).json({ erro: 'Número de WhatsApp já cadastrado' });
    }

    const senha_hash = await bcrypt.hash(senha, 12);

    const [primeiroNome, ...restoNome] = nome.trim().split(' ');
    const sobrenomeExtraido = restoNome.join(' ') || null;

    const { rows: usuariosInseridos } = await db.query(
      `INSERT INTO usuarios (nome, sobrenome, email, senha_hash, telefone, plano, whatsapp_ativo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, nome, sobrenome, email, plano`,
      [primeiroNome, sobrenomeExtraido, email.toLowerCase(), senha_hash,
       telefoneLimpo, 'gratuito', telefoneLimpo ? true : false]
    );

    const usuario = usuariosInseridos[0];

    // Cria conta bancária padrão
    await db.query(
      `INSERT INTO contas (usuario_id, nome, padrao, saldo) VALUES ($1, 'Carteira', true, 0)`,
      [usuario.id]
    );

    // ── Integração Stripe ─────────────────────────────────────
    if (paymentMethodId && plano && PRICE_IDS[plano]) {
      try {
        const customer = await stripe.customers.create({
          email: email.toLowerCase(),
          name: nome.trim(),
          payment_method: paymentMethodId,
          invoice_settings: { default_payment_method: paymentMethodId },
          metadata: { usuario_id: String(usuario.id) },
        });

        const subscription = await stripe.subscriptions.create({
          customer: customer.id,
          items: [{ price: PRICE_IDS[plano] }],
          trial_period_days: 7,
          expand: ['latest_invoice.payment_intent'],
        });

        const planoDb = plano.startsWith('pro') ? 'pro' : 'basico';

        await db.query(
          `UPDATE usuarios
           SET plano = $1, stripe_customer_id = $2, stripe_subscription_id = $3, whatsapp_ativo = true
           WHERE id = $4`,
          [planoDb, customer.id, subscription.id, usuario.id]
        );

        usuario.plano = planoDb;
        console.log(`✅ Assinatura Stripe criada: ${subscription.id} — plano "${planoDb}" para usuário ${usuario.id}`);

        const invoice       = subscription.latest_invoice;
        const paymentIntent = invoice?.payment_intent;
        if (paymentIntent?.status === 'requires_action') {
          const token = gerarToken(usuario);
          return res.status(201).json({
            token,
            usuario: { id: usuario.id, nome: usuario.nome, sobrenome: usuario.sobrenome, email: usuario.email, plano: usuario.plano },
            requiresAction: true,
            clientSecret: paymentIntent.client_secret,
          });
        }

      } catch (stripeErr) {
        console.error('❌ Erro Stripe no cadastro:', stripeErr.message);
        await db.query('DELETE FROM contas WHERE usuario_id = $1', [usuario.id]);
        await db.query('DELETE FROM usuarios WHERE id = $1', [usuario.id]);
        return res.status(400).json({ erro: 'Erro ao processar pagamento: ' + stripeErr.message });
      }
    }

    // ── Cupom de acesso gratuito ──────────────────────────────
    if (cupomCodigo) {
      try {
        const { rows: cupomRows } = await db.query(
          `SELECT id, dias, plano FROM cupons
           WHERE UPPER(codigo) = UPPER($1) AND ativo = true
           AND (expira_em IS NULL OR expira_em > NOW())
           AND (usos_max IS NULL OR usos_atual < usos_max)`,
          [cupomCodigo.trim()]
        );

        if (cupomRows.length > 0) {
          const cupom   = cupomRows[0];
          const expira  = new Date();
          expira.setDate(expira.getDate() + cupom.dias);

          await db.query(
            `UPDATE usuarios
             SET plano = $1, whatsapp_ativo = true,
                 cupom_codigo = $2, acesso_expira_em = $3
             WHERE id = $4`,
            [cupom.plano || 'basico', cupomCodigo.trim().toUpperCase(), expira.toISOString(), usuario.id]
          );

          await db.query(
            `UPDATE cupons SET usos_atual = usos_atual + 1 WHERE id = $1`,
            [cupom.id]
          );

          usuario.plano = cupom.plano || 'basico';
          console.log(`🎁 Cupom "${cupomCodigo}" resgatado pelo usuário ${usuario.id}`);
        }
      } catch (err) {
        console.warn('⚠️  Erro ao resgatar cupom (não crítico):', err.message);
      }
    }

    // ── Vincula WhatsApp no banco ─────────────────────────────
    if (telefoneLimpo) {
      await db.query(
        `DELETE FROM sessoes_bot
         WHERE telefone = $1
         AND usuario_id NOT IN (SELECT id FROM usuarios)`,
        [telefoneLimpo]
      );

      await db.query(
        `INSERT INTO sessoes_bot (telefone, usuario_id, estado)
         VALUES ($1, $2, 'ativo')
         ON CONFLICT (telefone) DO UPDATE
         SET usuario_id = $2, estado = 'ativo', atualizado_em = NOW()`,
        [telefoneLimpo, usuario.id]
      );

      console.log(`✅ Sessão criada para WhatsApp: ${telefoneLimpo} (Usuário: ${usuario.id})`);

      // ── Envia boas-vindas via API Oficial (Meta) ──────────
      setImmediate(async () => {
        try {
          const { botOficial } = require('./whatsapp-oficial');
          await botOficial.enviar(telefoneLimpo, botOficial.msgBemVindo(primeiroNome));
          console.log(`👋 Boas-vindas enviadas via Meta API para ${telefoneLimpo}`);
        } catch (err) {
          console.warn('⚠️  Erro ao enviar boas-vindas:', err.message);
        }
      });
    }

    const token = gerarToken(usuario);
    res.status(201).json({
      token,
      usuario: {
        id:        usuario.id,
        nome:      usuario.nome,
        sobrenome: usuario.sobrenome,
        email:     usuario.email,
        plano:     usuario.plano,
      }
    });

  } catch (err) {
    console.error('❌ Erro cadastro:', err);
    res.status(500).json({ erro: 'Erro interno ao criar conta' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha)
    return res.status(400).json({ erro: 'E-mail e senha são obrigatórios' });

  try {
    const { rows } = await db.query('SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (rows.length === 0)
      return res.status(401).json({ erro: 'Credenciais inválidas' });

    const usuario = rows[0];
    const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaOk)
      return res.status(401).json({ erro: 'Credenciais inválidas' });

    const token = gerarToken(usuario);
    res.json({
      token,
      usuario: {
        id:             usuario.id,
        nome:           usuario.nome,
        sobrenome:      usuario.sobrenome,
        email:          usuario.email,
        plano:          usuario.plano,
        whatsapp_ativo: usuario.whatsapp_ativo,
      }
    });
  } catch (err) {
    console.error('❌ Erro login:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', autenticar, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nome, sobrenome, email, telefone, plano, whatsapp_ativo, criado_em
       FROM usuarios WHERE id = $1`,
      [req.usuarioId]
    );
    if (rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── PUT /api/auth/perfil ─────────────────────────────────────
router.put('/perfil', autenticar, async (req, res) => {
  const { nome, sobrenome, telefone } = req.body;

  if (!nome || !nome.trim())
    return res.status(400).json({ erro: 'Nome é obrigatório' });

  const telefoneLimpo = normalizarTelefone(telefone) || telefone || null;

  try {
    if (telefoneLimpo) {
      const { rows } = await db.query(
        'SELECT id FROM usuarios WHERE telefone = $1 AND id != $2',
        [telefoneLimpo, req.usuarioId]
      );
      if (rows.length > 0)
        return res.status(409).json({ erro: 'Número de WhatsApp já cadastrado por outro usuário' });
    }

    const { rows } = await db.query(
      `UPDATE usuarios
       SET nome = $1, sobrenome = $2, telefone = $3, whatsapp_ativo = $4
       WHERE id = $5
       RETURNING id, nome, sobrenome, email, telefone, plano, whatsapp_ativo`,
      [nome.trim(), sobrenome?.trim() || null, telefoneLimpo,
       telefoneLimpo ? true : false, req.usuarioId]
    );

    if (telefoneLimpo) {
      await db.query(
        `DELETE FROM sessoes_bot
         WHERE telefone = $1
         AND usuario_id NOT IN (SELECT id FROM usuarios)`,
        [telefoneLimpo]
      );

      await db.query(
        `INSERT INTO sessoes_bot (telefone, usuario_id, estado)
         VALUES ($1, $2, 'ativo')
         ON CONFLICT (telefone) DO UPDATE SET usuario_id = $2, estado = 'ativo', atualizado_em = NOW()`,
        [telefoneLimpo, req.usuarioId]
      );
    }

    res.json({ usuario: rows[0] });
  } catch (err) {
    console.error('❌ Erro salvar perfil:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ── PUT /api/auth/senha ──────────────────────────────────────
router.put('/senha', autenticar, async (req, res) => {
  const { senhaAtual, novaSenha } = req.body;

  if (!senhaAtual || !novaSenha)
    return res.status(400).json({ erro: 'Senha atual e nova senha são obrigatórias' });

  if (novaSenha.length < 6)
    return res.status(400).json({ erro: 'A nova senha deve ter pelo menos 6 caracteres' });

  try {
    const { rows } = await db.query(
      'SELECT senha_hash FROM usuarios WHERE id = $1',
      [req.usuarioId]
    );
    if (rows.length === 0)
      return res.status(404).json({ erro: 'Usuário não encontrado' });

    const senhaOk = await bcrypt.compare(senhaAtual, rows[0].senha_hash);
    if (!senhaOk)
      return res.status(401).json({ erro: 'Senha atual incorreta' });

    const novoHash = await bcrypt.hash(novaSenha, 12);
    await db.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [novoHash, req.usuarioId]);

    res.json({ mensagem: 'Senha alterada com sucesso' });
  } catch (err) {
    console.error('❌ Erro trocar senha:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;

// routes/stripe.js
// ─────────────────────────────────────────────────────────────
// Integração Stripe — suporta pagamento único E assinatura
// ─────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const Stripe  = require('stripe');
const db      = require('../database/db');
const autenticar = require('../middleware/auth');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Planos configurados (ajuste os price IDs do seu Stripe Dashboard) ──
const PLANOS = {
  pro_mensal: {
    priceId: process.env.STRIPE_PRICE_PRO_MENSAL,   // ex: price_1ABC...
    tipo: 'subscription',
    nome: 'Pro Mensal',
  },
  pro_anual: {
    priceId: process.env.STRIPE_PRICE_PRO_ANUAL,    // ex: price_1XYZ...
    tipo: 'subscription',
    nome: 'Pro Anual',
  },
  // Exemplo de pagamento único (créditos, relatório avulso, etc.)
  relatorio_avulso: {
    priceId: process.env.STRIPE_PRICE_RELATORIO,    // ex: price_1DEF...
    tipo: 'payment',
    nome: 'Relatório Avulso',
  },
};

// ─────────────────────────────────────────────────────────────
// POST /api/stripe/checkout
// Cria uma Checkout Session (assinatura ou pagamento único)
// Body: { plano: 'pro_mensal' | 'pro_anual' | 'relatorio_avulso' }
// ─────────────────────────────────────────────────────────────
router.post('/checkout', autenticar, async (req, res) => {
  const { plano } = req.body;

  if (!plano || !PLANOS[plano])
    return res.status(400).json({ erro: 'Plano inválido' });

  try {
    // Busca ou cria customer Stripe para o usuário
    const { rows } = await db.query(
      'SELECT email, nome, stripe_customer_id FROM usuarios WHERE id = $1',
      [req.usuarioId]
    );
    if (rows.length === 0)
      return res.status(404).json({ erro: 'Usuário não encontrado' });

    const usuario = rows[0];
    let customerId = usuario.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: usuario.email,
        name:  usuario.nome,
        metadata: { usuario_id: String(req.usuarioId) },
      });
      customerId = customer.id;
      await db.query(
        'UPDATE usuarios SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, req.usuarioId]
      );
    }

    const config = PLANOS[plano];

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode:     config.tipo === 'subscription' ? 'subscription' : 'payment',
      line_items: [{ price: config.priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/dashboard.html?checkout=sucesso`,
      cancel_url:  `${process.env.APP_URL}/planos.html?checkout=cancelado`,
      metadata: {
        usuario_id: String(req.usuarioId),
        plano,
      },
      // Permite aplicar cupom de desconto na página de checkout
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erro Stripe checkout:', err.message);
    res.status(500).json({ erro: 'Erro ao criar sessão de pagamento' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/stripe/portal
// Abre o portal do cliente Stripe (gerenciar assinatura, faturas)
// ─────────────────────────────────────────────────────────────
router.post('/portal', autenticar, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT stripe_customer_id FROM usuarios WHERE id = $1',
      [req.usuarioId]
    );
    const customerId = rows[0]?.stripe_customer_id;

    if (!customerId)
      return res.status(400).json({ erro: 'Nenhuma assinatura encontrada' });

    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${process.env.APP_URL}/dashboard.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erro portal Stripe:', err.message);
    res.status(500).json({ erro: 'Erro ao abrir portal' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/stripe/status
// Retorna se o usuário logado tem assinatura ativa
// ─────────────────────────────────────────────────────────────
router.get('/status', autenticar, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT plano, stripe_customer_id, stripe_subscription_id FROM usuarios WHERE id = $1',
      [req.usuarioId]
    );
    const usuario = rows[0];
    res.json({
      plano: usuario?.plano || 'gratuito',
      assinaturaAtiva: usuario?.plano !== 'gratuito',
      customerId: usuario?.stripe_customer_id || null,
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/stripe/webhook
// Recebe eventos do Stripe (pagamento confirmado, cancelado, etc.)
// IMPORTANTE: Esta rota precisa receber o body RAW (não JSON parsed)
// ─────────────────────────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('⚠️  Webhook inválido:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`📦 Evento Stripe: ${event.type}`);

  try {
    switch (event.type) {

      // ── Assinatura criada ou renovada com sucesso ──
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub    = event.data.object;
        const status = sub.status; // 'active', 'trialing', 'past_due', etc.

        if (status === 'active' || status === 'trialing') {
          await db.query(
            `UPDATE usuarios
             SET plano = 'pro', stripe_subscription_id = $1, whatsapp_ativo = true
             WHERE stripe_customer_id = $2`,
            [sub.id, sub.customer]
          );
          console.log(`✅ Assinatura ativada para customer: ${sub.customer}`);
        }
        break;
      }

      // ── Assinatura cancelada ou expirada ──
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await db.query(
          `UPDATE usuarios
           SET plano = 'gratuito', stripe_subscription_id = NULL
           WHERE stripe_customer_id = $1`,
          [sub.customer]
        );
        console.log(`⚠️  Assinatura cancelada para customer: ${sub.customer}`);
        break;
      }

      // ── Pagamento único concluído (checkout.session.completed) ──
      case 'checkout.session.completed': {
        const session = event.data.object;
        const usuarioId = session.metadata?.usuario_id;
        const plano     = session.metadata?.plano;

        // Se for pagamento único (não assinatura), libera feature específica
        if (session.mode === 'payment' && usuarioId) {
          console.log(`💳 Pagamento único confirmado — usuário ${usuarioId}, plano: ${plano}`);
          // Adicione aqui a lógica para liberar acesso ao feature pago
          // Ex: await db.query('UPDATE usuarios SET relatorio_pago = true WHERE id = $1', [usuarioId])
        }
        break;
      }

      // ── Pagamento de fatura falhou ──
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn(`❌ Pagamento falhou para customer: ${invoice.customer}`);
        // Opcional: enviar aviso via WhatsApp ao usuário
        break;
      }

      default:
        // Evento não tratado — ignorar
        break;
    }
  } catch (err) {
    console.error('❌ Erro ao processar evento webhook:', err.message);
    // Retorna 200 mesmo assim para o Stripe não retentar
  }

  res.json({ received: true });
});

module.exports = router;
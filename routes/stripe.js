// routes/stripe.js
// ─────────────────────────────────────────────────────────────
// Integração Stripe — Basico (mensal/anual) + Pro (mensal/anual)
// ─────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const Stripe  = require('stripe');
const db      = require('../database/db');
const autenticar = require('../middleware/auth');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Planos configurados ────────────────────────────────────
const PLANOS = {
  basico_mensal: {
    priceId: process.env.STRIPE_PRICE_BASICO_MENSAL,
    tipo: 'subscription',
    nome: 'Básico Mensal',
    planoDb: 'basico',
  },
  basico_anual: {
    priceId: process.env.STRIPE_PRICE_BASICO_ANUAL,
    tipo: 'subscription',
    nome: 'Básico Anual',
    planoDb: 'basico',
  },
  pro_mensal: {
    priceId: process.env.STRIPE_PRICE_PRO_MENSAL,
    tipo: 'subscription',
    nome: 'Pro Mensal',
    planoDb: 'pro',
  },
  pro_anual: {
    priceId: process.env.STRIPE_PRICE_PRO_ANUAL,
    tipo: 'subscription',
    nome: 'Pro Anual',
    planoDb: 'pro',
  },
};

// POST /api/stripe/checkout
router.post('/checkout', autenticar, async (req, res) => {
  const { plano } = req.body;

  if (!plano || !PLANOS[plano])
    return res.status(400).json({ erro: 'Plano inválido. Use: basico_mensal, basico_anual, pro_mensal ou pro_anual' });

  const config = PLANOS[plano];

  if (!config.priceId) {
    console.error('❌ Price ID não configurado para: ' + plano);
    return res.status(500).json({ erro: 'Price ID do plano "' + plano + '" não configurado. Verifique as variáveis de ambiente.' });
  }

  try {
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

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: config.priceId, quantity: 1 }],
      success_url: process.env.APP_URL + '/index.html?checkout=sucesso#planos',
      cancel_url:  process.env.APP_URL + '/index.html?checkout=cancelado#planos',
      metadata: {
        usuario_id: String(req.usuarioId),
        plano,
        plano_db: config.planoDb,
      },
      allow_promotion_codes: true,
      payment_method_types: ['card'],
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erro Stripe checkout:', err.message);
    res.status(500).json({ erro: 'Erro ao criar sessão de pagamento' });
  }
});

// POST /api/stripe/portal
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
      return_url: process.env.APP_URL + '/index.html#planos',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erro portal Stripe:', err.message);
    res.status(500).json({ erro: 'Erro ao abrir portal' });
  }
});

// GET /api/stripe/status
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

// POST /api/stripe/webhook
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
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  console.log('📦 Evento Stripe: ' + event.type);

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub    = event.data.object;
        const status = sub.status;

        if (status === 'active' || status === 'trialing') {
          const priceId = sub.items?.data?.[0]?.price?.id;
          let planoDb = 'basico';
          for (const [key, cfg] of Object.entries(PLANOS)) {
            if (cfg.priceId === priceId) { planoDb = cfg.planoDb; break; }
          }
          await db.query(
            'UPDATE usuarios SET plano = $1, stripe_subscription_id = $2, whatsapp_ativo = true WHERE stripe_customer_id = $3',
            [planoDb, sub.id, sub.customer]
          );
          console.log('✅ Plano "' + planoDb + '" ativado para customer: ' + sub.customer);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await db.query(
          "UPDATE usuarios SET plano = 'gratuito', stripe_subscription_id = NULL WHERE stripe_customer_id = $1",
          [sub.customer]
        );
        console.log('⚠️  Assinatura cancelada para customer: ' + sub.customer);
        break;
      }

      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription') {
          const planoDb    = session.metadata?.plano_db;
          const customerId = session.customer;
          if (planoDb && customerId) {
            await db.query(
              'UPDATE usuarios SET plano = $1, whatsapp_ativo = true WHERE stripe_customer_id = $2',
              [planoDb, customerId]
            );
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn('❌ Pagamento falhou para customer: ' + invoice.customer);
        break;
      }
    }
  } catch (err) {
    console.error('❌ Erro ao processar evento webhook:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;

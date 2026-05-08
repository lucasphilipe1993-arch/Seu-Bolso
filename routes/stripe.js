// routes/stripe.js
// ─────────────────────────────────────────────────────────────────────
// Integração Stripe — Suporta 4 Planos de Assinatura
// Básico Mensal + Básico Anual + Premium Mensal + Premium Anual
// ─────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const autenticar = require('../middleware/auth');

// Importa Stripe com tratamento de erro
let stripe;
try {
  const Stripe = require('stripe');
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  console.log('✅ Stripe inicializado com sucesso');
} catch (err) {
  console.error('❌ Erro ao inicializar Stripe:', err.message);
}

// ── Mapeamento dos 4 Planos ────────────────────────────────────────
// Configure esses Price IDs no Stripe Dashboard:
// https://dashboard.stripe.com/products
const PLANOS = {
  basico_mensal: {
    priceId: process.env.STRIPE_PRICE_BASICO_MENSAL,
    productId: process.env.STRIPE_PRODUCT_BASICO,
    nome: 'Básico Mensal',
    valor: 'R$ 19,90/mês',
    planoDb: 'basico',
    tipo: 'subscription',
  },
  basico_anual: {
    priceId: process.env.STRIPE_PRICE_BASICO_ANUAL,
    productId: process.env.STRIPE_PRODUCT_BASICO,
    nome: 'Básico Anual',
    valor: 'R$ 199,00/ano',
    planoDb: 'basico',
    tipo: 'subscription',
  },
  premium_mensal: {
    priceId: process.env.STRIPE_PRICE_PRO_MENSAL,
    productId: process.env.STRIPE_PRODUCT_PREMIUM,
    nome: 'Premium Mensal',
    valor: 'R$ 29,90/mês',
    planoDb: 'premium',
    tipo: 'subscription',
  },
  premium_anual: {
    priceId: process.env.STRIPE_PRICE_PRO_ANUAL,
    productId: process.env.STRIPE_PRODUCT_PREMIUM,
    nome: 'Premium Anual',
    valor: 'R$ 299,00/ano',
    planoDb: 'premium',
    tipo: 'subscription',
  },
};

// ── Verificar variáveis obrigatórias ───────────────────────────────
function verificarVariaveisStripe() {
  const obrigatorias = [
    'STRIPE_SECRET_KEY',
    'STRIPE_PRICE_BASICO_MENSAL',
    'STRIPE_PRICE_BASICO_ANUAL',
    'STRIPE_PRICE_PRO_MENSAL',
    'STRIPE_PRICE_PRO_ANUAL',
    'STRIPE_WEBHOOK_SECRET',
  ];

  const faltando = [];
  obrigatorias.forEach(varName => {
    if (!process.env[varName]) {
      faltando.push(varName);
    }
  });

  if (faltando.length > 0) {
    console.warn('⚠️  AVISO CRÍTICO: Variáveis Stripe faltando no .env:');
    faltando.forEach(v => console.warn(`   - ${v}`));
    console.warn('\n📋 Configure estas variáveis no seu .env para que a integração Stripe funcione!');
  }

  return faltando.length === 0;
}

const stripeConfigOk = verificarVariaveisStripe();

// ── GET /api/stripe/config ────────────────────────────────────────
// Retorna informações sobre os planos (para debug)
router.get('/config', (req, res) => {
  const config = {};
  Object.entries(PLANOS).forEach(([key, plan]) => {
    config[key] = {
      nome: plan.nome,
      valor: plan.valor,
      priceId: plan.priceId ? '✓ Configurado' : '✗ Faltando',
    };
  });

  res.json({
    stripe_conectado: !!stripe && stripeConfigOk,
    planos: config,
    webhook_secret: process.env.STRIPE_WEBHOOK_SECRET ? '✓ Configurado' : '✗ Faltando',
  });
});

// ── POST /api/stripe/create-customer ───────────────────────────────
// Cria ou recupera um cliente Stripe
async function criarOuRecuperarCliente(usuarioId, email, nome) {
  try {
    const { rows } = await db.query(
      'SELECT stripe_customer_id FROM usuarios WHERE id = $1',
      [usuarioId]
    );

    if (rows.length > 0 && rows[0].stripe_customer_id) {
      return rows[0].stripe_customer_id;
    }

    // Cria novo cliente
    const customer = await stripe.customers.create({
      email: email,
      name: nome,
      metadata: {
        usuario_id: String(usuarioId),
      },
    });

    // Salva na DB
    await db.query(
      'UPDATE usuarios SET stripe_customer_id = $1 WHERE id = $2',
      [customer.id, usuarioId]
    );

    console.log(`✅ Cliente Stripe criado: ${customer.id}`);
    return customer.id;
  } catch (err) {
    console.error('❌ Erro ao criar cliente Stripe:', err.message);
    throw err;
  }
}

// ── POST /api/stripe/checkout-session ──────────────────────────────
// Cria uma sessão de checkout para assinatura
router.post('/checkout-session', autenticar, async (req, res) => {
  try {
    if (!stripeConfigOk) {
      return res.status(500).json({
        erro: 'Stripe não está configurado corretamente',
        detalhes: 'Verifique as variáveis de ambiente no .env',
      });
    }

    const { plano } = req.body;

    if (!plano || !PLANOS[plano]) {
      return res.status(400).json({
        erro: 'Plano inválido',
        planosDisponiveis: Object.keys(PLANOS),
      });
    }

    const planConfig = PLANOS[plano];

    if (!planConfig.priceId) {
      return res.status(500).json({
        erro: `Price ID não configurado para o plano "${plano}"`,
        variavel: `STRIPE_PRICE_${plano.toUpperCase()}`,
      });
    }

    // Busca dados do usuário
    const { rows: usuarios } = await db.query(
      'SELECT id, email, nome FROM usuarios WHERE id = $1',
      [req.usuarioId]
    );

    if (usuarios.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }

    const usuario = usuarios[0];

    // Cria ou recupera customer
    const customerId = await criarOuRecuperarCliente(usuario.id, usuario.email, usuario.nome);

    // Cria a sessão de checkout
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [
        {
          price: planConfig.priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: {
          usuario_id: String(usuario.id),
          plano_chave: plano,
          plano_nome: planConfig.nome,
        },
      },
      success_url: `${process.env.APP_URL || 'http://localhost:3000'}/login?session_id={CHECKOUT_SESSION_ID}&sucesso=true`,
      cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/cadastro?plano=${plano}&cancelado=true`,
      payment_method_types: ['card'],
      billing_address_collection: 'auto',
      allow_promotion_codes: true,
    });

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (err) {
    console.error('❌ Erro ao criar sessão de checkout:', err);
    res.status(500).json({
      erro: 'Erro ao criar sessão de pagamento',
      detalhes: err.message,
    });
  }
});

// ── POST /api/stripe/payment-intent ────────────────────────────────
// Cria um PaymentIntent para cobranças únicas (alternativa)
router.post('/payment-intent', autenticar, async (req, res) => {
  try {
    if (!stripeConfigOk) {
      return res.status(500).json({
        erro: 'Stripe não configurado corretamente',
      });
    }

    const { plano, paymentMethodId } = req.body;

    if (!plano || !PLANOS[plano]) {
      return res.status(400).json({
        erro: 'Plano inválido',
        planosDisponiveis: Object.keys(PLANOS),
      });
    }

    // Mapeia plano para valor em centavos (BRL)
    const valores = {
      basico_mensal: 1990,     // R$ 19,90
      basico_anual: 19900,     // R$ 199,00
      premium_mensal: 2999,    // R$ 29,99
      premium_anual: 29900,    // R$ 299,00
    };

    const valor = valores[plano];
    if (!valor) {
      return res.status(400).json({ erro: 'Valor do plano não encontrado' });
    }

    // Busca usuário
    const { rows: usuarios } = await db.query(
      'SELECT id, email, nome FROM usuarios WHERE id = $1',
      [req.usuarioId]
    );

    if (usuarios.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }

    const usuario = usuarios[0];

    // Cria customer
    const customerId = await criarOuRecuperarCliente(usuario.id, usuario.email, usuario.nome);

    // Cria PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: valor,
      currency: 'brl',
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: {
        usuario_id: String(usuario.id),
        plano: plano,
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      status: paymentIntent.status,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error('❌ Erro ao criar PaymentIntent:', err);
    res.status(500).json({
      erro: 'Erro ao processar pagamento',
      detalhes: err.message,
    });
  }
});

// ── GET /api/stripe/subscription-status ────────────────────────────
// Verifica o status da assinatura do usuário
router.get('/subscription-status', autenticar, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT plano, stripe_subscription_id FROM usuarios WHERE id = $1',
      [req.usuarioId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ erro: 'Usuário não encontrado' });
    }

    const usuario = rows[0];

    if (!usuario.stripe_subscription_id) {
      return res.json({
        plano: usuario.plano || 'gratuito',
        ativo: false,
      });
    }

    // Busca a assinatura no Stripe
    const subscription = await stripe.subscriptions.retrieve(usuario.stripe_subscription_id);

    res.json({
      plano: usuario.plano,
      ativo: subscription.status === 'active' || subscription.status === 'trialing',
      status: subscription.status,
      proximoVencimento: new Date(subscription.current_period_end * 1000),
      canceloAgendado: subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null,
    });
  } catch (err) {
    console.error('❌ Erro ao verificar assinatura:', err);
    res.status(500).json({
      erro: 'Erro ao verificar assinatura',
      detalhes: err.message,
    });
  }
});

// ── POST /api/stripe/cancel-subscription ───────────────────────────
// Cancela a assinatura do usuário
router.post('/cancel-subscription', autenticar, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT stripe_subscription_id FROM usuarios WHERE id = $1',
      [req.usuarioId]
    );

    if (rows.length === 0 || !rows[0].stripe_subscription_id) {
      return res.status(400).json({ erro: 'Nenhuma assinatura encontrada' });
    }

    const subscriptionId = rows[0].stripe_subscription_id;

    // Cancela a assinatura
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    res.json({
      mensagem: 'Assinatura cancelada com sucesso',
      canceloEm: new Date(subscription.cancel_at * 1000),
    });
  } catch (err) {
    console.error('❌ Erro ao cancelar assinatura:', err);
    res.status(500).json({
      erro: 'Erro ao cancelar assinatura',
      detalhes: err.message,
    });
  }
});

// ── POST /api/stripe/billing-portal ────────────────────────────────
// Redireciona para o Stripe Billing Portal
router.post('/billing-portal', autenticar, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT stripe_customer_id FROM usuarios WHERE id = $1',
      [req.usuarioId]
    );

    const customerId = rows[0]?.stripe_customer_id;

    if (!customerId) {
      return res.status(400).json({ erro: 'Nenhum cliente Stripe encontrado' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.APP_URL || 'http://localhost:3000'}/dashboard`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Erro ao criar sessão do portal:', err);
    res.status(500).json({
      erro: 'Erro ao acessar o portal de pagamentos',
      detalhes: err.message,
    });
  }
});

// ── POST /api/stripe/webhook ──────────────────────────────────────
// Processa webhooks do Stripe
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('❌ STRIPE_WEBHOOK_SECRET não configurada!');
    return res.status(400).json({ erro: 'Webhook secret não configurado' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('❌ Erro ao validar webhook:', err.message);
    return res.status(400).json({ erro: 'Assinatura do webhook inválida' });
  }

  console.log(`📦 Evento Stripe recebido: ${event.type}`);

  try {
    switch (event.type) {
      // ── Assinatura criada/atualizada ───────────────────────
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const priceId = sub.items?.data?.[0]?.price?.id;
        const customerId = sub.customer;

        let planoDb = 'premium';
        let planKey = '';

        // Encontra qual plano foi escolhido
        for (const [key, cfg] of Object.entries(PLANOS)) {
          if (cfg.priceId === priceId) {
            planoDb = cfg.planoDb;
            planKey = key;
            break;
          }
        }

        // Se a assinatura está ativa, atualiza o usuário
        if (sub.status === 'active' || sub.status === 'trialing') {
          await db.query(
            `UPDATE usuarios 
             SET plano = $1, stripe_subscription_id = $2, whatsapp_ativo = true 
             WHERE stripe_customer_id = $3`,
            [planoDb, sub.id, customerId]
          );
          console.log(`✅ Assinatura ativada: ${planKey} (${planoDb}) para customer ${customerId}`);
        }
        break;
      }

      // ── Assinatura cancelada ───────────────────────────────
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

      // ── Checkout completado ────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const customerId = session.customer;
          
          // Busca a assinatura para obter detalhes
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          const priceId = subscription.items?.data?.[0]?.price?.id;

          let planoDb = 'premium';
          for (const [key, cfg] of Object.entries(PLANOS)) {
            if (cfg.priceId === priceId) {
              planoDb = cfg.planoDb;
              break;
            }
          }

          await db.query(
            `UPDATE usuarios 
             SET plano = $1, stripe_subscription_id = $2, whatsapp_ativo = true 
             WHERE stripe_customer_id = $3`,
            [planoDb, subscription.id, customerId]
          );
          console.log(`✅ Checkout completado: plano ${planoDb} para customer ${customerId}`);
        }
        break;
      }

      // ── Pagamento falhou ───────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn(`❌ Falha no pagamento para customer: ${invoice.customer}`);
        // Aqui você pode enviar um email para o usuário, por exemplo
        break;
      }

      // ── Pagamento bem-sucedido ─────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        console.log(`✅ Pagamento bem-sucedido para customer: ${invoice.customer}`);
        break;
      }

      default:
        console.log(`📝 Evento não tratado: ${event.type}`);
    }
  } catch (err) {
    console.error('❌ Erro ao processar evento webhook:', err);
  }

  // Sempre retorna 200 para evitar retry
  res.json({ received: true });
});

module.exports = router;

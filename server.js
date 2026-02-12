require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const bodyParser = require("body-parser");

const app = express();

// ===============================
// STRIPE CONFIG
// ===============================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

// ===============================
// MIDDLEWARE NORMAL
// ===============================
app.use(cors());
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ===============================
// MOCHA INTERNAL API CALL
// ===============================
async function updateMochaSubscription(userId, plan, status, subscriptionId) {
  try {
    console.log("📡 Chamando Mocha API...");

    const response = await fetch(process.env.MOCHA_INTERNAL_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MOCHA_INTERNAL_API_KEY}`,
      },
      body: JSON.stringify({
        user_id: userId,
        plan: plan,
        status: status,
        subscription_id: subscriptionId,
      }),
    });

    const text = await response.text();
    console.log("✅ Mocha response:", text);
  } catch (error) {
    console.error("❌ Erro chamando Mocha:", error.message);
  }
}

// ===============================
// WEBHOOK STRIPE - PRODUÇÃO SAFE
// ===============================
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    // ===============================
    // 1️⃣ VALIDAR ASSINATURA STRIPE
    // ===============================
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("❌ Webhook signature error:", err.message);
      return res.sendStatus(400);
    }

    // ===============================
    // 2️⃣ RESPONDER RAPIDAMENTE PARA STRIPE
    // ===============================
    res.json({ received: true });

    // ===============================
    // 3️⃣ PROCESSAR EVENTO ASYNC
    // ===============================
    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const userId = session.metadata?.user_id;
          const plan = session.metadata?.plan_type || "pro";
          const subscriptionId = session.subscription;

          console.log("✅ Checkout completo:", userId);

          if (userId) {
            updateMochaSubscription(userId, plan, "active", subscriptionId);
          }
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription;

          const subscription = await stripe.subscriptions.retrieve(
            subscriptionId
          );
          const userId = subscription.metadata?.user_id;

          console.log("💰 Renovação paga:", subscriptionId);

          if (userId) {
            updateMochaSubscription(userId, "pro", "active", subscriptionId);
          }
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription;

          const subscription = await stripe.subscriptions.retrieve(
            subscriptionId
          );
          const userId = subscription.metadata?.user_id;

          console.log("⚠️ Pagamento falhou:", subscriptionId);

          if (userId) {
            updateMochaSubscription(userId, "pro", "past_due", subscriptionId);
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const userId = subscription.metadata?.user_id;
          const subscriptionId = subscription.id;

          console.log("🚨 Assinatura cancelada:", subscriptionId);

          if (userId) {
            updateMochaSubscription(userId, "free", "canceled", subscriptionId);
          }
          break;
        }

        default:
          console.log("ℹ️ Evento ignorado:", event.type);
      }
    } catch (error) {
      console.log("🔥 Erro processando webhook:", error);
    }
  }
);

// ===============================
// JSON NORMAL
// ===============================
app.use(express.json());

// ===============================
// CREATE CHECKOUT
// ===============================
app.post("/create-checkout", async (req, res) => {
  try {
    const { email, plan, user_id } = req.body;

    if (!email || !user_id) {
      return res.status(400).json({
        error: "Email e user_id obrigatórios",
      });
    }

    let priceId = process.env.STRIPE_PRICE_ID_MENSAL;
    if (plan === "anual") {
      priceId = process.env.STRIPE_PRICE_ID_ANUAL;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,

      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],

     success_url: 
        "https://app.formulape.com/sucesso?session_id={CHECKOUT_SESSION_ID}",

     cancel_url: 
        "https://app.formulape.com/cancelado",

      metadata: {
        user_id: user_id,
        plan_type: plan || "pro",
        app: "FormulaPe",
      },

      subscription_data: {
        metadata: {
          user_id: user_id,
          plan_type: plan || "pro",
        },
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.log("❌ Checkout erro:", error.message);
    res.status(500).json({ error: "Erro criar checkout" });
  }
});

// ===============================
// TESTE STRIPE
// ===============================
app.get("/stripe-test", async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve();
    res.json({
      ok: true,
      account: account.id,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Backend rodando porta " + PORT)
);

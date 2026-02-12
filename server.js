require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const bodyParser = require("body-parser");
const axios = require("axios"); // Axios para chamadas externas
const { createClient } = require("@supabase/supabase-js");

// ===============================
// CONFIGURAÇÕES
// ===============================
const app = express();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===============================
// MIDDLEWARE
// ===============================
app.use(cors());
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use(express.json());

// ===============================
// FUNÇÃO: ATUALIZAR MOCHA
// ===============================
async function updateMochaSubscription(userId, plan, status, subscriptionId) {
  try {
    console.log("📡 Chamando Mocha API...");

    const response = await axios.post(
      process.env.MOCHA_INTERNAL_API_URL,
      {
        user_id: userId,
        plan,
        status,
        subscription_id: subscriptionId,
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.MOCHA_INTERNAL_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Mocha response:", response.data);
  } catch (error) {
    console.error("❌ Erro chamando Mocha:", error.message);
  }
}

// ===============================
// FUNÇÃO: ATUALIZAR SUPABASE/D1
// ===============================
async function updateSupabase(userId, plan, status) {
  try {
    const { data, error } = await supabase
      .from("users") // substitua pelo nome da sua tabela
      .update({ plan, status })
      .eq("id", userId);

    if (error) {
      console.error("❌ Erro atualizando Supabase:", error.message);
    } else {
      console.log("✅ Supabase atualizado:", data);
    }
  } catch (err) {
    console.error("❌ Erro supabase catch:", err.message);
  }
}

// ===============================
// WEBHOOK STRIPE
// ===============================
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    // 1️⃣ Validar assinatura Stripe
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

    // Responder rápido para Stripe
    res.json({ received: true });

    // Processar evento async
    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const userId = session.metadata?.user_id;
          const plan = session.metadata?.plan_type || "pro";
          const subscriptionId = session.subscription;

          console.log("✅ Checkout completo:", userId);

          if (userId) {
            // Atualiza Supabase
            updateSupabase(userId, plan, "active");
            // Atualiza Mocha
            updateMochaSubscription(userId, plan, "active", subscriptionId);
          }
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const userId = subscription.metadata?.user_id;

          console.log("💰 Renovação paga:", subscriptionId);

          if (userId) {
            updateSupabase(userId, "pro", "active");
            updateMochaSubscription(userId, "pro", "active", subscriptionId);
          }
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const userId = subscription.metadata?.user_id;

          console.log("⚠️ Pagamento falhou:", subscriptionId);

          if (userId) {
            updateSupabase(userId, "pro", "past_due");
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
            updateSupabase(userId, "free", "canceled");
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
// CREATE CHECKOUT
// ===============================
app.post("/create-checkout", async (req, res) => {
  try {
    const { email, plan, user_id } = req.body;

    if (!email || !user_id) {
      return res.status(400).json({ error: "Email e user_id obrigatórios" });
    }

    let priceId = process.env.STRIPE_PRICE_ID_MENSAL;
    if (plan === "anual") {
      priceId = process.env.STRIPE_PRICE_ID_ANUAL;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://formulape2.mocha.app/assinatura?status=success",
      cancel_url: "https://formulape2.mocha.app/assinatura",
      metadata: { user_id, plan_type: plan || "pro", app: "FormulaPe" },
      subscription_data: { metadata: { user_id, plan_type: plan || "pro" } },
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
    res.json({ ok: true, account: account.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Backend rodando porta " + PORT));

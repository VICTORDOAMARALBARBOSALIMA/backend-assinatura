require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===============================
// CONFIG STRIPE
// ===============================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

// ===============================
// CONFIG SUPABASE
// ===============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ===============================
// MIDDLEWARE NORMAL
// ===============================
app.use(cors());

// IMPORTANTE: NÃO usar express.json() antes do webhook
// Vamos usar depois
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});
// ===============================
// WEBHOOK STRIPE
// ===============================
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

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

    try {
      // ==============================
      // ✅ PAGAMENTO INICIAL
      // ==============================
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const email = session.customer_email;
        const subscriptionId = session.subscription;

        console.log("✅ Checkout concluído:", email);

        await supabase.from("users").upsert({
          email,
          plan: "PRO",
          subscription_id: subscriptionId,
          subscription_status: "active",
        });
      }

      // ==============================
      // 🔁 RENOVAÇÃO (MENSAL / ANUAL)
      // ==============================
      if (event.type === "invoice.paid") {
        const invoice = event.data.object;

        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;

        console.log("💰 Renovação paga:", subscriptionId);

        // Aqui você poderia buscar email via Stripe se quiser
        await supabase
          .from("users")
          .update({
            subscription_status: "active",
            plan: "PRO",
          })
          .eq("subscription_id", subscriptionId);
      }

      // ==============================
      // ❌ PAGAMENTO FALHOU
      // ==============================
      if (event.type === "invoice.payment_failed") {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        console.log("⚠️ Pagamento falhou:", subscriptionId);

        await supabase
          .from("users")
          .update({
            subscription_status: "past_due",
          })
          .eq("subscription_id", subscriptionId);
      }

      // ==============================
      // 🚨 ASSINATURA CANCELADA
      // ==============================
      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;
        const subscriptionId = subscription.id;

        console.log("🚨 Assinatura cancelada:", subscriptionId);

        await supabase
          .from("users")
          .update({
            subscription_status: "canceled",
            plan: "FREE",
          })
          .eq("subscription_id", subscriptionId);
      }

      res.json({ received: true });
    } catch (error) {
      console.log("🔥 Webhook processing error:", error);
      res.sendStatus(500);
    }
  }
);


// ===============================
// AGORA SIM JSON NORMAL
// ===============================
app.use(express.json());

// ===============================
// CRIAR CHECKOUT
// ===============================
app.post("/create-checkout", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email obrigatório" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      payment_method_types: ["card"],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: "https://seuapp.com/sucesso",
      cancel_url: "https://seuapp.com/cancelado",
    });

    res.json({ url: session.url });
  } catch (error) {
    console.log("❌ Stripe checkout error:", error.message);

    res.status(500).json({
      error:
        "Erro ao criar checkout Stripe. Verifique chave, price e rede.",
    });
  }
});

// ===============================
// TESTE STRIPE DIRETO
// ===============================
app.get("/stripe-direct-test", async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve();

    res.json({
      success: true,
      account_id: account.id,
      charges_enabled: account.charges_enabled,
    });
  } catch (error) {
    console.log("❌ Stripe test error:", error.message);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ===============================
// CONSULTAR PLANO USER
// ===============================
app.get("/user-plan/:email", async (req, res) => {
  try {
    const { data } = await supabase
      .from("users")
      .select("plan, status")
      .eq("email", req.params.email)
      .single();

    res.json({
      plan: data?.plan || "FREE",
      status: data?.status || "inactive",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// PORTA
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Backend rodando porta ${PORT}`);
});

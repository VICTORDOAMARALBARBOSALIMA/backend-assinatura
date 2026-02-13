require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const bodyParser = require("body-parser");
const axios = require("axios"); // Substitui node-fetch
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===============================
// CONFIGURAÇÕES STRIPE
// ===============================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

// ===============================
// CONFIGURAÇÕES SUPABASE
// ===============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ===============================
// MIDDLEWARE
// ===============================
app.use(cors());
app.use(express.json());
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ===============================
// FUNÇÃO AUXILIAR - ATUALIZA SUPABASE LOCAL
// ===============================
async function upsertUserLocal(email, plan, subscription_status, subscription_id = null) {
  try {
    const upsertObj = {
      email,
      plan,
      subscription_status,
      subscription_id,
      updated_at: new Date()
    };
    const { error } = await supabase.from("users").upsert(upsertObj, { onConflict: "email" });
    if (error) console.error("❌ Erro ao atualizar Supabase:", error);
    else console.log(`✅ Supabase atualizado: ${email} → ${plan}/${subscription_status}`);
  } catch (err) {
    console.error("🔥 Erro upsertUserLocal:", err);
  }
}

// ===============================
// FUNÇÃO AUXILIAR - ATUALIZA BANCO DO MOCHA COM AXIOS
// ===============================
async function updateMochaSubscription(user_id, plan, stripe_subscription_id, stripe_customer_id) {
  try {
    const response = await axios.post(process.env.MOCHA_INTERNAL_API_URL, {
      user_id,
      plan,
      stripe_subscription_id,
      stripe_customer_id
    }, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.MOCHA_INTERNAL_API_KEY}`
      }
    });

    if (!response.data.success) console.error("❌ Mocha não atualizou:", response.data);
    else console.log("✅ Mocha atualizado com sucesso:", response.data);
  } catch (err) {
    console.error("🔥 Erro ao atualizar Mocha:", err.response?.data || err.message);
  }
}

// ===============================
// WEBHOOK STRIPE
// ===============================


// ⚡ Webhook Stripe - versão mínima
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      // valida assinatura
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // responder rápido para o Stripe
    res.status(200).send({ received: true });

    // =======================
    // Processa apenas checkout completed
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.metadata.user_id;
      const plan = session.metadata.plan || "pro";

      console.log("✅ Checkout concluído:", userId, "Plano:", plan);

      // Atualiza o Mocha
      try {
        await updateMochaSubscription(userId, plan, session.subscription, session.customer);
        console.log("✅ Plano atualizado no Mocha");
      } catch (err) {
        console.error("❌ Erro ao atualizar Mocha:", err);
      }
    }
  }
);



// ===============================
// CREATE CHECKOUT STRIPE
// ===============================
app.post("/create-checkout", async (req, res) => {
  try {
    const { email, plan, user_id } = req.body;
    if (!email || !user_id) return res.status(400).json({ error: "Email e user_id obrigatórios" });

    const priceId = plan === "anual" ? process.env.STRIPE_PRICE_ID_ANUAL : process.env.STRIPE_PRICE_ID_MENSAL;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `https://formulape2.mocha.app/assinatura?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: "https://formulape2.mocha.app/assinatura",
    metadata: {
        user_id: req.body.user_id, // <-- ESSENCIAL para o webhook do Mocha funcionar
        plan: "pro"
    }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Erro criar checkout:", err);
    res.status(500).json({ error: "Erro ao criar checkout Stripe" });
  }
});

// ===============================
// PORTA
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend rodando na porta ${PORT}`));

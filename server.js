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
// FUNÇÃO AUXILIAR IDÊNTICA / SEGURA
// ===============================
async function upsertIfChanged(table, email, plan, subscription_status, subscriptionId = null) {
  try {
    // Pega registro atual
    const { data: currentData, error: selectError } = await supabase
      .from(table)
      .select("*")
      .eq("email", email)
      .single();

    if (selectError && selectError.code !== "PGRST116") {
      console.error(`❌ Erro ao selecionar ${table}:`, selectError);
      return;
    }

    const needsUpdate =
      !currentData ||
      currentData.plan !== plan ||
      currentData.subscription_status !== subscription_status ||
      (subscriptionId && currentData.subscription_id !== subscriptionId);

    if (needsUpdate) {
      const upsertObj = { email, plan, subscription_status };
      if (subscriptionId) upsertObj.subscription_id = subscriptionId;
      if (table === "users") upsertObj.updated_at = new Date();

      const { error: upsertError } = await supabase
        .from(table)
        .upsert(upsertObj, { onConflict: "email" });

      if (upsertError) {
        console.error(`❌ Erro ao upsert ${table}:`, upsertError);
      } else {
        console.log(`✅ ${table} atualizado: ${email} → ${plan}/${subscription_status}`);
      }
    } else {
      console.log(`ℹ️ ${table} já atualizado: ${email} → ${plan}/${subscription_status}`);
    }
  } catch (err) {
    console.error(`🔥 Erro na função upsertIfChanged (${table}):`, err);
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

        let email = session.customer_email;
        const subscriptionId = session.subscription;

        if (!email && session.customer) {
          const customer = await stripe.customers.retrieve(session.customer);
          email = customer.email;
        }

        console.log("✅ Checkout concluído:", email);

        await upsertIfChanged("users", email, "PRO", "active", subscriptionId);
        await upsertIfChanged("active", email, "PRO", "active");
      }

      // ==============================
      // 🔁 RENOVAÇÃO (MENSAL / ANUAL)
      // ==============================
      if (event.type === "invoice.paid") {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        const { data: user } = await supabase
          .from("users")
          .select("email")
          .eq("subscription_id", subscriptionId)
          .single();

        if (!user?.email) {
          console.log("❌ Renovação: email não encontrado para subscription", subscriptionId);
        } else {
          console.log("💰 Renovação paga:", subscriptionId);
          await upsertIfChanged("users", user.email, "PRO", "active", subscriptionId);
          await upsertIfChanged("active", user.email, "PRO", "active");
        }
      }

      // ==============================
      // ❌ PAGAMENTO FALHOU
      // ==============================
      if (event.type === "invoice.payment_failed") {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;

        const { data: user } = await supabase
          .from("users")
          .select("email")
          .eq("subscription_id", subscriptionId)
          .single();

        if (user?.email) {
          console.log("⚠️ Pagamento falhou:", subscriptionId);
          await upsertIfChanged("users", user.email, "PRO", "past_due", subscriptionId);
          await upsertIfChanged("active", user.email, "PRO", "past_due");
        }
      }

      // ==============================
      // 🚨 ASSINATURA CANCELADA
      // ==============================
      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;
        const subscriptionId = subscription.id;

        const { data: user } = await supabase
          .from("users")
          .select("email")
          .eq("subscription_id", subscriptionId)
          .single();

        if (user?.email) {
          console.log("🚨 Assinatura cancelada:", subscriptionId);
          await upsertIfChanged("users", user.email, "FREE", "canceled", subscriptionId);
          await upsertIfChanged("active", user.email, "FREE", "canceled");
        }
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
      success_url: "https://formulape2.mocha.app/assinatura?subscription=success",
      cancel_url: "https://formulape2.mocha.app/assinatura",
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
      .from("active")
      .select("plan, subscription_status")
      .eq("email", req.params.email)
      .single();

    res.json({
      plan: data?.plan || "FREE",
      status: data?.subscription_status || "inactive",
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

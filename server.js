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
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ===============================
// FUNÇÃO AUXILIAR UPSET COM DEBUG
// ===============================
async function upsertIfChanged(table, email, plan, subscription_status, subscriptionId = null) {
  try {
    console.log(`🔹 DEBUG upsertIfChanged tabela: ${table}`);
    console.log({ email, plan, subscription_status, subscriptionId });

    // Busca registro atual
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
// WEBHOOK STRIPE ULTRA DEBUG
// ===============================
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log("❌ Webhook signature error:", err.message);
    return res.sendStatus(400);
  }

  try {
    let email;
    let subscriptionId;

    switch (event.type) {
      // ==============================
      case "checkout.session.completed": {
  const session = event.data.object;

  const userId = session.metadata?.user_id;
  subscriptionId = session.subscription; // ✅ usa a variável global

  console.log("✅ Checkout concluído user:", userId);
  console.log("✅ Subscription ID:", subscriptionId);

  if (!userId) {
    console.log("❌ user_id não encontrado no metadata");
    break;
  }

  // ===============================
  // 🔥 ATUALIZA PODOLIGIST PROFILES
  // ===============================
  const { error: profileError } = await supabase
    .from("podologist_profiles")
    .update({
      subscription_plan: "pro",
      stripe_subscription_id: subscriptionId
    })
    .eq("user_id", userId);

  if (profileError) {
    console.log("❌ Erro ao atualizar podologist_profiles:", profileError);
  } else {
    console.log("✅ podologist_profiles atualizado PRO:", userId);
  }

  // ===============================
  // 🔥 SALVA NA TABELA USERS (CRÍTICO)
  // ===============================
  if (session.customer_email) {
    const { error: userError } = await supabase
      .from("users")
      .upsert({
        email: session.customer_email,
        subscription_id: subscriptionId,
        plan: "PRO",
        subscription_status: "active",
        updated_at: new Date()
      }, { onConflict: "email" });

    if (userError) {
      console.log("❌ Erro ao salvar users:", userError);
    } else {
      console.log("✅ Users atualizado:", session.customer_email);
    }
  }

  break;
}


      // ==============================
      case "invoice.paid":
        const invoice = event.data.object;
        subscriptionId = invoice.subscription;

        // Busca email pelo subscription_id
        const { data: userPaid } = await supabase
          .from("users")
          .select("email")
          .eq("subscription_id", subscriptionId)
          .single();

        email = userPaid?.email;

        if (email) {
          console.log("💰 Renovação paga:", subscriptionId, "Email:", email);
          await upsertIfChanged("users", email, "PRO", "active", subscriptionId);
          await upsertIfChanged("active", email, "PRO", "active");
        } else {
          console.log("❌ Invoice paid: email não encontrado para subscription", subscriptionId);
        }
        break;

      // ==============================
      case "invoice.payment_failed":
        const invoiceFailed = event.data.object;
        subscriptionId = invoiceFailed.subscription;

        const { data: userFailed } = await supabase
          .from("users")
          .select("email")
          .eq("subscription_id", subscriptionId)
          .single();

        email = userFailed?.email;

        if (email) {
          console.log("⚠️ Pagamento falhou:", subscriptionId, "Email:", email);
          await upsertIfChanged("users", email, "PRO", "past_due", subscriptionId);
          await upsertIfChanged("active", email, "PRO", "past_due");
        }
        break;

      // ==============================
      case "customer.subscription.deleted":
        const subscriptionDeleted = event.data.object;
        subscriptionId = subscriptionDeleted.id;

        const { data: userDeleted } = await supabase
          .from("users")
          .select("email")
          .eq("subscription_id", subscriptionId)
          .single();

        email = userDeleted?.email;

        if (email) {
          console.log("🚨 Assinatura cancelada:", subscriptionId, "Email:", email);
          await upsertIfChanged("users", email, "FREE", "canceled", subscriptionId);
          await upsertIfChanged("active", email, "FREE", "canceled");
        }
        break;

      default:
        console.log("ℹ️ Evento Stripe ignorado:", event.type);
    }

    res.json({ received: true });
  } catch (error) {
    console.log("🔥 Webhook processing error:", error);
    res.sendStatus(500);
  }
});
// ===============================
// JSON NORMAL
// ===============================
app.use(express.json());

// ===============================
// CREATE CHECKOUT
// ===============================
app.post("/create-checkout", async (req, res) => {
  try {
    const { email, plan, user_id } = req.body; // ✅ agora recebendo user_id do frontend

    if (!email || !user_id) {
      return res.status(400).json({ error: "Email e user_id obrigatórios" });
    }

    // 🔹 Escolher Price ID correto
    let priceId = process.env.STRIPE_PRICE_ID_MENSAL; // default mensal
    if (plan === "anual") {
      priceId = process.env.STRIPE_PRICE_ID_ANUAL;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: "https://formulape2.mocha.app/assinatura?session_id={CHECKOUT_SESSION_ID}&status=success",
      cancel_url: "https://formulape2.mocha.app/assinatura",
      metadata: {
        user_id: user_id,  // ✅ metadata obrigatório para o webhook
        plan_type: plan,
        app: "FormulaPe",
      },
      subscription_data: {
        metadata: {
          user_id: user_id,
          plan_type: plan,
        },
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.log("❌ Stripe checkout error:", error.message);
    res.status(500).json({
      error: "Erro ao criar checkout Stripe. Verifique chave, price e rede.",
    });
  }
});


// ===============================
// STRIPE DIRECT TEST
// ===============================
app.get("/stripe-direct-test", async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve();
    res.json({ success: true, account_id: account.id, charges_enabled: account.charges_enabled });
  } catch (error) {
    console.log("❌ Stripe test error:", error.message);
    res.status(500).json({ success: false, error: error.message });
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

    res.json({ plan: data?.plan || "FREE", status: data?.subscription_status || "inactive" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===============================
// PORTA
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend rodando porta ${PORT}`));

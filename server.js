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
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ===============================
// FUNÇÃO AUXILIAR - ATUALIZA SUPABASE LOCAL
// ===============================
// ===============================
// FUNÇÃO AUXILIAR - CORRIGIDA
// ===============================
async function upsertUserLocal(user_id, subscription_plan, subscription_status, stripe_subscription_id, email) {
  try {
    const upsertObj = {
      user_id,
      subscription_plan,
      subscription_status,
      email,
      stripe_subscription_id,
      updated_at: new Date()
      // Removi created_at do upsert para não sobrescrever a data original de registro
    };
    
    // Certifique-se que o nome da tabela no Supabase é exatamente esse
    const { error } = await supabase.from("podologist_profiles").upsert(upsertObj, { onConflict: "email" });
    
    if (error) console.error("❌ Erro ao atualizar Supabase:", error);
    else console.log(`✅ Supabase atualizado: ${email} → ${subscription_plan}/${subscription_status}`);
  } catch (err) {
    console.error("🔥 Erro upsertUserLocal:", err);
  }
}

// ===============================
// WEBHOOK STRIPE - CORRIGIDO
// ===============================
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      
      // Capturando os dados corretamente do objeto session
      const email = session.customer_details.email; // Mais seguro que customer_email
      const user_id = session.metadata.user_id;
      const plan_type = session.metadata.plan_type || "pro"; // Pegando do metadata
      const stripe_subscription_id = session.subscription;
      const stripe_customer_id = session.customer;

      // ORDEM CORRETA: user_id, plan, status, subscription_id, email
      await upsertUserLocal(user_id, plan_type, "active", stripe_subscription_id, email);
      
      // Atualiza o sistema Mocha
      await updateMochaSubscription(user_id, plan_type, stripe_subscription_id, stripe_customer_id);

      console.log("✅ Pagamento processado com sucesso para:", email);
    }

    res.status(200).send({ received: true });
});  try {
    const upsertObj = {
      user_id,
      created_at,
      subscription_plan,
      subscription_status,
      email,
      stripe_subscription_id,
      updated_at: new Date()
    };
    const { error } = await supabase.from("podologist_profiles").upsert(upsertObj, { onConflict: "email" });
    if (error) console.error("❌ Erro ao atualizar Supabase:", error);
    else console.log(`✅ Supabase atualizado: ${email} → ${plan}/${subscription_status}`);
  } catch (err) {
    console.error("🔥 Erro upsertUserLocal:", err);
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

// Stripe webhook precisa do body como raw para validar assinatura
// webhook precisa ser antes do express.json
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
      console.log("Webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_email;
      const user_id = session.metadata.user_id;
      const stripe_subscription_id = session.subscription;
      const stripe_customer_id = session.customer;

      await upsertUserLocal(email, "pro", "active", stripe_subscription_id);
      await updateMochaSubscription(user_id, "pro", stripe_subscription_id, stripe_customer_id);

      console.log("✅ Plano PRO atualizado no Supabase e Mocha:", email);
    }

    res.status(200).send({ received: true });
  }
);

// depois de definir o webhook, você pode usar json normalmente
app.use(express.json());

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
      success_url: 'https://formulape2.mocha.app/confirmacao-pagamento?session_id={CHECKOUT_SESSION_ID}',
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

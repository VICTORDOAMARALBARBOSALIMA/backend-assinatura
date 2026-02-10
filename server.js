require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// Inicializa Stripe com a chave do ENV
const stripe = Stripe(process.env.STRIPE_SECRET);

// Inicializa Supabase com ENV
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors());

// Middleware para JSON
app.use(express.json());

// -------------------------------------------
// WEBHOOK STRIPE
// -------------------------------------------
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
      console.log("Webhook error:", err.message);
      return res.sendStatus(400);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_email;

      await supabase.from("users").upsert({
        email: email,
        plan: "PRO",
      });
    }

    res.json({ received: true });
  }
);

// -------------------------------------------
// ENDPOINT: Obter plano do usuário
// -------------------------------------------
app.get("/user-plan/:email", async (req, res) => {
  try {
    const { data } = await supabase
      .from("users")
      .select("plan")
      .eq("email", req.params.email)
      .single();

    res.json({ plan: data?.plan || "FREE" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------
// ENDPOINT: Simular pagamento (teste)
// -------------------------------------------
app.post("/fake-payment", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email obrigatório" });
  }

  await supabase.from("users").upsert({
    email: email,
    plan: "PRO",
  });

  res.json({ success: true, message: "Plano PRO ativado (FAKE)" });
});

// -------------------------------------------
// ENDPOINT: Criar sessão Stripe Checkout
// -------------------------------------------
app.post("/create-checkout", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email obrigatório" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: email,
      line_items: [
        {
          price: "price_1SemiHDWVvZht1JPyYVvNjMB", // Certifique-se que existe no Stripe
          quantity: 1,
        },
      ],
      success_url: "https://seuapp.com/sucesso",
      cancel_url: "https://seuapp.com/cancelado",
    });

    res.json({ url: session.url });
  } catch (error) {
    console.log("Stripe error:", error.message);
    res.status(500).json({
      error:
        "Ocorreu um erro na nossa conexão com o Stripe. Verifique a chave e rede.",
    });
  }
});

// -------------------------------------------
// ENDPOINT DE TESTE DIRETO DO STRIPE
// -------------------------------------------
app.get("/stripe-direct-test", async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve();

    res.json({
      success: true,
      message: "Conexão com Stripe OK!",
      account_id: account.id,
      charges_enabled: account.charges_enabled,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        "Ocorreu um erro na nossa conexão com o Stripe. Verifique a chave e rede.",
    });
  }
});

// -------------------------------------------
// PORTA DINÂMICA
// -------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));

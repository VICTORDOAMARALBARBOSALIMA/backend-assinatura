require("dotenv").config()

const express = require("express")
const bodyParser = require("body-parser")
const cors = require("cors")
const Stripe = require("stripe")
const { createClient } = require("@supabase/supabase-js")

const app = express()

const stripe = Stripe(process.env.STRIPE_SECRET)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

app.use(cors())

// WEBHOOK STRIPE
app.post("/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {

    const sig = req.headers["stripe-signature"]

    let event

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      )
    } catch (err) {
      console.log(err)
      return res.sendStatus(400)
    }

    if (event.type === "checkout.session.completed") {

      const session = event.data.object
      const email = session.customer_email

      await supabase
        .from("users")
        .upsert({
          email: email,
          plan: "PRO"
        })
    }

    res.json({ received: true })
})

// JSON normal depois
app.use(express.json())

// ENDPOINT PRO MOCHA
app.get("/user-plan/:email", async (req, res) => {

  const { data } = await supabase
    .from("users")
    .select("plan")
    .eq("email", req.params.email)
    .single()

  res.json({
    plan: data?.plan || "FREE"
  })
})

// SIMULAR PAGAMENTO (TESTE)
app.post("/fake-payment", async (req, res) => {

  const { email } = req.body

  if (!email) {
    return res.status(400).json({ error: "Email obrigatório" })
  }

  await supabase
    .from("users")
    .upsert({
      email: email,
      plan: "PRO"
    })

  res.json({
    success: true,
    message: "Plano PRO ativado (FAKE)"
  })
})


app.post("/create-checkout", async (req, res) => {

  const { email } = req.body

  try {

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",

      customer_email: email,

      line_items: [
        {
          price: "price_1SemiHDWVvZht1JPyYVvNjMB",
          quantity: 1
        }
      ],

      success_url: "https://seuapp.com/sucesso",
      cancel_url: "https://seuapp.com/cancelado"
    })

    res.json({ url: session.url })

  } catch (error) {
    res.status(500).json({ error: error.message })
  }

})

// Endpoint temporário para testar Stripe
app.get('/stripe-direct-test', async (req, res) => {
  try {
    // Inicializa Stripe com a chave do ENV
    const stripe = require('stripe')(process.env.STRIPE_SECRET);

    // Teste mínimo: busca informações da conta
    const account = await stripe.accounts.retrieve();

    res.json({
      success: true,
      message: 'Conexão com Stripe OK!',
      account_id: account.id,
      charges_enabled: account.charges_enabled
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// PORTA DINÂMICA
const PORT = process.env.PORT || 3000

app.listen(PORT, () => console.log("Rodando na porta " + PORT))



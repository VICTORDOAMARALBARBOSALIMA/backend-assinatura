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

app.listen(3000, () => console.log("Rodando"))


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

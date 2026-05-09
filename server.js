// ================================================================
//  backendsaas — Paiements abonnements SaasBuilder
//  Propriétaires de stores → vous (MrOnlineStores)
//
//  POST /create-billing-session  → créer session Stripe abonnement
//  POST /webhook                 → activer compte après paiement
//  GET  /health                  → statut
// ================================================================

import express    from "express"
import cors       from "cors"
import Stripe     from "stripe"
import dotenv     from "dotenv"
import admin      from "firebase-admin"
import bodyParser from "body-parser"
import cron       from "node-cron"

dotenv.config()

const app = express()
app.use(cors({ origin: "*" }))

// ── Firebase ────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
const db = admin.firestore()

// ── Stripe ──────────────────────────────────────────────────────
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ── Config ──────────────────────────────────────────────────────
const FRONTEND_URL = process.env.FRONTEND_URL || "https://mronlinestores.com"
const ADMIN_EMAILS = ["musmamon@gmail.com", "musrh@gmail.com"]

// Plans disponibles (centimes EUR)
const PLANS = {
  free:    { amount: 0,    label: "Plan Gratuit",     days: 0   },
  pro:     { amount: 500,  label: "Plan Pro",          days: 30  },
  premium: { amount: 2900, label: "Plan Premium",      days: 30  },
}

// ================================================================
//  WEBHOOK — AVANT express.json()
// ================================================================
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"]
    let event

    try {
      event = stripe.webhooks.constructEvent(
        req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
      )
    } catch(err) {
      console.error("❌ Webhook signature error:", err.message)
      return res.status(400).send(`Webhook Error: ${err.message}`)
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object
      console.log("📦 Webhook billing:", session.id, "| status:", session.payment_status)

      if (session.payment_status !== "paid") {
        console.log("⚠️ Paiement non confirmé")
        return res.json({ received: true })
      }

      try {
        // Parser les métadonnées
        let metadata = {}
        try {
          metadata = session.metadata?.data
            ? JSON.parse(session.metadata.data)
            : session.metadata || {}
        } catch(e) {
          metadata = session.metadata || {}
        }

        const type     = metadata.type     || session.metadata?.type     || ""
        const ownerUid = metadata.ownerUid || session.metadata?.ownerUid || ""
        const plan     = metadata.plan     || session.metadata?.plan     || "pro"
        const email    = session.customer_email || metadata.email || ""

        console.log(`🔍 type=${type} | plan=${plan} | ownerUid=${ownerUid} | email=${email}`)

        // ── Traiter uniquement les paiements d'abonnement SaaS ──
        if (type !== "billing") {
          console.log("ℹ️ Type non billing — ignoré")
          return res.json({ received: true })
        }

        if (!ownerUid && !email) {
          console.error("❌ Pas d'ownerUid ni email dans metadata")
          return res.json({ received: true })
        }

        // ── Anti-doublon ──────────────────────────────────────────
        const existing = await db.collection("billings")
          .where("sessionId", "==", session.id).get()

        if (!existing.empty) {
          console.log("⚠️ Session déjà traitée:", session.id)
          return res.json({ received: true })
        }

        // ── Calculer la nouvelle expiration (+30 jours) ──────────
        const now    = Date.now()
        const expiry = now + 30 * 24 * 60 * 60 * 1000

        // ── Données à écrire dans Firestore ──────────────────────
        const updateData = {
          plan:               plan,
          paye:               true,
          active:             true,
          subscriptionActive: true,
          expiry,
          updatedAt:          now,
        }

        // ── Trouver et mettre à jour l'utilisateur ───────────────
        let updated = false

        // 1. Par ownerUid direct
        if (ownerUid) {
          try {
            const userRef = db.collection("users").doc(ownerUid)
            const snap    = await userRef.get()
            if (snap.exists) {
              await userRef.set(updateData, { merge: true })
              console.log(`✅ User activé (uid direct): ${ownerUid} | plan: ${plan} | expiry: ${new Date(expiry).toISOString()}`)
              updated = true
            }
          } catch(e) { console.warn("uid direct:", e.message) }
        }

        // 2. Par email si pas trouvé
        if (!updated && email) {
          try {
            const q = await db.collection("users")
              .where("email", "==", email.toLowerCase().trim()).get()
            if (!q.empty) {
              await q.docs[0].ref.set(updateData, { merge: true })
              console.log(`✅ User activé (email): ${email} | plan: ${plan}`)
              updated = true
            }
          } catch(e) { console.warn("email lookup:", e.message) }
        }

        if (!updated) {
          console.error(`❌ Aucun user trouvé pour ownerUid=${ownerUid} email=${email}`)
        }

        // ── Enregistrer le billing dans Firestore ─────────────────
        await db.collection("billings").add({
          sessionId:  session.id,
          ownerUid:   ownerUid || "",
          email:      email,
          plan,
          amount:     (session.amount_total || 0) / 100,
          expiry,
          status:     "paid",
          provider:   "stripe",
          createdAt:  admin.firestore.FieldValue.serverTimestamp(),
        })

        console.log(`✅ Billing enregistré | montant: ${(session.amount_total||0)/100}€`)

      } catch(err) {
        console.error("❌ Webhook billing error:", err.message)
      }
    }

    res.json({ received: true })
  }
)

// ── Middleware JSON pour les autres routes ───────────────────────
app.use(express.json())

// ================================================================
//  POST /create-billing-session
//  Créer une session Stripe Checkout pour l'abonnement
// ================================================================
app.post("/create-billing-session", async (req, res) => {
  try {
    const { email, plan, ownerUid } = req.body

    if (!ownerUid) return res.status(400).json({ error: "ownerUid requis" })
    if (!email)    return res.status(400).json({ error: "email requis" })

    const planConfig = PLANS[plan] || PLANS.pro
    if (planConfig.amount === 0) {
      return res.status(400).json({ error: "Le plan gratuit ne nécessite pas de paiement" })
    }

    console.log(`💳 Billing session: ${email} | plan: ${plan} | ${planConfig.amount/100}€`)

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email:       email,
      line_items: [{
        price_data: {
          currency:     "eur",
          product_data: { name: `${planConfig.label} — MrOnlineStores` },
          unit_amount:  planConfig.amount,
        },
        quantity: 1,
      }],
      mode:        "payment",
      success_url: `${FRONTEND_URL}/#/dashboard?success=1&plan=${plan}`,
      cancel_url:  `${FRONTEND_URL}/#/dashboard`,
      metadata: {
        data: JSON.stringify({
          type:     "billing",
          plan,
          ownerUid,
          email,
        }),
        // Champs directs (backup)
        type:     "billing",
        plan,
        ownerUid,
        email,
      },
    })

    console.log(`✅ Session créée: ${session.id} | url: ${session.url}`)
    res.json({ url: session.url })

  } catch(err) {
    console.error("❌ create-billing-session:", err.message)
    res.status(500).json({ error: err.message })
  }
})

// ================================================================
//  CRON — Désactiver les comptes expirés (1h00 chaque nuit)
// ================================================================
const checkExpiredAccounts = async () => {
  console.log("[CRON] 🔍 Vérification comptes expirés...")
  const now = Date.now()
  let disabled = 0

  try {
    const snap = await db.collection("users")
      .where("active",  "==", true)
      .where("expiry",  "<",  now)
      .get()

    for (const doc of snap.docs) {
      const data = doc.data()
      if (ADMIN_EMAILS.includes(data.email?.toLowerCase())) continue
      if (data.plan === "free" || !data.expiry) continue

      await doc.ref.set({
        active:             false,
        subscriptionActive: false,
        paye:               false,
        suspendedAt:        now,
        suspendedReason:    "expiry",
      }, { merge: true })

      console.log(`[CRON] 🔒 Suspendu: ${data.email} | expiry: ${new Date(data.expiry).toISOString()}`)
      disabled++
    }
    console.log(`[CRON] ✅ ${disabled} compte(s) suspendu(s) sur ${snap.size} vérifié(s)`)
  } catch(e) {
    console.error("[CRON] ❌", e.message)
  }
  return { checked: snap?.size || 0, disabled }
}

cron.schedule("0 1 * * *", () => {
  console.log("[CRON] ⏰ Check expiry quotidien")
  checkExpiredAccounts()
})

// ================================================================
//  POST /api/admin/check-expiry  — Déclencher manuellement
// ================================================================
app.post("/api/admin/check-expiry", async (req, res) => {
  const { idToken } = req.body
  if (!idToken) return res.status(401).json({ error: "Non authentifié" })
  try {
    const decoded = await admin.auth().verifyIdToken(idToken)
    if (!ADMIN_EMAILS.includes(decoded.email?.toLowerCase())) {
      return res.status(403).json({ error: "Non autorisé" })
    }
    const result = await checkExpiredAccounts()
    res.json({ success: true, ...result })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ================================================================
//  GET /health
// ================================================================
app.get("/health", (req, res) => {
  res.json({
    status:  "ok",
    service: "backendsaas — Abonnements MrOnlineStores",
    stripe:  process.env.STRIPE_SECRET_KEY ? "✅" : "❌ manquante",
    webhook: process.env.STRIPE_WEBHOOK_SECRET ? "✅" : "❌ manquant",
    endpoints: [
      "POST /create-billing-session",
      "POST /webhook",
      "POST /api/admin/check-expiry",
      "GET  /health",
    ]
  })
})

// ================================================================
//  START
// ================================================================
const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log(`🚀 backendsaas en ligne sur port ${PORT}`)
  console.log(`💳 Stripe:  ${process.env.STRIPE_SECRET_KEY   ? "✅" : "❌ STRIPE_SECRET_KEY manquant"}`)
  console.log(`🔑 Webhook: ${process.env.STRIPE_WEBHOOK_SECRET ? "✅" : "❌ STRIPE_WEBHOOK_SECRET manquant"}`)
  console.log(`⏰ Cron:    vérification expiry tous les jours à 01h00`)
})

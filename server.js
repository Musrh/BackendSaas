//stripe-backend 
import express from "express";
import cors from "cors";
import Stripe from "stripe";
import dotenv from "dotenv";
import admin from "firebase-admin";
import bodyParser from "body-parser";

dotenv.config();
const app = express();
app.use(cors({ origin: "*" }));

// ================= FIREBASE =================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ================= STRIPE =================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 🔴 IMPORTANT : webhook AVANT express.json()
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      // 🎯 Paiement terminé
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        console.log("📦 Session Stripe:", session.id);
        console.log("💰 Payment status:", session.payment_status);

        // 🔐 Vérification obligatoire
        if (session.payment_status === "paid") {

          // 🔁 Protection anti-doublon
          const existing = await db
            .collection("commandes")
            .where("sessionId", "==", session.id)
            .get();

          if (!existing.empty) {
            console.log("⚠️ Session déjà enregistrée");
            return res.json({ received: true });
          }

          const metadata = session.metadata
            ? JSON.parse(session.metadata.data)
            : {};

          await db.collection("commandes").add({
            email: session.customer_email,
            items: metadata.items || [],
            montant: session.amount_total / 100,
            adresse: metadata.adresseLivraison || "",
            paymentMethod: "stripe",
            sessionId: session.id,
            status: "paid",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          console.log("✅ Commande Stripe enregistrée dans Firestore");
        } else {
          console.log("⚠️ Paiement non confirmé, rien enregistré");
        }
      }

      res.json({ received: true });

    } catch (err) {
      console.error("❌ Webhook Stripe error:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// ✅ Middleware JSON pour les autres routes
app.use(express.json());

// ================= CREATION SESSION =================
app.post("/create-stripe-session", async (req, res) => {
  try {
    const { items, email, adresseLivraison } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: email,
      line_items: items.map((item) => ({
        price_data: {
          currency: "eur",
          product_data: {
            name: item.nom,
          },
          unit_amount: Math.round(item.prix * 100),
        },
        quantity: item.quantity,
      })),
      mode: "payment",
      success_url:
        "https://musrh.github.io/SaasBuilder/#/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:
        "https://musrh.github.io/SaasBuilder/#/cancel",
      metadata: {
        data: JSON.stringify({
          items,
          adresseLivraison,
        }),
      },
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error("❌ Erreur création session:", err);
    res.status(500).json({ error: "Erreur création session Stripe" });
  }
});

// ================= START SERVER =================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("🚀 Serveur Stripe en ligne sur port", PORT)
);

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

const hdrs = {
  "Content-Type":"application/json",
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"Content-Type",
  "Access-Control-Allow-Methods":"POST, OPTIONS"
};

export const handler = async (event) => {
  try{
    if (event.httpMethod === "OPTIONS") return { statusCode:200, headers:hdrs, body: JSON.stringify({ ok:true }) };
    if (event.httpMethod !== "POST")    return { statusCode:405, headers:hdrs, body: JSON.stringify({ error:"Method Not Allowed" }) };

    const body = JSON.parse(event.body || "{}");
    const { businessName } = body; // optional, for metadata

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: process.env.STRIPE_SUCCESS_URL,
      cancel_url: process.env.STRIPE_CANCEL_URL,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { businessName: businessName || "" }
      },
      metadata: { product: "Nora Voice Assistant" }
    });

    return { statusCode:200, headers:hdrs, body: JSON.stringify({ url: session.url }) };
  }catch(e){
    return { statusCode:500, headers:hdrs, body: JSON.stringify({ error: String(e.message||e) }) };
  }
};

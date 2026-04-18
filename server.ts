import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import fs from 'fs';

dotenv.config();

// Initialize Firebase Admin
let db: Firestore;

try {
  const firebaseConfigPath = path.join(process.cwd(), 'src', 'firebase-applet-config.json');
  let firebaseConfig: any = {};
  
  if (fs.existsSync(firebaseConfigPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8'));
  }

  // Allow environment variables to override file config
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || firebaseConfig.projectId;
  const dbId = process.env.VITE_FIREBASE_DATABASE_ID || firebaseConfig.firestoreDatabaseId;
  const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;

  console.log('Initializing Firebase Admin');
  
  let adminConfig: admin.AppOptions = {};
  if (serviceAccountVar) {
    try {
      const serviceAccount = JSON.parse(serviceAccountVar);
      adminConfig.credential = admin.credential.cert(serviceAccount);
      console.log('Using service account from environment variable');
    } catch (e) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT env var as JSON');
    }
  } else if (projectId) {
    adminConfig.projectId = projectId;
  }

  const app = admin.apps.length === 0 
    ? admin.initializeApp(adminConfig) 
    : admin.app();
    
  const finalDbId = dbId && dbId !== '(default)' ? dbId : undefined;
    
  db = getFirestore(app, finalDbId);
  console.log(`Firebase Admin initialized (Database: ${finalDbId || 'default'})`);

  // Test connection
  db.collection('settings').limit(1).get()
    .then(() => console.log('Firestore connection test successful'))
    .catch(err => console.error('Firestore connection test failed:', err.message));
} catch (error) {
  console.error('Error initializing Firebase Admin:', error);
}

async function sendConfirmationEmail(to: string, name: string, adult: number, child: number, pmr: number, ticketHolders?: any[], reservationId?: string) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return;

  try {
    const senderEmail = process.env.BREVO_SENDER_EMAIL || 'no-reply@etviedanse.com';
    const senderName = process.env.BREVO_SENDER_NAME || 'Association Et vie danse';
    const appUrl = process.env.APP_URL || 'https://ais-dev-fx6kwd7qvtdrkjxdqmpd7i-11794025507.europe-west2.run.app';

    const adminLink = reservationId ? `${appUrl}/?view=admin-check&resId=${reservationId}` : null;

    const ticketHoldersTable = ticketHolders && ticketHolders.length > 0 
      ? `
        <table style="width: 100%; border-collapse: collapse; margin-top: 16px; border: 1px solid #e5e7eb;">
          <thead>
            <tr style="background-color: #f9fafb;">
              <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb; color: #4b5563; font-size: 14px;">Participant</th>
              <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb; color: #4b5563; font-size: 14px;">Type de place</th>
            </tr>
          </thead>
          <tbody>
            ${ticketHolders.map((th) => `
              <tr>
                <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px; font-weight: 500;">${th.firstName} ${th.lastName}</td>
                <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">${th.type === 'adult' ? 'Adulte' : th.type === 'child' ? 'Enfant' : 'PMR'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `
      : '';

    const ticketLink = reservationId ? `${appUrl}/?view=tickets&resId=${reservationId}` : null;

    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: senderName, email: senderEmail },
      to: [{ email: to }],
      subject: "Confirmation de commande - Preuve d'achat Gala",
      htmlContent: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="color: #4f46e5; font-size: 28px; font-weight: 800; margin-bottom: 4px; text-transform: uppercase;">ET VIE DANSE</h1>
            <h2 style="color: #111827; font-size: 20px; font-weight: 700; margin-top: 0; margin-bottom: 8px;">CONFIRMATION DE COMMANDE</h2>
            <p style="color: #6b7280; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Référence : <strong>${reservationId?.substring(0, 8).toUpperCase()}</strong></p>
          </div>

          <div style="background: #fef2f2; border: 1px solid #fee2e2; padding: 16px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
            <p style="color: #b91c1c; font-weight: bold; margin: 0; font-size: 14px;">⚠️ CET EMAIL FAIT OFFICE DE PREUVE D'ACHAT ⚠️</p>
            <p style="color: #b91c1c; margin: 4px 0 0 0; font-size: 12px;">Veuillez présenter cet email (imprimé ou sur votre téléphone) à l'entrée du spectacle.</p>
          </div>

          <p style="color: #4b5563; font-size: 16px; line-height: 24px;">Bonjour ${name},</p>
          <p style="color: #4b5563; font-size: 16px; line-height: 24px;">Nous vous confirmons la réception de votre commande pour le Gala. Voici le récapitulatif de vos places :</p>
          
          <div style="margin-top: 24px;">
            <h3 style="color: #111827; font-size: 18px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 16px;">Détail des participants</h3>
            ${ticketHoldersTable}
          </div>

          <div style="margin-top: 24px; padding: 16px; background: #f9fafb; border-radius: 8px;">
            <h3 style="color: #111827; font-size: 16px; margin-top: 0; margin-bottom: 12px;">Récapitulatif</h3>
            <ul style="margin: 0; padding-left: 20px; color: #4b5563; font-size: 14px;">
              ${adult > 0 ? `<li>Places Adulte (13+) : <strong>${adult}</strong></li>` : ''}
              ${child > 0 ? `<li>Places Enfant (-12) : <strong>${child}</strong></li>` : ''}
              ${pmr > 0 ? `<li>Places PMR : <strong>${pmr}</strong></li>` : ''}
            </ul>
          </div>
          
          ${ticketLink ? `
          <div style="margin-top: 32px; text-align: center;">
            <a href="${ticketLink}" style="background: #4f46e5; color: white; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.2);">Voir ma preuve d'achat en ligne</a>
          </div>
          ` : ''}
          
          <hr style="margin: 32px 0; border: 0; border-top: 1px solid #e5e7eb;" />
          <p style="color: #9ca3af; font-size: 12px; text-align: center;">Association Et vie danse - Cet email a été envoyé automatiquement.</p>
          
          <div style="margin-top: 40px; padding: 12px; background: #f9fafb; border-radius: 8px; border: 1px dashed #d1d5db;">
            <p style="margin: 0; font-size: 10px; color: #9ca3af; text-align: center;">Lien réservé à l'administration : <a href="${adminLink}" style="color: #6366f1;">Vérifier la conformité</a></p>
          </div>
        </div>
      `
    }, {
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error sending confirmation email:', error);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // --- HELLOASSO INTEGRATION ---
  let helloAssoToken: string | null = null;
  let tokenExpiry: number = 0;

  // HelloAsso API domain based on mode
  const HELLOASSO_API_DOMAIN = process.env.HELLOASSO_MODE === 'sandbox'
    ? 'api.helloasso-sandbox.com'
    : 'api.helloasso.com';

  async function getHelloAssoToken() {
    if (helloAssoToken && Date.now() < tokenExpiry) {
      return helloAssoToken;
    }

    const clientId = process.env.HELLOASSO_CLIENT_ID;
    const clientSecret = process.env.HELLOASSO_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error('HelloAsso credentials missing: HELLOASSO_CLIENT_ID or HELLOASSO_CLIENT_SECRET');
      throw new Error('HelloAsso credentials missing');
    }

    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('grant_type', 'client_credentials');

    try {
      const response = await axios.post(`https://${HELLOASSO_API_DOMAIN}/oauth2/token`, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      helloAssoToken = response.data.access_token;
      tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
      return helloAssoToken;
    } catch (error: any) {
      console.error('Error getting HelloAsso token:', error.response?.data || error.message);
      throw error;
    }
  }

  // API routes go here
  app.get("/api/health", async (req, res) => {
    let firestoreStatus = 'unknown';
    if (db) {
      try {
        await db.collection('settings').limit(1).get();
        firestoreStatus = 'connected';
      } catch (err: any) {
        firestoreStatus = `error: ${err.message}`;
      }
    } else {
      firestoreStatus = 'not initialized';
    }
    res.json({ status: "ok", firestore: firestoreStatus });
  });

  app.post('/api/helloasso/checkout', async (req, res) => {
    try {
      const token = await getHelloAssoToken();
      const { amount, label, buyer, metadata } = req.body;

      const response = await axios.post(
        `https://${HELLOASSO_API_DOMAIN}/v5/organizations/${process.env.HELLOASSO_ORGANIZATION_SLUG}/checkout-intents`,
        {
          totalAmount: Math.round(amount * 100), // in cents
          initialAmount: Math.round(amount * 100),
          itemName: label,
          backUrl: `${process.env.APP_URL}/?payment=cancel`,
          errorUrl: `${process.env.APP_URL}/?payment=error`,
          returnUrl: `${process.env.APP_URL}/payment-success?type=return`,
          containsDonation: false,
          payer: {
            firstName: buyer.firstName,
            lastName: buyer.lastName,
            email: buyer.email,
          },
          metadata: metadata
        },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      res.json({ redirectUrl: response.data.redirectUrl, id: response.data.id });
    } catch (error: any) {
      if (error.response) {
        console.error('HelloAsso Checkout Error Details:', JSON.stringify(error.response.data, null, 2));
      } else {
        console.error('HelloAsso Checkout Error:', error.message);
      }
      res.status(error.response?.status || 500).json({ 
        error: 'Failed to create checkout intent',
        details: error.response?.data || error.message
      });
    }
  });

  // Check HelloAsso Checkout Status
  app.get('/api/helloasso/check-status/:id', async (req, res) => {
    try {
      const token = await getHelloAssoToken();
      const { id } = req.params;

      console.log(`Checking HelloAsso status for ID: ${id}`);

      if (!id || id === 'null' || id === 'undefined') {
        console.error('Invalid ID provided to check-status');
        return res.status(400).json({ error: 'Invalid ID' });
      }

      const url = `https://${HELLOASSO_API_DOMAIN}/v5/organizations/${process.env.HELLOASSO_ORGANIZATION_SLUG}/checkout-intents/${id}`;
      console.log(`Calling HelloAsso API: ${url}`);

      const response = await axios.get(
        url,
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      const intent = response.data;
      const status = intent.orderStatus || (intent.order ? 'Success' : 'Wait');
      console.log(`HelloAsso response for ${id}:`, status);
      
      if (status === 'Success') {
        // Update Firestore
        if (!db) {
          console.error('Firestore DB not initialized');
          intent.firestoreUpdateError = 'Firestore DB not initialized';
        } else {
          console.log(`Searching for reservation with helloAssoId: ${id}`);
          try {
            const numericId = parseInt(id);
            let reservationsSnap;
            
            if (!isNaN(numericId)) {
              reservationsSnap = await db.collection('reservations')
                .where('helloAssoId', '==', numericId)
                .get();
            }

            if (!reservationsSnap || reservationsSnap.empty) {
              // Try string version if numeric failed or returned nothing
              reservationsSnap = await db.collection('reservations')
                .where('helloAssoId', '==', id)
                .get();
            }

            console.log(`Found ${reservationsSnap.size} reservations for ID ${id}`);

            if (!reservationsSnap.empty) {
              const reservationDoc = reservationsSnap.docs[0];
              const reservationData = reservationDoc.data();
              intent.reservationId = reservationDoc.id;

              if (reservationData.status === 'pending') {
                await reservationDoc.ref.update({ status: 'completed' });
                console.log(`Reservation ${reservationDoc.id} marked as completed`);
                
                // Send confirmation email
                await sendConfirmationEmail(
                  reservationData.buyerEmail, 
                  reservationData.buyerName, 
                  reservationData.adultCount || 0, 
                  reservationData.childCount || 0, 
                  reservationData.pmrCount || 0,
                  reservationData.ticketHolders,
                  reservationDoc.id
                );
                
                // Update member tickets if applicable
                if (reservationData.dancerCode && reservationData.dancerCode !== 'PHASE_2') {
                  const memberRef = db.collection('members').doc(reservationData.dancerCode);
                  const memberDoc = await memberRef.get();
                  if (memberDoc.exists) {
                    const currentTickets = memberDoc.data()?.ticketsBought || 0;
                    await memberRef.update({ 
                      ticketsBought: currentTickets + (reservationData.adultCount || 0) + (reservationData.childCount || 0) + (reservationData.pmrCount || 0)
                    });
                    console.log(`Member ${reservationData.dancerCode} tickets updated`);
                  }
                }
              } else {
                console.log(`Reservation ${reservationDoc.id} already has status: ${reservationData.status}`);
              }
            } else {
              console.warn(`No reservation found in Firestore for helloAssoId: ${id}`);
            }
          } catch (fsError: any) {
            console.error('Firestore Query Error:', fsError);
            intent.firestoreUpdateError = fsError.message;
          }
        }
      } else if (['Refused', 'Canceled'].includes(status)) {
        if (db) {
          const numericId = parseInt(id);
          let reservationsSnap;
          
          if (!isNaN(numericId)) {
            reservationsSnap = await db.collection('reservations')
              .where('helloAssoId', '==', numericId)
              .get();
          }

          if (!reservationsSnap || reservationsSnap.empty) {
            reservationsSnap = await db.collection('reservations')
              .where('helloAssoId', '==', id)
              .get();
          }
          
          if (reservationsSnap && !reservationsSnap.empty) {
            const reservationDoc = reservationsSnap.docs[0];
            if (reservationDoc.data().status === 'pending') {
              await reservationDoc.ref.update({ status: 'cancelled' });
            }
          }
        }
      }

      res.json(intent);
    } catch (error: any) {
      if (error.response) {
        console.error(`HelloAsso API Error (${error.response.status}) for ID ${req.params.id}:`, JSON.stringify(error.response.data, null, 2));
      } else {
        console.error('Check Status Error:', error.message);
      }
      res.status(error.response?.status || 500).json({ 
        error: 'Failed to check status',
        details: error.response?.data || error.message,
        id: req.params.id
      });
    }
  });

  // HelloAsso Webhook
  app.post('/api/helloasso/webhook', async (req, res) => {
    try {
      const { eventType, data } = req.body;
      console.log(`Received Webhook: ${eventType}`, data);

      if (eventType === 'Order' || (eventType === 'Payment' && data.status === 'Authorized')) {
        // For checkout intents, we usually get an Order event
        const helloAssoId = data.id || data.checkoutIntentId;
        
        if (helloAssoId) {
          const reservationsSnap = await db.collection('reservations')
            .where('helloAssoId', '==', parseInt(helloAssoId))
            .get();

          for (const doc of reservationsSnap.docs) {
            const resData = doc.data();
            if (resData.status === 'pending') {
              await doc.ref.update({ status: 'completed' });
              
              // Send confirmation email
              await sendConfirmationEmail(
                resData.buyerEmail, 
                resData.buyerName, 
                resData.adultCount || 0, 
                resData.childCount || 0, 
                resData.pmrCount || 0,
                resData.ticketHolders,
                doc.id
              );

              // Update member tickets
              if (resData.dancerCode && resData.dancerCode !== 'PHASE_2') {
                const memberRef = db.collection('members').doc(resData.dancerCode);
                const memberDoc = await memberRef.get();
                if (memberDoc.exists) {
                  const currentTickets = memberDoc.data()?.ticketsBought || 0;
                  await memberRef.update({ 
                    ticketsBought: currentTickets + (resData.adultCount || 0) + (resData.childCount || 0) + (resData.pmrCount || 0)
                  });
                }
              }
            }
          }
        }
      }
      res.sendStatus(200);
    } catch (error: any) {
      console.error('Webhook Error:', error.message);
      res.sendStatus(500);
    }
  });

  // --- BREVO INTEGRATION ---
  app.post('/api/email/send', async (req, res) => {
    const { to, subject, htmlContent } = req.body;
    const apiKey = process.env.BREVO_API_KEY;

    if (!apiKey) {
      console.error('BREVO_API_KEY is not defined in environment variables');
      return res.status(500).json({ error: 'Email service not configured (missing API key)' });
    }

    try {
      const senderEmail = process.env.BREVO_SENDER_EMAIL || 'no-reply@gala-manager.com';
      const senderName = process.env.BREVO_SENDER_NAME || 'Gala Manager';

      await axios.post('https://api.brevo.com/v3/smtp/email', {
        sender: { name: senderName, email: senderEmail },
        to: [{ email: to }],
        subject: subject,
        htmlContent: htmlContent
      }, {
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json'
        }
      });
      res.json({ success: true });
    } catch (error: any) {
      const errorData = error.response?.data;
      console.error('Brevo Email Error Detail:', JSON.stringify(errorData, null, 2));
      res.status(error.response?.status || 500).json({ 
        error: 'Failed to send email', 
        details: errorData?.message || error.message,
        code: errorData?.code
      });
    }
  });

  // --- VITE MIDDLEWARE ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

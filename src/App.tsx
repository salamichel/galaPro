import React, { useState, useEffect, useCallback, Component, ReactNode } from 'react';
import { 
  Users, Ticket, Settings, CheckCircle2, AlertCircle, Info,
  Upload, Lock, Unlock, ArrowRight, Mail, Loader2, Trash2 
} from 'lucide-react';
import { 
  collection, onSnapshot, doc, getDoc, updateDoc, 
  addDoc, serverTimestamp, query, orderBy, setDoc, deleteDoc, getDocs 
} from 'firebase/firestore';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import { db, auth } from './firebase';
import axios from 'axios';
import { motion, AnimatePresence } from 'motion/react';

// --- TYPES ---
interface Member {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  ticketsBought: number;
  lastEmailSentAt?: any;
}

interface Reservation {
  id: string;
  date: any;
  buyerName: string;
  buyerEmail: string;
  dancerCode: string;
  adultCount: number;
  childCount: number;
  pmrCount: number;
  status: string;
  helloAssoId?: number;
}

interface AppSettings {
  phase: number;
  capacityStd: number;
  capacityPmr: number;
  guestsCount: number;
  maxPerDancerPhase1: number;
  priceAdult: number;
  priceChild: number;
  pricePmr: number;
}

// --- APP ---
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentView, setCurrentView] = useState<'booking' | 'admin'>('booking');
  const [loading, setLoading] = useState(true);
  
  // Data states
  const [settings, setSettings] = useState<AppSettings>({
    phase: 1,
    capacityStd: 431,
    capacityPmr: 6,
    guestsCount: 3,
    maxPerDancerPhase1: 4,
    priceAdult: 10,
    priceChild: 7,
    pricePmr: 10
  });
  const [members, setMembers] = useState<Member[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [sales, setSales] = useState({ adult: 0, child: 0, pmr: 0 });
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' as 'success' | 'error' | 'info' });

  // --- AUTH ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        // Check if admin (hardcoded for demo or via Firestore)
        setIsAdmin(u.email === "stephane.alamichel@gmail.com");
      } else {
        setIsAdmin(false);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const login = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login Error", error);
    }
  };

  // --- DATA SYNC ---
  useEffect(() => {
    if (!isAdmin) return;
    const initSettings = async () => {
      const sDoc = await getDoc(doc(db, 'settings', 'global'));
      if (!sDoc.exists()) {
        await setDoc(doc(db, 'settings', 'global'), {
          phase: 1,
          capacityStd: 431,
          capacityPmr: 6,
          guestsCount: 3,
          maxPerDancerPhase1: 4,
          priceAdult: 10,
          priceChild: 7,
          pricePmr: 10
        });
      }
    };
    initSettings();
  }, [isAdmin]);

  const [paymentConfirmed, setPaymentConfirmed] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkoutIntentId = params.get('checkoutIntentId') || params.get('id');
    const code = params.get('code');
    const orderId = params.get('orderId');
    const error = params.get('error');

    const checkPaymentStatus = async (id: string) => {
      if (!id || id === 'null') return;
      try {
        const response = await axios.get(`/api/helloasso/check-status/${id}`);
        const intent = response.data;
        const status = intent.orderStatus || (intent.order ? 'Success' : 'Wait');

        if (status === 'Success') {
          setPaymentConfirmed(true);
          showToast(`Paiement confirmé ! Votre réservation est validée.`, "success");
          
          // If the backend reported a firestore error, we can try to fix it here if we find the doc
          if (intent.firestoreUpdateError) {
            console.warn("Backend failed to update Firestore, attempting client-side update...");
            try {
              const resQuery = query(collection(db, 'reservations'));
              const querySnapshot = await getDocs(resQuery);
              const docToUpdate = querySnapshot.docs.find(d => 
                String(d.data().helloAssoId) === String(id) && d.data().status === 'pending'
              );
              
              if (docToUpdate) {
                await updateDoc(docToUpdate.ref, { status: 'completed' });
                console.log("Client-side update successful after backend failure");
                
                // Also update member tickets if applicable
                const resData = docToUpdate.data();
                if (resData.dancerCode && resData.dancerCode !== 'PHASE_2') {
                  const memberRef = doc(db, 'members', resData.dancerCode);
                  const memberDoc = await getDoc(memberRef);
                  if (memberDoc.exists()) {
                    const currentTickets = memberDoc.data()?.ticketsBought || 0;
                    await updateDoc(memberRef, { 
                      ticketsBought: currentTickets + (resData.adultCount || 0) + (resData.childCount || 0) + (resData.pmrCount || 0)
                    });
                  }
                }
              }
            } catch (updateErr) {
              console.error("Client-side update failed", updateErr);
            }
          }
        } else if (['Refused', 'Canceled'].includes(status)) {
          showToast("Le paiement a été refusé ou annulé.", "error");
        } else {
          showToast(`Statut du paiement : ${status}`, "info");
        }
      } catch (err) {
        console.error("Error checking status", err);
        showToast("Erreur lors de la vérification du paiement.", "error");
      }
    };

    if (window.location.pathname === '/payment-success') {
      if (checkoutIntentId) {
        checkPaymentStatus(checkoutIntentId);
      } else {
        setPaymentConfirmed(true);
        showToast("Paiement réussi ! Votre réservation est en cours de validation.", "success");
      }
      window.history.replaceState({}, '', '/');
    } else if (window.location.pathname === '/payment-error') {
      const errorMsg = error ? `Erreur : ${error}` : "Le paiement a échoué ou a été annulé.";
      showToast(errorMsg, "error");
      window.history.replaceState({}, '', '/');
    }
  }, []);

  const handleManualCheckStatus = async (res: Reservation) => {
    if (!res.helloAssoId) {
      showToast("ID HelloAsso manquant pour cette réservation", "error");
      return;
    }

    try {
      const response = await axios.get(`/api/helloasso/check-status/${res.helloAssoId}`);
      const intent = response.data;
      const status = intent.orderStatus || (intent.order ? 'Success' : 'Wait');

      if (status === 'Success') {
        if (res.status === 'pending') {
          await updateDoc(doc(db, 'reservations', res.id), { status: 'completed' });
          
          // Mettre à jour les tickets du membre si applicable
          if (res.dancerCode && res.dancerCode !== 'PHASE_2') {
            const memberRef = doc(db, 'members', res.dancerCode);
            const memberDoc = await getDoc(memberRef);
            if (memberDoc.exists()) {
              const currentTickets = memberDoc.data()?.ticketsBought || 0;
              await updateDoc(memberRef, { 
                ticketsBought: currentTickets + (res.adultCount || 0) + (res.childCount || 0) + (res.pmrCount || 0)
              });
            }
          }
        }
        showToast("Paiement validé ! La réservation a été mise à jour.", "success");
      } else if (['Refused', 'Canceled'].includes(status)) {
        if (res.status === 'pending') {
          await updateDoc(doc(db, 'reservations', res.id), { status: 'cancelled' });
        }
        showToast("Paiement refusé ou annulé. Réservation annulée.", "error");
      } else {
        showToast(`Statut HelloAsso : ${status}. Pas de changement.`, "info");
      }
    } catch (err) {
      console.error("Error manual check status", err);
      showToast("Erreur lors de la vérification du statut", "error");
    }
  };

  useEffect(() => {
    const unsubSettings = onSnapshot(doc(db, 'settings', 'global'), (doc) => {
      if (doc.exists()) setSettings(doc.data() as AppSettings);
    });

    const unsubMembers = onSnapshot(collection(db, 'members'), (snap) => {
      setMembers(snap.docs.map(d => d.data() as Member));
    });

    const unsubRes = onSnapshot(query(collection(db, 'reservations'), orderBy('createdAt', 'desc')), (snap) => {
      const resData = snap.docs.map(d => ({ id: d.id, ...d.data() } as Reservation));
      setReservations(resData);
      
      // Calculate sales
      const totalAdult = resData.reduce((acc, r) => acc + (r.status === 'completed' ? (r.adultCount || 0) : 0), 0);
      const totalChild = resData.reduce((acc, r) => acc + (r.status === 'completed' ? (r.childCount || 0) : 0), 0);
      const totalPmr = resData.reduce((acc, r) => acc + (r.status === 'completed' ? (r.pmrCount || 0) : 0), 0);
      setSales({ adult: totalAdult, child: totalChild, pmr: totalPmr });
    });

    return () => {
      unsubSettings();
      unsubMembers();
      unsubRes();
    };
  }, []);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: '', type: 'success' }), 5000);
  };

  const availableStd = settings.capacityStd - settings.guestsCount - sales.adult - sales.child;
  const availablePmr = settings.capacityPmr - sales.pmr;

  // --- ACTIONS ---
  const updatePhase = async (p: number) => {
    if (!isAdmin) return;
    await updateDoc(doc(db, 'settings', 'global'), { phase: p });
    showToast(`Phase ${p} activée`);
  };

  const handleImport = async (text: string) => {
    if (!isAdmin) return;
    const generateCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();
    const lines = text.split('\n');
    let count = 0;
    for (const line of lines) {
      const parts = line.split(/[,\t]/);
      if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
        const firstName = parts[0].trim();
        const lastName = parts[1].trim();
        const email = parts[2]?.trim() || "";
        const id = generateCode();
        await setDoc(doc(db, 'members', id), { 
          id, 
          firstName,
          lastName,
          email, 
          ticketsBought: 0,
          lastEmailSentAt: null 
        });
        count++;
      }
    }
    showToast(`${count} membres importés`);
  };

  const sendMemberEmail = async (member: Member) => {
    if (!member.email) return showToast(`Pas d'email pour ${member.firstName} ${member.lastName}`, "error");
    
    // Create pre-filled link
    const prefilledUrl = new URL(window.location.origin);
    prefilledUrl.searchParams.set('code', member.id);
    prefilledUrl.searchParams.set('name', `${member.firstName} ${member.lastName}`);
    if (member.email) prefilledUrl.searchParams.set('email', member.email);

    try {
      await axios.post('/api/email/send', {
        to: member.email,
        subject: "Votre code d'accès Gala",
        htmlContent: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px;">
            <h1 style="color: #111827; font-size: 24px; font-weight: 800; margin-bottom: 16px;">Bonjour ${member.firstName},</h1>
            <p style="color: #4b5563; font-size: 16px; line-height: 24px;">Voici votre code d'accès personnel pour la billetterie du Gala :</p>
            <div style="font-size: 32px; font-weight: 900; color: #4f46e5; padding: 30px; background: #f3f4f6; border-radius: 12px; text-align: center; margin: 24px 0; letter-spacing: 4px;">
              ${member.id}
            </div>
            <p style="color: #4b5563; font-size: 14px; line-height: 20px;">Ce code vous permet de réserver jusqu'à <strong>${settings.maxPerDancerPhase1} places</strong> lors de la Phase 1 (Priorité Adhérents).</p>
            <div style="margin-top: 32px; text-align: center;">
              <a href="${prefilledUrl.toString()}" style="background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px; display: inline-block;">Accéder à la billetterie (Pré-rempli)</a>
            </div>
            <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 24px;">Si le bouton ne fonctionne pas, copiez ce lien : <br/> ${prefilledUrl.toString()}</p>
            <hr style="margin: 32px 0; border: 0; border-top: 1px solid #e5e7eb;" />
            <p style="color: #9ca3af; font-size: 12px; text-align: center;">Cet email a été envoyé automatiquement, merci de ne pas y répondre.</p>
          </div>
        `
      });
      await updateDoc(doc(db, 'members', member.id), {
        lastEmailSentAt: serverTimestamp()
      });
      showToast(`Email envoyé à ${member.firstName} ${member.lastName}`);
    } catch (err) {
      showToast(`Erreur d'envoi à ${member.firstName} ${member.lastName}`, "error");
    }
  };

  const sendAllEmails = async () => {
    if (!confirm("Envoyer l'email à TOUS les adhérents ?")) return;
    let count = 0;
    for (const m of members) {
      if (m.email) {
        await sendMemberEmail(m);
        count++;
      }
    }
    showToast(`${count} emails envoyés`);
  };

  // --- VUE : RÉSERVATION ---
  const BookingView = () => {
    const [dancerCode, setDancerCode] = useState('');
    const [reqAdult, setReqAdult] = useState(0);
    const [reqChild, setReqChild] = useState(0);
    const [reqPmr, setReqPmr] = useState(0);
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [buyerEmail, setBuyerEmail] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);

    // Pre-fill from URL
    useEffect(() => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const name = params.get('name');
      const email = params.get('email');

      if (code) setDancerCode(code);
      if (email) setBuyerEmail(email);
      if (name) {
        const parts = name.trim().split(' ');
        if (parts.length >= 2) {
          setFirstName(parts[0]);
          setLastName(parts.slice(1).join(' '));
        } else {
          setFirstName(name);
        }
      }
    }, []);

    const handleBooking = async (e: React.FormEvent) => {
      e.preventDefault();
      const totalRequested = reqAdult + reqChild + reqPmr;

      if (totalRequested === 0) return showToast("Sélectionnez au moins une place", "error");
      if ((reqAdult + reqChild) > availableStd || reqPmr > availablePmr) return showToast("Places insuffisantes", "error");

      if (!firstName.trim() || !lastName.trim()) {
        return showToast("Veuillez saisir votre Prénom et votre Nom", "error");
      }

      setIsProcessing(true);

      try {
        if (settings.phase === 1) {
          if (!dancerCode.trim()) throw new Error("Code danseur requis en Phase 1");
          const memberDoc = await getDoc(doc(db, 'members', dancerCode.trim()));
          if (!memberDoc.exists()) throw new Error("Code danseur invalide");
          
          const member = memberDoc.data() as Member;
          if (member.ticketsBought + totalRequested > settings.maxPerDancerPhase1) {
            throw new Error(`Quota dépassé (${member.ticketsBought}/${settings.maxPerDancerPhase1})`);
          }
        }

        // 1. Create Checkout Intent via Backend (HelloAsso)
        const totalAmount = (reqAdult * settings.priceAdult) + (reqChild * settings.priceChild) + (reqPmr * settings.pricePmr);
        const checkoutRes = await axios.post('/api/helloasso/checkout', {
          amount: totalAmount,
          label: `Gala - ${totalRequested} places`,
          buyer: { 
            firstName: firstName.trim(), 
            lastName: lastName.trim(), 
            email: buyerEmail 
          },
          metadata: { dancerCode, adult: reqAdult, child: reqChild, pmr: reqPmr }
        });

        // 2. Save pending reservation
        await addDoc(collection(db, 'reservations'), {
          buyerName: `${firstName.trim()} ${lastName.trim()}`,
          buyerEmail,
          dancerCode: settings.phase === 1 ? dancerCode : "PHASE_2",
          adultCount: reqAdult,
          childCount: reqChild,
          pmrCount: reqPmr,
          status: 'pending',
          createdAt: serverTimestamp(),
          helloAssoId: checkoutRes.data.id
        });

        // 3. Redirect to HelloAsso in a new tab to avoid iframe permission issues
        const paymentWindow = window.open(checkoutRes.data.redirectUrl, '_blank');
        
        if (!paymentWindow) {
          showToast("Le bloqueur de fenêtres a empêché l'ouverture du paiement. Veuillez autoriser les popups.", "error");
        }

      } catch (err: any) {
        let errorMessage = "Erreur lors de la réservation";
        
        if (err.response?.data?.details?.errors) {
          errorMessage = err.response.data.details.errors.map((e: any) => e.message).join(', ');
        } else if (err.response?.data?.error) {
          errorMessage = err.response.data.error;
        } else if (err.message) {
          errorMessage = err.message;
        }
        
        showToast(errorMessage, "error");
      } finally {
        setIsProcessing(false);
      }
    };

    return (
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-2xl mx-auto bg-white rounded-2xl shadow-xl p-8 border border-slate-100"
      >
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold text-slate-900 mb-2">Réservation Gala</h2>
          <div className={`inline-flex items-center px-4 py-2 rounded-full text-sm font-medium ${settings.phase === 1 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
            {settings.phase === 1 ? <Lock className="w-4 h-4 mr-2" /> : <Unlock className="w-4 h-4 mr-2" />}
            {settings.phase === 1 ? "Phase 1 : Priorité Adhérents" : "Phase 2 : Vente Libre"}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-slate-50 p-4 rounded-xl text-center border border-slate-200">
            <span className="block text-[10px] text-slate-500 uppercase font-bold tracking-wider">Adulte (13+)</span>
            <span className="block text-xl font-bold text-slate-900">{settings.priceAdult}€</span>
          </div>
          <div className="bg-slate-50 p-4 rounded-xl text-center border border-slate-200">
            <span className="block text-[10px] text-slate-500 uppercase font-bold tracking-wider">Enfant (-12)</span>
            <span className="block text-xl font-bold text-slate-900">{settings.priceChild}€</span>
          </div>
          <div className="bg-slate-50 p-4 rounded-xl text-center border border-slate-200">
            <span className="block text-[10px] text-slate-500 uppercase font-bold tracking-wider">PMR</span>
            <span className="block text-xl font-bold text-slate-900">{settings.pricePmr}€</span>
          </div>
        </div>

        <div className="bg-indigo-50 p-4 rounded-xl mb-8 border border-indigo-100 text-center">
          <span className="text-sm font-medium text-indigo-900">Places Standard restantes : <span className="font-bold">{availableStd}</span></span>
        </div>

        <form onSubmit={handleBooking} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Prénom</label>
              <input type="text" value={firstName} onChange={e => setFirstName(e.target.value)} required className="w-full px-4 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Nom</label>
              <input type="text" value={lastName} onChange={e => setLastName(e.target.value)} required className="w-full px-4 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input type="email" value={buyerEmail} onChange={e => setBuyerEmail(e.target.value)} required className="w-full px-4 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          </div>

          {settings.phase === 1 && (
            <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100">
              <label className="block text-sm font-medium text-indigo-900 mb-1">Code Danseur *</label>
              <input type="text" value={dancerCode} onChange={e => setDancerCode(e.target.value)} required className="w-full px-4 py-2 border border-indigo-200 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs text-indigo-600 mt-2">Max {settings.maxPerDancerPhase1} places par danseur.</p>
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">Adulte (13+)</label>
              <select value={reqAdult} onChange={e => setReqAdult(Number(e.target.value))} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
                {[...Array(settings.maxPerDancerPhase1 + 1).keys()].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">Enfant (-12)</label>
              <select value={reqChild} onChange={e => setReqChild(Number(e.target.value))} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
                {[...Array(settings.maxPerDancerPhase1 + 1).keys()].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">PMR</label>
              <select value={reqPmr} onChange={e => setReqPmr(Number(e.target.value))} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm">
                {[...Array(settings.maxPerDancerPhase1 + 1).keys()].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>

          <button 
            type="submit" 
            disabled={isProcessing}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold py-4 px-4 rounded-xl transition-all flex items-center justify-center shadow-lg shadow-indigo-200"
          >
            {isProcessing ? <Loader2 className="w-6 h-6 animate-spin" /> : <>Payer sur HelloAsso <ArrowRight className="w-5 h-5 ml-2" /></>}
          </button>
        </form>
      </motion.div>
    );
  };

  // --- VUE : ADMIN ---
  const AdminView = () => {
    const [importText, setImportText] = useState('');
    const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
    const [editSettings, setEditSettings] = useState<AppSettings>(settings);

    useEffect(() => {
      setEditSettings(settings);
    }, [settings]);

    if (!isAdmin) return <div className="p-8 text-center">Accès refusé</div>;

    const handleSaveSettings = async () => {
      try {
        await updateDoc(doc(db, 'settings', 'global'), { ...editSettings });
        showToast("Paramètres enregistrés avec succès");
      } catch (err) {
        showToast("Erreur lors de l'enregistrement", "error");
      }
    };

    const toggleMemberSelection = (id: string) => {
      setSelectedMembers(prev => 
        prev.includes(id) ? prev.filter(mid => mid !== id) : [...prev, id]
      );
    };

    const toggleAllMembers = () => {
      if (selectedMembers.length === members.length) {
        setSelectedMembers([]);
      } else {
        setSelectedMembers(members.map(m => m.id));
      }
    };

    const handleDeleteMembers = async () => {
      if (selectedMembers.length === 0) return;
      if (!confirm(`Supprimer ${selectedMembers.length} adhérent(s) ?`)) return;

      try {
        for (const id of selectedMembers) {
          await deleteDoc(doc(db, 'members', id));
        }
        setSelectedMembers([]);
        showToast(`${selectedMembers.length} adhérent(s) supprimé(s)`);
      } catch (err) {
        showToast("Erreur lors de la suppression", "error");
      }
    };

    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="bg-white rounded-2xl shadow-sm p-6 flex flex-col md:flex-row items-center justify-between border border-slate-100">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">Administration</h2>
            <p className="text-slate-500">Gestion des ventes et adhérents</p>
          </div>
          <div className="mt-4 md:mt-0 flex bg-slate-100 p-1 rounded-xl">
            <button onClick={() => updatePhase(1)} className={`px-6 py-2 rounded-lg text-sm font-bold transition-all ${settings.phase === 1 ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>Phase 1</button>
            <button onClick={() => updatePhase(2)} className={`px-6 py-2 rounded-lg text-sm font-bold transition-all ${settings.phase === 2 ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>Phase 2</button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <Ticket className="text-indigo-500" />
              <span className="text-2xl font-bold">{sales.adult + sales.child} / {settings.capacityStd}</span>
            </div>
            <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
              <div className="bg-indigo-500 h-full" style={{ width: `${((sales.adult + sales.child) / settings.capacityStd) * 100}%` }} />
            </div>
            <p className="text-xs text-slate-400 mt-2">Ventes Standard (Adultes: {sales.adult}, Enfants: {sales.child})</p>
          </div>
          {/* Similar cards for PMR and Total Revenue */}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-6">
            <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
              <h3 className="font-bold mb-4 flex items-center"><Settings className="mr-2 w-5 h-5" /> Configuration</h3>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Prix Adulte (€)</label>
                  <input 
                    type="number" 
                    value={editSettings.priceAdult} 
                    onChange={e => setEditSettings({...editSettings, priceAdult: Number(e.target.value)})}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Prix Enfant (€)</label>
                  <input 
                    type="number" 
                    value={editSettings.priceChild} 
                    onChange={e => setEditSettings({...editSettings, priceChild: Number(e.target.value)})}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Prix PMR (€)</label>
                  <input 
                    type="number" 
                    value={editSettings.pricePmr} 
                    onChange={e => setEditSettings({...editSettings, pricePmr: Number(e.target.value)})}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Max / Danseur (Ph1)</label>
                  <input 
                    type="number" 
                    value={editSettings.maxPerDancerPhase1} 
                    onChange={e => setEditSettings({...editSettings, maxPerDancerPhase1: Number(e.target.value)})}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Capacité Standard</label>
                  <input 
                    type="number" 
                    value={editSettings.capacityStd} 
                    onChange={e => setEditSettings({...editSettings, capacityStd: Number(e.target.value)})}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Capacité PMR</label>
                  <input 
                    type="number" 
                    value={editSettings.capacityPmr} 
                    onChange={e => setEditSettings({...editSettings, capacityPmr: Number(e.target.value)})}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                  />
                </div>
              </div>
              <button 
                onClick={handleSaveSettings}
                className="w-full bg-indigo-600 text-white py-2 rounded-lg font-bold hover:bg-indigo-700 transition-colors"
              >
                Enregistrer les paramètres
              </button>
            </div>

            <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
              <h3 className="font-bold mb-4 flex items-center"><Users className="mr-2 w-5 h-5" /> Import Adhérents</h3>
              <textarea 
                value={importText} onChange={e => setImportText(e.target.value)}
                className="w-full h-32 p-3 border border-slate-200 rounded-xl text-sm mb-4 outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Prénom, Nom, Email"
              />
              <button onClick={() => handleImport(importText)} className="w-full bg-slate-900 text-white py-2 rounded-lg font-bold flex items-center justify-center">
                <Upload className="w-4 h-4 mr-2" /> Importer et Générer Codes
              </button>
            </div>

            <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold flex items-center"><Users className="mr-2 w-5 h-5" /> Liste des Adhérents</h3>
                <div className="flex items-center space-x-2">
                  {selectedMembers.length > 0 && (
                    <button 
                      onClick={handleDeleteMembers}
                      className="text-xs bg-rose-100 text-rose-600 px-3 py-1.5 rounded-lg font-bold flex items-center hover:bg-rose-200 transition-colors"
                    >
                      <Trash2 className="w-3 h-3 mr-1.5" /> Supprimer ({selectedMembers.length})
                    </button>
                  )}
                  <button 
                    onClick={sendAllEmails}
                    className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg font-bold flex items-center hover:bg-indigo-700 transition-colors"
                  >
                    <Mail className="w-3 h-3 mr-1.5" /> Envoyer à tous
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="pb-2 w-8">
                        <input 
                          type="checkbox" 
                          checked={members.length > 0 && selectedMembers.length === members.length}
                          onChange={toggleAllMembers}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                      </th>
                      <th className="pb-2 font-bold">Code</th>
                      <th className="pb-2 font-bold">Nom</th>
                      <th className="pb-2 font-bold text-center">Usage</th>
                      <th className="pb-2 font-bold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map(m => (
                      <tr key={m.id} className={`border-b border-slate-50 transition-colors ${selectedMembers.includes(m.id) ? 'bg-indigo-50/30' : ''}`}>
                        <td className="py-2">
                          <input 
                            type="checkbox" 
                            checked={selectedMembers.includes(m.id)}
                            onChange={() => toggleMemberSelection(m.id)}
                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                        </td>
                        <td className="py-2 font-mono text-indigo-600 font-bold">{m.id}</td>
                        <td className="py-2">
                          <div className="font-medium">{m.firstName} {m.lastName}</div>
                          <div className="text-[10px] text-slate-400">{m.email}</div>
                        </td>
                        <td className="py-2 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${settings.maxPerDancerPhase1 - m.ticketsBought > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                            {settings.maxPerDancerPhase1 - m.ticketsBought} / {settings.maxPerDancerPhase1}
                          </span>
                        </td>
                        <td className="py-2 text-right">
                          <div className="flex flex-col items-end space-y-1">
                            <button 
                              onClick={() => sendMemberEmail(m)}
                              className="p-1.5 text-slate-400 hover:text-indigo-600 transition-colors"
                              title="Envoyer le code"
                            >
                              <Mail className="w-4 h-4" />
                            </button>
                            {m.lastEmailSentAt && (
                              <span className="text-[8px] text-slate-400">
                                Envoyé le {new Date(m.lastEmailSentAt.seconds * 1000).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
            <h3 className="font-bold mb-4">Dernières Réservations</h3>
            <div className="space-y-3 max-h-96 overflow-y-auto pr-2">
              {reservations.map(res => (
                <div key={res.id} className="p-3 bg-slate-50 rounded-xl border border-slate-100 flex justify-between items-center">
                  <div>
                    <p className="font-bold text-sm">{res.buyerName}</p>
                    <p className="text-[10px] text-slate-400">ID: {res.helloAssoId} • {res.adultCount} Ad • {res.childCount} Enf • {res.pmrCount} PMR</p>
                  </div>
                  <span 
                    onClick={() => res.status === 'pending' && handleManualCheckStatus(res)}
                    className={`text-[10px] font-bold px-2 py-1 rounded-full uppercase cursor-pointer transition-all ${
                      res.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 
                      res.status === 'cancelled' ? 'bg-rose-100 text-rose-700' :
                      'bg-amber-100 text-amber-700 hover:bg-amber-200'
                    }`}
                    title={res.status === 'pending' ? "Cliquer pour vérifier le statut" : ""}
                  >
                    {res.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const PaymentSuccessView = () => (
    <div className="max-w-md mx-auto bg-white rounded-3xl p-10 text-center border border-slate-100 shadow-xl">
      <div className="bg-emerald-100 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6">
        <CheckCircle2 className="w-10 h-10 text-emerald-600" />
      </div>
      <h2 className="text-3xl font-black mb-4">Paiement Validé !</h2>
      <p className="text-slate-500 mb-8">
        Votre réservation a été confirmée avec succès. Vous allez recevoir un email récapitulatif d'ici quelques instants.
      </p>
      <button 
        onClick={() => setPaymentConfirmed(false)}
        className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-lg hover:bg-slate-800 transition-all"
      >
        Retour à l'accueil
      </button>
    </div>
  );

  if (loading) return <div className="h-screen flex items-center justify-center"><Loader2 className="w-10 h-10 animate-spin text-indigo-600" /></div>;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
        <AnimatePresence>
          {toast.show && (
            <motion.div 
              initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
              className={`fixed top-6 right-6 z-50 p-4 rounded-xl shadow-2xl text-white flex items-center ${
                toast.type === 'error' ? 'bg-rose-600' : 
                toast.type === 'info' ? 'bg-sky-600' : 
                'bg-emerald-600'
              }`}
            >
              {toast.type === 'error' ? <AlertCircle className="mr-3" /> : 
               toast.type === 'info' ? <Info className="mr-3" /> : 
               <CheckCircle2 className="mr-3" />}
              <span className="font-bold">{toast.message}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <nav className="bg-white border-b border-slate-200 px-6 py-4 sticky top-0 z-40">
          <div className="max-w-7xl mx-auto flex justify-between items-center">
            <div className="flex items-center space-x-2">
              <div className="bg-indigo-600 p-1.5 rounded-lg"><Ticket className="text-white w-5 h-5" /></div>
              <span className="text-xl font-black tracking-tighter text-slate-900">GALA<span className="text-indigo-600">PRO</span></span>
            </div>
            <div className="flex items-center space-x-4">
              <button onClick={() => setCurrentView('booking')} className={`text-sm font-bold ${currentView === 'booking' ? 'text-indigo-600' : 'text-slate-500'}`}>Billetterie</button>
              {isAdmin && <button onClick={() => setCurrentView('admin')} className={`text-sm font-bold ${currentView === 'admin' ? 'text-indigo-600' : 'text-slate-500'}`}>Admin</button>}
              {!user ? (
                <button onClick={login} className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-bold">Connexion</button>
              ) : (
                <img src={user.photoURL || ''} alt="User" className="w-8 h-8 rounded-full border border-slate-200" />
              )}
            </div>
          </div>
        </nav>

        <main className="max-w-7xl mx-auto px-4 py-12">
          {paymentConfirmed ? <PaymentSuccessView /> : (currentView === 'booking' ? <BookingView /> : <AdminView />)}
        </main>
      </div>
  );
}

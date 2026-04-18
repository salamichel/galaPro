import React, { useState, useEffect, useCallback, Component, ReactNode } from 'react';
import { 
  Users, Ticket, Settings, CheckCircle2, AlertCircle, Info,
  Upload, Lock, Unlock, ArrowRight, Mail, Loader2, Trash2,
  Search, RefreshCw, XCircle, CheckCircle, ExternalLink, Pencil,
  Download, Printer, ChevronLeft, FileText, ShieldCheck
} from 'lucide-react';
import { 
  collection, onSnapshot, doc, getDoc, updateDoc, 
  addDoc, serverTimestamp, query, orderBy, setDoc, deleteDoc, getDocs 
} from 'firebase/firestore';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import { logEvent } from 'firebase/analytics';
import { db, auth, analytics } from './firebase';
import axios from 'axios';
import { motion, AnimatePresence } from 'motion/react';

// --- TYPES ---
interface Member {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  ticketsBought: number;
  maxTicketsOverride?: number;
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
  ticketHolders?: { firstName: string; lastName: string; type: 'adult' | 'child' | 'pmr' }[];
  status: string;
  helloAssoId?: number;
  createdAt?: any;
}

interface AppSettings {
  phase: number;
  capacityStd: number;
  capacityPmr: number;
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
    maxPerDancerPhase1: 4,
    priceAdult: 10,
    priceChild: 7,
    pricePmr: 10
  });
  const [members, setMembers] = useState<Member[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [sales, setSales] = useState({ adult: 0, child: 0, pmr: 0 });
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' as 'success' | 'error' | 'info' });
  const [ticketViewId, setTicketViewId] = useState<string | null>(null);
  const [ticketViewReservation, setTicketViewReservation] = useState<Reservation | null>(null);

  // --- ANALYTICS HELPER ---
  const logAppEvent = useCallback(async (eventName: string, params?: any) => {
    const a = await analytics;
    if (a) {
      logEvent(a, eventName, params);
    }
  }, []);

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
  const [lastConfirmedResId, setLastConfirmedResId] = useState<string | null>(null);
  const [adminCheckId, setAdminCheckId] = useState<string | null>(null);
  const [adminCheckReservation, setAdminCheckReservation] = useState<Reservation | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkoutIntentId = params.get('checkoutIntentId') || params.get('id');
    const code = params.get('code');
    const orderId = params.get('orderId');
    const error = params.get('error');
    const paymentAction = params.get('payment');

    const checkPaymentStatus = async (id: string) => {
      if (!id || id === 'null') return;
      try {
        const response = await axios.get(`/api/helloasso/check-status/${id}`);
        const intent = response.data;
        const status = intent.orderStatus || (intent.order ? 'Success' : 'Wait');

        if (status === 'Success') {
          setPaymentConfirmed(true);
          logAppEvent('purchase', { 
            transaction_id: id,
            reservation_id: intent.reservationId 
          });
          
          if (intent.reservationId) {
            setLastConfirmedResId(intent.reservationId);
          }

          showToast(`Paiement confirmé ! Votre réservation est validée.`, "success");
          
          // If the backend reported a firestore error, we can try to fix it here if we have the ID
          if (intent.firestoreUpdateError && intent.reservationId) {
            console.warn("Backend failed to update Firestore, attempting client-side update...");
            try {
              const resDoc = await getDoc(doc(db, 'reservations', intent.reservationId));
              if (resDoc.exists() && resDoc.data().status === 'pending') {
                await updateDoc(resDoc.ref, { status: 'completed' });
                console.log("Client-side update successful after backend failure");
                
                // Also update member tickets if applicable
                const resData = resDoc.data();
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
      }
      window.history.replaceState({}, '', '/');
    } else if (window.location.pathname === '/payment-error' || paymentAction === 'error') {
      const errorMsg = error ? `Erreur : ${error}` : "Le paiement a échoué.";
      showToast(errorMsg, "error");
      window.history.replaceState({}, '', '/');
    } else if (paymentAction === 'cancel') {
      showToast("Le paiement a été annulé.", "info");
      window.history.replaceState({}, '', '/');
    }

    // Check for ticket view
    const view = params.get('view');
    const resId = params.get('resId');
    if (view === 'tickets' && resId) {
      setTicketViewId(resId);
      setCurrentView('booking'); // Ensure we are not in admin view
    } else if (view === 'admin-check' && resId) {
      setAdminCheckId(resId);
      setCurrentView('admin');
    }
  }, []);

  useEffect(() => {
    if (adminCheckId) {
      const fetchRes = async () => {
        try {
          const resDoc = await getDoc(doc(db, 'reservations', adminCheckId));
          if (resDoc.exists()) {
            setAdminCheckReservation({ id: resDoc.id, ...resDoc.data() } as Reservation);
          } else {
            showToast("Réservation introuvable", "error");
            setAdminCheckId(null);
          }
        } catch (err) {
          console.error("Error fetching reservation for admin check", err);
          showToast("Erreur lors de la récupération de la commande", "error");
          setAdminCheckId(null);
        }
      };
      fetchRes();
    } else {
      setAdminCheckReservation(null);
    }
  }, [adminCheckId]);

  useEffect(() => {
    if (ticketViewId) {
      const fetchRes = async () => {
        try {
          const resDoc = await getDoc(doc(db, 'reservations', ticketViewId));
          if (resDoc.exists()) {
            setTicketViewReservation({ id: resDoc.id, ...resDoc.data() } as Reservation);
          } else {
            showToast("Réservation introuvable", "error");
            setTicketViewId(null);
          }
        } catch (err) {
          console.error("Error fetching reservation for tickets", err);
          showToast("Erreur lors de la récupération des billets", "error");
          setTicketViewId(null);
        }
      };
      fetchRes();
    } else {
      setTicketViewReservation(null);
    }
  }, [ticketViewId]);

  const handleUpdateStatus = async (id: string, newStatus: string) => {
    if (!confirm(`Changer le statut en "${newStatus}" ?`)) return;
    try {
      await updateDoc(doc(db, 'reservations', id), { status: newStatus });
      showToast(`Statut mis à jour : ${newStatus}`);
    } catch (err) {
      console.error("Update Status Error:", err);
      showToast("Erreur lors de la mise à jour", "error");
    }
  };

  const handleDeleteReservation = async (id: string) => {
    if (!confirm("Supprimer cette réservation ?")) return;
    try {
      await deleteDoc(doc(db, 'reservations', id));
      showToast("Réservation supprimée");
    } catch (err) {
      showToast("Erreur lors de la suppression", "error");
    }
  };
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

    let unsubMembers = () => {};
    let unsubRes = () => {};

    if (isAdmin) {
      unsubMembers = onSnapshot(collection(db, 'members'), (snap) => {
        setMembers(snap.docs.map(d => ({ ...d.data(), id: d.id } as Member)));
      });

      unsubRes = onSnapshot(query(collection(db, 'reservations'), orderBy('createdAt', 'desc')), (snap) => {
        const resData = snap.docs.map(d => ({ id: d.id, ...d.data() } as Reservation));
        setReservations(resData);
        
        // Calculate sales
        const totalAdult = resData.reduce((acc, r) => acc + (r.status === 'completed' ? (r.adultCount || 0) : 0), 0);
        const totalChild = resData.reduce((acc, r) => acc + (r.status === 'completed' ? (r.childCount || 0) : 0), 0);
        const totalPmr = resData.reduce((acc, r) => acc + (r.status === 'completed' ? (r.pmrCount || 0) : 0), 0);
        setSales({ adult: totalAdult, child: totalChild, pmr: totalPmr });
      });
    }

    return () => {
      unsubSettings();
      unsubMembers();
      unsubRes();
    };
  }, [isAdmin]);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: '', type: 'success' }), 5000);
  };

  const availableStd = settings.capacityStd - sales.adult - sales.child;
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

  const handleDeleteMember = async (id: string) => {
    if (!confirm("Supprimer cet adhérent ?")) return;
    try {
      await deleteDoc(doc(db, 'members', id));
      showToast("Adhérent supprimé");
    } catch (err) {
      showToast("Erreur lors de la suppression", "error");
    }
  };

  const handleUpdateMember = async (id: string, data: Partial<Member>) => {
    try {
      await updateDoc(doc(db, 'members', id), data);
      showToast("Adhérent mis à jour");
    } catch (err) {
      console.error("Update Member Error:", err);
      showToast("Erreur lors de la mise à jour", "error");
    }
  };

  // --- VUE : BILLETS ---
  const TicketView = ({ reservation }: { reservation: Reservation }) => {
    const handlePrint = () => {
      window.print();
    };

    if (reservation.status !== 'completed') {
      return (
        <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-xl p-8 text-center">
          <AlertCircle className="w-16 h-16 text-amber-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2">Paiement en attente</h2>
          <p className="text-slate-600 mb-6">Vos billets seront disponibles dès que le paiement sera validé par HelloAsso.</p>
          <button onClick={() => setTicketViewId(null)} className="text-indigo-600 font-bold flex items-center justify-center mx-auto">
            <ChevronLeft className="w-4 h-4 mr-1" /> Retour
          </button>
        </div>
      );
    }

    return (
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="max-w-4xl mx-auto space-y-8 pb-12"
      >
        <div className="flex items-center justify-between no-print">
          <button onClick={() => setTicketViewId(null)} className="flex items-center text-slate-600 hover:text-indigo-600 font-medium transition-colors">
            <ChevronLeft className="w-5 h-5 mr-1" /> Retour à la billetterie
          </button>
          <div className="flex gap-3">
            <button 
              onClick={handlePrint}
              className="flex items-center px-4 py-2 bg-white border border-slate-200 rounded-lg text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
            >
              <Printer className="w-4 h-4 mr-2" /> Imprimer
            </button>
          </div>
        </div>

        <div className="text-center no-print">
          <h2 className="text-3xl font-bold text-slate-900">Votre Preuve d'Achat</h2>
          <p className="text-slate-500 mt-2">Présentez ce document à l'entrée du Gala</p>
        </div>

        <div className="bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-100 print:shadow-none print:border-slate-300">
          <div className="bg-indigo-600 p-8 text-white text-center">
            <h3 className="text-2xl font-bold uppercase tracking-tight">Et vie danse</h3>
            <p className="text-indigo-100 mt-1">Gala 2026 - Référence : {reservation.id.substring(0, 8).toUpperCase()}</p>
          </div>
          
          <div className="p-8 space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pb-8 border-b border-slate-100">
              <div>
                <p className="text-xs text-slate-400 uppercase font-bold tracking-wider mb-1">Acheteur</p>
                <p className="text-lg font-bold text-slate-900">{reservation.buyerName}</p>
                <p className="text-slate-500 text-sm">{reservation.buyerEmail}</p>
              </div>
              <div className="md:text-right">
                <p className="text-xs text-slate-400 uppercase font-bold tracking-wider mb-1">Date de l'événement</p>
                <p className="text-lg font-bold text-slate-900">02 Avril 2026</p>
                <p className="text-slate-500 text-sm">Ouverture des portes : 20h15</p>
              </div>
            </div>

            <div>
              <h4 className="text-sm font-bold text-slate-900 uppercase tracking-widest mb-4">Liste des Participants</h4>
              <div className="overflow-hidden border border-slate-200 rounded-xl">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50">
                      <th className="px-6 py-3 text-xs font-bold text-slate-500 uppercase">Nom du Participant</th>
                      <th className="px-6 py-3 text-xs font-bold text-slate-500 uppercase">Type de Billet</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {reservation.ticketHolders?.map((holder, idx) => (
                      <tr key={idx}>
                        <td className="px-6 py-4 text-sm font-medium text-slate-900">{holder.firstName} {holder.lastName}</td>
                        <td className="px-6 py-4 text-sm text-slate-500">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            holder.type === 'adult' ? 'bg-blue-100 text-blue-800' : 
                            holder.type === 'child' ? 'bg-green-100 text-green-800' : 
                            'bg-purple-100 text-purple-800'
                          }`}>
                            {holder.type === 'adult' ? 'ADULTE' : holder.type === 'child' ? 'ENFANT' : 'PMR'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 flex flex-col md:flex-row justify-between items-center gap-4">
              <div className="text-center md:text-left">
                <p className="text-xs text-slate-400 uppercase font-bold">Récapitulatif de la commande</p>
                <p className="text-sm text-slate-600 mt-1">
                  {reservation.adultCount > 0 && `${reservation.adultCount} Adulte(s) `}
                  {reservation.childCount > 0 && `${reservation.childCount} Enfant(s) `}
                  {reservation.pmrCount > 0 && `${reservation.pmrCount} PMR `}
                </p>
              </div>
              <div className="text-center md:text-right">
                <p className="text-xs text-slate-400 uppercase font-bold">Total Payé</p>
                <p className="text-2xl font-black text-indigo-600">
                  {((reservation.adultCount || 0) * settings.priceAdult + 
                    (reservation.childCount || 0) * settings.priceChild + 
                    (reservation.pmrCount || 0) * settings.pricePmr).toFixed(2)}€
                </p>
              </div>
            </div>

            <div className="text-center pt-4">
              <p className="text-[10px] text-slate-400 uppercase font-bold tracking-widest">Document officiel - Association Et vie danse</p>
            </div>
          </div>
        </div>

        <style>{`
          @media print {
            .no-print { display: none !important; }
            body { background: white !important; }
            .print\\:shadow-none { shadow: none !important; }
            .print\\:border-slate-300 { border-color: #cbd5e1 !important; }
          }
        `}</style>
      </motion.div>
    );
  };

  const AdminCheckView = ({ reservation }: { reservation: Reservation }) => {
    if (!isAdmin) {
      return (
        <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-xl p-8 text-center">
          <Lock className="w-16 h-16 text-rose-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2">Accès Restreint</h2>
          <p className="text-slate-600 mb-6">Vous devez être administrateur pour accéder à cette page.</p>
          <button onClick={() => setAdminCheckId(null)} className="text-indigo-600 font-bold">Retour</button>
        </div>
      );
    }

    return (
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-4xl mx-auto space-y-6"
      >
        <div className="flex items-center justify-between">
          <button onClick={() => { setAdminCheckId(null); if (currentView === 'admin') setCurrentView('admin'); }} className="flex items-center text-slate-600 hover:text-indigo-600 font-medium">
            <ChevronLeft className="w-5 h-5 mr-1" /> Retour
          </button>
          <div className="flex gap-2">
            <span className={`px-4 py-1 rounded-full text-xs font-bold ${
              reservation.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 
              reservation.status === 'cancelled' ? 'bg-rose-100 text-rose-700' : 
              'bg-amber-100 text-amber-700'
            }`}>
              {reservation.status.toUpperCase()}
            </span>
          </div>
        </div>

        <div className="bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-100">
          <div className="bg-slate-900 p-8 text-white">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mb-1">Détails de la Commande</p>
                <h2 className="text-3xl font-bold">{reservation.buyerName}</h2>
                <p className="text-slate-400 mt-1">{reservation.buyerEmail}</p>
              </div>
              <div className="text-right">
                <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mb-1">ID Réservation</p>
                <p className="text-xl font-mono font-bold text-indigo-400">{reservation.id.toUpperCase()}</p>
              </div>
            </div>
          </div>

          <div className="p-8 grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="space-y-4">
              <h3 className="font-bold text-slate-900 flex items-center"><Users className="w-4 h-4 mr-2 text-indigo-600" /> Participants</h3>
              <div className="space-y-2">
                {reservation.ticketHolders?.map((h, i) => (
                  <div key={i} className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                    <p className="font-bold text-sm">{h.firstName} {h.lastName}</p>
                    <p className="text-[10px] text-slate-500 uppercase">{h.type === 'adult' ? 'Adulte' : h.type === 'child' ? 'Enfant' : 'PMR'}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="font-bold text-slate-900 flex items-center"><Ticket className="w-4 h-4 mr-2 text-indigo-600" /> Récapitulatif Places</h3>
              <div className="space-y-2">
                {reservation.adultCount > 0 && <div className="flex justify-between text-sm"><span>Adulte (13+)</span> <span className="font-bold">{reservation.adultCount}</span></div>}
                {reservation.childCount > 0 && <div className="flex justify-between text-sm"><span>Enfant (-12)</span> <span className="font-bold">{reservation.childCount}</span></div>}
                {reservation.pmrCount > 0 && <div className="flex justify-between text-sm"><span>PMR</span> <span className="font-bold">{reservation.pmrCount}</span></div>}
                <div className="pt-2 border-t border-slate-100 flex justify-between font-bold text-indigo-600">
                  <span>Total</span>
                  <span>{(reservation.adultCount * settings.priceAdult) + (reservation.childCount * settings.priceChild) + (reservation.pmrCount * settings.pricePmr)}€</span>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="font-bold text-slate-900 flex items-center"><Settings className="w-4 h-4 mr-2 text-indigo-600" /> Actions Admin</h3>
              <div className="grid grid-cols-1 gap-2">
                {reservation.status !== 'completed' && (
                  <button 
                    onClick={() => handleUpdateStatus(reservation.id, 'completed')}
                    className="w-full py-3 bg-emerald-600 text-white rounded-xl font-bold text-sm hover:bg-emerald-700 transition-colors flex items-center justify-center"
                  >
                    <CheckCircle className="w-4 h-4 mr-2" /> Valider la commande
                  </button>
                )}
                {reservation.status !== 'cancelled' && (
                  <button 
                    onClick={() => handleUpdateStatus(reservation.id, 'cancelled')}
                    className="w-full py-3 bg-rose-600 text-white rounded-xl font-bold text-sm hover:bg-rose-700 transition-colors flex items-center justify-center"
                  >
                    <XCircle className="w-4 h-4 mr-2" /> Annuler la commande
                  </button>
                )}
                <button 
                  onClick={() => setTicketViewId(reservation.id)}
                  className="w-full py-3 bg-indigo-600 text-white rounded-xl font-bold text-sm hover:bg-indigo-700 transition-colors flex items-center justify-center"
                >
                  <FileText className="w-4 h-4 mr-2" /> Voir Preuve d'Achat (Aperçu)
                </button>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    );
  };

  // --- VUE : RÉSERVATION ---
  const BookingView = () => {
    const [dancerCode, setDancerCode] = useState('');
    const [memberInfo, setMemberInfo] = useState<Member | null>(null);
    const [reqAdult, setReqAdult] = useState(0);
    const [reqChild, setReqChild] = useState(0);
    const [reqPmr, setReqPmr] = useState(0);
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [buyerEmail, setBuyerEmail] = useState('');
    const [ticketHolders, setTicketHolders] = useState<{ firstName: string; lastName: string; type: 'adult' | 'child' | 'pmr' }[]>([]);
    const [memberReservations, setMemberReservations] = useState<Reservation[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);

    // Validate dancer code and fetch info
    useEffect(() => {
      const validateCode = async () => {
        if (settings.phase === 1 && dancerCode.trim().length >= 6) {
          try {
            const mDoc = await getDoc(doc(db, 'members', dancerCode.trim().toUpperCase()));
            if (mDoc.exists()) {
              setMemberInfo({ id: mDoc.id, ...mDoc.data() } as Member);
              logAppEvent('dancer_code_success', { code: dancerCode.trim().toUpperCase() });
            } else {
              setMemberInfo(null);
              logAppEvent('dancer_code_invalid', { code: dancerCode.trim().toUpperCase() });
            }
          } catch (err) {
            setMemberInfo(null);
          }
        } else {
          setMemberInfo(null);
        }
      };
      validateCode();
    }, [dancerCode, settings.phase]);

    // Fetch existing reservations for this dancer code
    useEffect(() => {
      if (settings.phase === 1 && memberInfo) {
        const resQuery = query(collection(db, 'reservations'), orderBy('createdAt', 'desc'));
        const unsubscribe = onSnapshot(resQuery, (snap) => {
          const results: Reservation[] = [];
          snap.forEach(d => {
            const data = d.data();
            if (data.dancerCode === dancerCode.trim().toUpperCase()) {
              results.push({ id: d.id, ...data } as Reservation);
            }
          });
          setMemberReservations(results);
        });
        return () => unsubscribe();
      } else {
        setMemberReservations([]);
      }
    }, [memberInfo, dancerCode, settings.phase]);

    // Update ticket holders when counts change
    useEffect(() => {
      const newHolders: { firstName: string; lastName: string; type: 'adult' | 'child' | 'pmr' }[] = [];
      
      // Keep existing names if possible
      const getExisting = (index: number, type: 'adult' | 'child' | 'pmr') => {
        const existing = ticketHolders.filter(h => h.type === type)[index];
        return existing || { firstName: '', lastName: '', type };
      };

      for (let i = 0; i < reqAdult; i++) newHolders.push(getExisting(i, 'adult'));
      for (let i = 0; i < reqChild; i++) newHolders.push(getExisting(i, 'child'));
      for (let i = 0; i < reqPmr; i++) newHolders.push(getExisting(i, 'pmr'));
      
      setTicketHolders(newHolders);
    }, [reqAdult, reqChild, reqPmr]);

    const updateHolder = (index: number, field: 'firstName' | 'lastName', value: string) => {
      const updated = [...ticketHolders];
      updated[index] = { ...updated[index], [field]: value };
      setTicketHolders(updated);
    };

    const handleContinuePayment = async (res: Reservation) => {
      setIsProcessing(true);
      try {
        const totalAmount = (res.adultCount * settings.priceAdult) + (res.childCount * settings.priceChild) + (res.pmrCount * settings.pricePmr);
        
        logAppEvent('reconnect_checkout', { 
          amount: totalAmount, 
          reservation_id: res.id 
        });

        // 1. Create NEW Checkout Intent
        const checkoutRes = await axios.post('/api/helloasso/checkout', {
          amount: totalAmount,
          label: `Gala - ${res.adultCount + res.childCount + res.pmrCount} places (Reprise)`,
          buyer: { 
            firstName: res.buyerName.split(' ')[0], 
            lastName: res.buyerName.split(' ').slice(1).join(' ') || res.buyerName, 
            email: res.buyerEmail 
          },
          metadata: { dancerCode: res.dancerCode, adult: res.adultCount, child: res.childCount, pmr: res.pmrCount }
        });

        // 2. Update existing reservation with the new HelloAsso ID
        await updateDoc(doc(db, 'reservations', res.id), {
          helloAssoId: checkoutRes.data.id,
          updatedAt: serverTimestamp()
        });

        // 3. Redirect
        window.location.href = checkoutRes.data.redirectUrl;
      } catch (err: any) {
        showToast("Erreur lors de la reprise du paiement", "error");
        setIsProcessing(false);
      }
    };

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

      // Validate ticket holders
      const invalidHolder = ticketHolders.some(h => !h.firstName.trim() || !h.lastName.trim());
      if (invalidHolder) {
        return showToast("Veuillez saisir le nom de chaque participant", "error");
      }

      setIsProcessing(true);

      try {
        if (settings.phase === 1) {
          if (!dancerCode.trim()) throw new Error("Code danseur requis en Phase 1");
          const memberDoc = await getDoc(doc(db, 'members', dancerCode.trim()));
          if (!memberDoc.exists()) throw new Error("Code danseur invalide");
          
          const member = memberDoc.data() as Member;
          const allowedQuota = member.maxTicketsOverride || settings.maxPerDancerPhase1;
          if (member.ticketsBought + totalRequested > allowedQuota) {
            throw new Error(`Quota dépassé (${member.ticketsBought}/${allowedQuota})`);
          }
        }

        // 1. Create Checkout Intent via Backend (HelloAsso)
        const totalAmount = (reqAdult * settings.priceAdult) + (reqChild * settings.priceChild) + (reqPmr * settings.pricePmr);
        
        logAppEvent('begin_checkout', { 
          amount: totalAmount, 
          tickets: totalRequested,
          phase: settings.phase 
        });

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
          ticketHolders,
          status: 'pending',
          createdAt: serverTimestamp(),
          helloAssoId: checkoutRes.data.id
        });

        // 3. Redirect to HelloAsso directly in the same window to avoid popup blocker issues
        window.location.href = checkoutRes.data.redirectUrl;

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
          <h2 className="text-3xl font-bold text-slate-900 mb-2">Gala "Et vie danse"</h2>
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
              <input 
                type="text" 
                value={dancerCode} 
                onChange={e => setDancerCode(e.target.value.toUpperCase())} 
                required 
                placeholder="Ex: AB1234"
                className="w-full px-4 py-2 border border-indigo-200 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 uppercase" 
              />
              {memberInfo ? (
                <div className="mt-3 flex items-center justify-between bg-white/50 p-2 rounded-lg border border-indigo-100">
                  <span className="text-xs font-bold text-indigo-700">
                    {memberInfo.firstName} {memberInfo.lastName}
                  </span>
                  <span className="text-xs font-black text-indigo-600">
                    Places restantes : {Math.max(0, (memberInfo.maxTicketsOverride || settings.maxPerDancerPhase1) - memberInfo.ticketsBought)}
                  </span>
                </div>
              ) : dancerCode.length >= 6 ? (
                <p className="text-xs text-rose-500 mt-2 font-bold">Code inconnu</p>
              ) : (
                <p className="text-xs text-indigo-600 mt-2">Max {settings.maxPerDancerPhase1} places par danseur.</p>
              )}
            </div>
          )}

          {/* Affichage des commandes existantes pour ce code */}
          {memberReservations.length > 0 && (
            <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200">
              <h3 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center">
                <Ticket className="w-3 h-3 mr-2" /> Vos commandes précédentes
              </h3>
              <div className="space-y-3">
                {memberReservations.map(res => (
                  <div key={res.id} className="bg-white p-3 rounded-xl border border-slate-100 flex items-center justify-between shadow-sm">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-slate-900">{res.adultCount + res.childCount + res.pmrCount} places</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-black uppercase ${
                          res.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                        }`}>
                          {res.status === 'completed' ? 'Payé' : 'En attente'}
                        </span>
                      </div>
                      <div className="flex gap-2 mt-0.5">
                        {res.adultCount > 0 && <span className="text-[10px] text-slate-500 font-medium">{res.adultCount} Adulte(s)</span>}
                        {res.childCount > 0 && <span className="text-[10px] text-slate-500 font-medium">{res.childCount} Enfant(s)</span>}
                        {res.pmrCount > 0 && <span className="text-[10px] text-slate-500 font-medium">{res.pmrCount} PMR</span>}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {res.ticketHolders?.slice(0, 3).map((h: any, i: number) => (
                          <span key={i} className="text-[9px] bg-slate-100 text-slate-600 px-1 py-0.5 rounded italic">
                            {h.firstName} {h.lastName[0]}.
                          </span>
                        ))}
                        {res.ticketHolders?.length > 3 && <span className="text-[9px] text-slate-400">...</span>}
                      </div>
                      <p className="text-[10px] text-slate-400 mt-1 uppercase font-bold tracking-tighter">
                        {new Date(res.createdAt?.toDate ? res.createdAt.toDate() : res.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    
                    {res.status === 'pending' ? (
                      <button 
                        type="button" 
                        disabled={isProcessing}
                        onClick={() => handleContinuePayment(res)}
                        className="bg-indigo-600 text-white text-[11px] font-black px-3 py-2 rounded-lg hover:bg-indigo-700 transition-colors flex items-center"
                      >
                        {isProcessing ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <ArrowRight className="w-3 h-3 mr-1" />}
                        PAYER
                      </button>
                    ) : (
                      <button 
                        type="button" 
                        onClick={() => setTicketViewId(res.id)}
                        className="bg-slate-900 text-white text-[11px] font-black px-3 py-2 rounded-lg hover:bg-slate-800 transition-colors flex items-center"
                      >
                        <FileText className="w-3 h-3 mr-1" /> TICKET
                      </button>
                    )}
                  </div>
                ))}
              </div>
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

          {ticketHolders.length > 0 && (
            <div className="space-y-4 pt-4 border-t border-slate-100">
              <h4 className="text-sm font-bold text-slate-900">Noms des participants</h4>
              {ticketHolders.map((holder, idx) => (
                <div key={idx} className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      Billet #{idx + 1} - {holder.type === 'adult' ? 'Adulte' : holder.type === 'child' ? 'Enfant' : 'PMR'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <input 
                      type="text" 
                      placeholder="Prénom" 
                      value={holder.firstName}
                      onChange={e => updateHolder(idx, 'firstName', e.target.value)}
                      required
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <input 
                      type="text" 
                      placeholder="Nom" 
                      value={holder.lastName}
                      onChange={e => updateHolder(idx, 'lastName', e.target.value)}
                      required
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

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
    const [resSearch, setResSearch] = useState('');
    const [editingMember, setEditingMember] = useState<Member | null>(null);

    useEffect(() => {
      setEditSettings(settings);
    }, [settings]);

    if (!isAdmin) return <div className="p-8 text-center">Accès refusé</div>;

    const filteredReservations = reservations.filter(r => 
      r.buyerName.toLowerCase().includes(resSearch.toLowerCase()) ||
      r.buyerEmail.toLowerCase().includes(resSearch.toLowerCase()) ||
      String(r.helloAssoId).includes(resSearch)
    );

    const handleSaveSettings = async () => {
      try {
        await updateDoc(doc(db, 'settings', 'global'), { ...editSettings });
        logAppEvent('admin_save_settings', { phase: editSettings.phase });
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
        logAppEvent('admin_delete_members', { count: selectedMembers.length });
        for (const id of selectedMembers) {
          await deleteDoc(doc(db, 'members', id));
        }
        setSelectedMembers([]);
        showToast(`${selectedMembers.length} adhérent(s) supprimé(s)`);
      } catch (err) {
        showToast("Erreur lors de la suppression", "error");
      }
    };

    const totalRevenue = (sales.adult * (settings.priceAdult || 0)) + (sales.child * (settings.priceChild || 0)) + (sales.pmr * (settings.pricePmr || 0));
    const completedRes = reservations.filter(r => r.status === 'completed').length;
    const pendingRes = reservations.filter(r => r.status === 'pending').length;
    const activeMembers = members.filter(m => m.ticketsBought > 0).length;

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

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div className="p-2 bg-indigo-50 rounded-lg text-indigo-600"><Ticket className="w-5 h-5" /></div>
              <span className="text-xl font-black text-slate-900">{sales.adult + sales.child} / {settings.capacityStd}</span>
            </div>
            <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
              <div className="bg-indigo-600 h-full" style={{ width: `${Math.min(100, ((sales.adult + sales.child) / settings.capacityStd) * 100)}%` }} />
            </div>
            <p className="text-[10px] uppercase font-bold text-slate-400 mt-3 tracking-wider">Ventes Standard</p>
          </div>

          <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div className="p-2 bg-purple-50 rounded-lg text-purple-600"><Users className="w-5 h-5" /></div>
              <span className="text-xl font-black text-slate-900">{sales.pmr} / {settings.capacityPmr}</span>
            </div>
            <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
              <div className="bg-purple-600 h-full" style={{ width: `${Math.min(100, (sales.pmr / settings.capacityPmr) * 100)}%` }} />
            </div>
            <p className="text-[10px] uppercase font-bold text-slate-400 mt-3 tracking-wider">Ventes PMR</p>
          </div>

          <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <div className="p-2 bg-emerald-50 rounded-lg text-emerald-600"><CheckCircle2 className="w-5 h-5" /></div>
              <span className="text-xl font-black text-slate-900">{totalRevenue.toFixed(2)}€</span>
            </div>
            <p className="text-[10px] uppercase font-bold text-slate-400 mt-3 tracking-wider">Chiffre d'Affaires</p>
            <div className="mt-1 flex gap-2">
              <span className="text-[9px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold">{completedRes} Payés</span>
              <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-bold">{pendingRes} En attente</span>
            </div>
          </div>

          <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <div className="p-2 bg-blue-50 rounded-lg text-blue-600"><Users className="w-5 h-5" /></div>
              <span className="text-xl font-black text-slate-900">{activeMembers} / {members.length}</span>
            </div>
            <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
              <div className="bg-blue-600 h-full" style={{ width: `${Math.min(100, (activeMembers / (members.length || 1)) * 100)}%` }} />
            </div>
            <p className="text-[10px] uppercase font-bold text-slate-400 mt-3 tracking-wider">Adhérents Actifs</p>
          </div>
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
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${(m.maxTicketsOverride || settings.maxPerDancerPhase1) - m.ticketsBought > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                            {(m.maxTicketsOverride || settings.maxPerDancerPhase1) - m.ticketsBought} / {m.maxTicketsOverride || settings.maxPerDancerPhase1}
                          </span>
                        </td>
                        <td className="py-2 text-right">
                          <div className="flex items-center justify-end space-x-1">
                            <button 
                              onClick={() => setEditingMember(m)}
                              className="p-1.5 text-slate-400 hover:text-indigo-600 transition-colors"
                              title="Modifier"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                            <button 
                              onClick={() => sendMemberEmail(m)}
                              className="p-1.5 text-slate-400 hover:text-indigo-600 transition-colors"
                              title="Envoyer le code"
                            >
                              <Mail className="w-4 h-4" />
                            </button>
                            <button 
                              onClick={() => handleDeleteMember(m.id)}
                              className="p-1.5 text-slate-400 hover:text-rose-600 transition-colors"
                              title="Supprimer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                          {m.lastEmailSentAt && (
                            <span className="text-[8px] text-slate-400 block">
                              Envoyé le {new Date(m.lastEmailSentAt.seconds * 1000).toLocaleDateString()}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <AnimatePresence>
            {editingMember && (
              <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md border border-slate-100"
                >
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-xl font-bold text-slate-900">Modifier Adhérent</h3>
                    <button onClick={() => setEditingMember(null)} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
                      <XCircle className="w-5 h-5 text-slate-400" />
                    </button>
                  </div>
                  
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Prénom</label>
                      <input 
                        type="text" 
                        value={editingMember.firstName} 
                        onChange={e => setEditingMember({...editingMember, firstName: e.target.value})}
                        className="w-full px-4 py-2 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Nom</label>
                      <input 
                        type="text" 
                        value={editingMember.lastName} 
                        onChange={e => setEditingMember({...editingMember, lastName: e.target.value})}
                        className="w-full px-4 py-2 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Email</label>
                      <input 
                        type="email" 
                        value={editingMember.email || ''} 
                        onChange={e => setEditingMember({...editingMember, email: e.target.value})}
                        className="w-full px-4 py-2 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Places déjà achetées</label>
                      <input 
                        type="number" 
                        value={editingMember.ticketsBought} 
                        onChange={e => setEditingMember({...editingMember, ticketsBought: Number(e.target.value)})}
                        className="w-full px-4 py-2 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Quota Spécifique (optionnel)</label>
                      <input 
                        type="number" 
                        placeholder={`Par défaut: ${settings.maxPerDancerPhase1}`}
                        value={editingMember.maxTicketsOverride || ''} 
                        onChange={e => setEditingMember({...editingMember, maxTicketsOverride: e.target.value ? Number(e.target.value) : undefined})}
                        className="w-full px-4 py-2 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>

                  <div className="mt-8 flex gap-3">
                    <button 
                      onClick={() => setEditingMember(null)}
                      className="flex-1 px-4 py-2 border border-slate-200 rounded-xl font-bold text-slate-600 hover:bg-slate-50 transition-colors"
                    >
                      Annuler
                    </button>
                    <button 
                      onClick={async () => {
                        const updateData: any = {
                          firstName: editingMember.firstName,
                          lastName: editingMember.lastName,
                          email: editingMember.email || "",
                          ticketsBought: editingMember.ticketsBought
                        };
                        
                        if (editingMember.maxTicketsOverride !== undefined) {
                          updateData.maxTicketsOverride = editingMember.maxTicketsOverride;
                        }

                        await handleUpdateMember(editingMember.id, updateData);
                        setEditingMember(null);
                      }}
                      className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-colors"
                    >
                      Enregistrer
                    </button>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
            <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
              <h3 className="font-bold flex items-center"><Ticket className="mr-2 w-5 h-5" /> Dernières Réservations</h3>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input 
                  type="text" 
                  placeholder="Rechercher..." 
                  value={resSearch}
                  onChange={e => setResSearch(e.target.value)}
                  className="pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500 w-full md:w-64"
                />
              </div>
            </div>

            <div className="space-y-4 max-h-[600px] overflow-y-auto pr-2">
              {filteredReservations.length === 0 ? (
                <div className="text-center py-12 text-slate-400 italic">Aucune réservation trouvée</div>
              ) : (
                filteredReservations.map(res => {
                  const totalAmount = (res.adultCount * settings.priceAdult) + (res.childCount * settings.priceChild) + (res.pmrCount * settings.pricePmr);
                  const dateStr = res.createdAt?.seconds ? new Date(res.createdAt.seconds * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '...';
                  
                  return (
                    <div key={res.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:border-indigo-200 transition-all group">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-bold text-slate-900">{res.buyerName}</span>
                            <span className={`text-[10px] font-black px-2 py-0.5 rounded-full uppercase ${
                              res.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 
                              res.status === 'cancelled' ? 'bg-rose-100 text-rose-700' :
                              'bg-amber-100 text-amber-700'
                            }`}>
                              {res.status}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                            <span className="flex items-center"><Mail className="w-3 h-3 mr-1" /> {res.buyerEmail}</span>
                            <span className="flex items-center font-mono">ID: {res.helloAssoId}</span>
                            <span className="font-medium text-slate-400">{dateStr}</span>
                          </div>

                          {res.ticketHolders && res.ticketHolders.length > 0 && (
                            <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap gap-2">
                              {res.ticketHolders.map((th, i) => (
                                <span key={i} className="px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded text-[9px] font-medium border border-indigo-100">
                                  {th.firstName} {th.lastName} ({th.type === 'adult' ? 'Ad' : th.type === 'child' ? 'Enf' : 'PMR'})
                                </span>
                              ))}
                            </div>
                          )}

                          <div className="mt-2 flex items-center gap-3">
                            <div className="flex items-center gap-1 bg-white px-2 py-0.5 rounded-lg border border-slate-200 text-[10px] font-bold">
                              <span className="text-indigo-600">{res.adultCount}</span> Ad
                            </div>
                            <div className="flex items-center gap-1 bg-white px-2 py-0.5 rounded-lg border border-slate-200 text-[10px] font-bold">
                              <span className="text-indigo-600">{res.childCount}</span> Enf
                            </div>
                            <div className="flex items-center gap-1 bg-white px-2 py-0.5 rounded-lg border border-slate-200 text-[10px] font-bold">
                              <span className="text-indigo-600">{res.pmrCount}</span> PMR
                            </div>
                            <div className="ml-auto font-black text-indigo-600 text-sm">
                              {totalAmount}€
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 md:opacity-0 group-hover:opacity-100 transition-opacity">
                          {res.status === 'completed' && (
                            <button 
                              onClick={() => setTicketViewId(res.id)}
                              className="p-2 bg-white border border-slate-200 rounded-xl text-indigo-600 hover:bg-indigo-50 transition-colors"
                              title="Voir Preuve d'Achat"
                            >
                              <FileText className="w-4 h-4" />
                            </button>
                          )}
                          {res.status === 'pending' && (
                            <button 
                              onClick={() => handleManualCheckStatus(res)}
                              className="p-2 bg-white border border-slate-200 rounded-xl text-amber-600 hover:bg-amber-50 transition-colors"
                              title="Vérifier HelloAsso"
                            >
                              <RefreshCw className="w-4 h-4" />
                            </button>
                          )}
                          {res.status !== 'completed' && (
                            <button 
                              onClick={() => handleUpdateStatus(res.id, 'completed')}
                              className="p-2 bg-white border border-slate-200 rounded-xl text-emerald-600 hover:bg-emerald-50 transition-colors"
                              title="Forcer Validation"
                            >
                              <CheckCircle className="w-4 h-4" />
                            </button>
                          )}
                          {res.status !== 'cancelled' && (
                            <button 
                              onClick={() => handleUpdateStatus(res.id, 'cancelled')}
                              className="p-2 bg-white border border-slate-200 rounded-xl text-rose-600 hover:bg-rose-50 transition-colors"
                              title="Annuler"
                            >
                              <XCircle className="w-4 h-4" />
                            </button>
                          )}
                          <button 
                            onClick={() => handleDeleteReservation(res.id)}
                            className="p-2 bg-white border border-slate-200 rounded-xl text-slate-400 hover:text-rose-600 transition-colors"
                            title="Supprimer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
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
      <div className="space-y-3">
        {lastConfirmedResId && (
          <button 
            onClick={() => setTicketViewId(lastConfirmedResId)}
            className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-lg hover:bg-indigo-700 transition-all flex items-center justify-center"
          >
            <FileText className="w-5 h-5 mr-2" /> Voir ma Preuve d'Achat
          </button>
        )}
        <button 
          onClick={() => { setPaymentConfirmed(false); setLastConfirmedResId(null); }}
          className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-lg hover:bg-slate-800 transition-all"
        >
          Retour à l'accueil
        </button>
      </div>
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
              <span className="text-xl font-black tracking-tighter text-slate-900 uppercase">Et vie <span className="text-indigo-600">danse</span></span>
            </div>
            <div className="flex items-center space-x-4">
              <button onClick={() => { setCurrentView('booking'); logAppEvent('view_booking'); }} className={`text-sm font-bold ${currentView === 'booking' ? 'text-indigo-600' : 'text-slate-500'}`}>Billetterie</button>
              {isAdmin && (
                <button onClick={() => { setCurrentView('admin'); logAppEvent('view_admin'); }} className={`text-sm font-bold ${currentView === 'admin' ? 'text-indigo-600' : 'text-slate-500'}`}>Admin</button>
              )}
              {!user ? (
                <button onClick={login} className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-bold">Connexion</button>
              ) : (
                <img src={user.photoURL || ''} alt="User" className="w-8 h-8 rounded-full border border-slate-200" />
              )}
            </div>
          </div>
        </nav>

        <main className="max-w-7xl mx-auto px-4 py-12">
          {adminCheckReservation ? (
            <AdminCheckView reservation={adminCheckReservation} />
          ) : ticketViewReservation ? (
            <TicketView reservation={ticketViewReservation} />
          ) : paymentConfirmed ? (
            <PaymentSuccessView />
          ) : (
            currentView === 'booking' ? <BookingView /> : <AdminView />
          )}
        </main>
      </div>
  );
}

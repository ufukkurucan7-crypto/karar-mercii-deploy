// ─────────────────────────────────────────────────────────────────────────────
// TEK SEFERLİK TEMİZLİK — birikmiş "süresiz" odaları kapat (17 Tem 2026)
//
// NEDEN: Odalar oluşturulurken süre seçilmezse closesAt:null yazılıyordu ("süresiz
// oda") → ne sunucu ne client onları asla kapatmıyordu → aylardır her oda
// status:"open" olarak birikti. Eski sunucu sorgusu her dakika TÜM açık odaları
// okuduğu için bunlar 50K/gün Firebase Spark okuma tavanını doldurdu ve Firestore
// komple durdu (giriş/geçmiş/AI/oda hepsi bozuldu).
//
// Kaçak artık kaynağında kapatıldı (her odaya closesAt yazılıyor, sunucu sorgusu
// filtreli). Bu script yalnızca GEÇMİŞTEN kalan ölü odaları kapatır.
//
// ÇALIŞTIRMA (Replit Shell — FIREBASE_SERVICE_ACCOUNT env'i orada mevcut):
//   node km-cleanup-rooms.js          → KURU ÇALIŞMA (hiçbir şey yazmaz, sadece sayar)
//   node km-cleanup-rooms.js --apply  → gerçekten kapatır
//
// ⚠️ Firebase kotası dolmuşken ÇALIŞTIRMA — kota sıfırlandıktan sonra (Pasifik
// gece yarısı ≈ TR 10:00) çalıştır. Maliyet: tek seferlik ~1 okuma/oda.
// ⚠️ Karar geçmişi decisions/{uid}/history altında AYRI durur — bu script ona
// dokunmaz, hiçbir kullanıcı geçmişi kaybolmaz.
// ─────────────────────────────────────────────────────────────────────────────

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

const APPLY = process.argv.includes("--apply");
const TTL_DAYS = 30;

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("HATA: FIREBASE_SERVICE_ACCOUNT env yok. Replit Shell'de çalıştır.");
  process.exit(1);
}

initializeApp({ cert: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

// live-server.js autoCloseExpiredRooms ile BİREBİR aynı sayım — kapanan oda
// showOnlineWinner'ın okuduğu alanların hepsine sahip olsun (winner/winnerPoints/
// winnerVoters/tieItems), yoksa kullanıcı bozuk kazanan kartı görür.
function tally(data) {
  const parts = data.participants || {};
  const options = Array.isArray(data.options) ? data.options : [];
  const voterCount = Object.values(parts).filter(
    (p) => p && p.submitted === true,
  ).length;

  if (voterCount === 0) {
    return { status: "tied", tieItems: options, winner: null, winnerPoints: 0, winnerVoters: 0 };
  }
  const totalsMap = {};
  options.forEach((o) => (totalsMap[o] = 0));
  Object.values(parts).forEach((p) => {
    if (!p || p.submitted !== true || !p.votes) return;
    Object.entries(p.votes).forEach(([o, s]) => {
      totalsMap[o] = (totalsMap[o] || 0) + +(s || 0);
    });
  });
  const sorted = Object.entries(totalsMap).sort((a, b) => b[1] - a[1]);
  const topScore = sorted.length ? sorted[0][1] : 0;
  const winners = sorted.filter((x) => x[1] === topScore).map((x) => x[0]);
  const winner = winners[Math.floor(Math.random() * winners.length)];
  return { status: "closed", winner, winnerPoints: topScore, winnerVoters: voterCount, tieItems: [] };
}

async function main() {
  console.log(APPLY ? "MOD: UYGULA (yazacak)" : "MOD: KURU ÇALIŞMA (hiçbir şey yazmaz)");

  const snap = await db.collection("rooms").where("status", "==", "open").get();
  console.log(`Açık oda sayısı: ${snap.size} (bu sorgu ${snap.size || 1} okuma harcadı)`);

  let sureli = 0, hedef = 0, kapatildi = 0, hata = 0;

  for (const docSnap of snap.docs) {
    const d = docSnap.data();
    // closesAt'ı OLAN odalara DOKUNMA: onlar meşru süreli odalar, sunucu/client
    // zaten vakti gelince kapatır. Sadece "ölümsüz" (closesAt yok) olanları al.
    if (d.closesAt) { sureli++; continue; }
    hedef++;

    const yas = d.created ? Math.floor((Date.now() - d.created) / 86400000) : "?";
    const res = tally(d);
    console.log(
      `  ${docSnap.id}: ${yas} günlük, ${Object.keys(d.participants || {}).length} katılımcı ` +
      `→ ${res.status}${res.winner ? " (" + res.winner + ")" : ""}`,
    );

    if (!APPLY) continue;
    try {
      await docSnap.ref.update({
        ...res,
        closedBy: "cleanup",
        closedAt: Date.now(),
        // TTL politikası rooms.ttlAt üzerinde çalışır → bu odalar 30 gün sonra silinir.
        ttlAt: Timestamp.fromMillis(Date.now() + TTL_DAYS * 86400000),
      });
      kapatildi++;
    } catch (e) {
      hata++;
      console.error(`  ✗ ${docSnap.id} kapatılamadı: ${e.message}`);
    }
  }

  console.log("\n─── ÖZET ───");
  console.log(`Dokunulmadı (meşru süreli oda): ${sureli}`);
  console.log(`Hedef (süresiz, ölümsüz oda)  : ${hedef}`);
  if (APPLY) {
    console.log(`Kapatıldı                     : ${kapatildi}`);
    if (hata) console.log(`HATA                          : ${hata}`);
  } else if (hedef) {
    console.log("\nGerçekten kapatmak için: node km-cleanup-rooms.js --apply");
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("TEMİZLİK HATASI:", e.message);
  process.exit(1);
});

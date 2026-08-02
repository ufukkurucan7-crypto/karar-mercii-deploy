const express = require("express");
const path = require("path");
const fs = require("fs"); // yalnız index.html okumak için (OG meta enjeksiyonu)
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

// Deploy doğrulama ucu. SEBEP: index.html'in canlıda kaç byte olduğu curl ile
// sayılabiliyor ama SUNUCU dosyasının hangi sürüm olduğu dışarıdan hiç
// görünmüyordu → "deploy tuttu mu?" sorusu cihaz testine kalıyordu.
// Tek curl ile: kararmercii.com/version
// ⚠️ Sadece boyut/tarih/bayrak DURUMU döner; secret veya değer ASLA dönmez.
const _bootedAt = new Date().toISOString();
app.get("/version", (req, res) => {
  const stat = (p) => {
    try {
      const s = fs.statSync(p);
      return { bytes: s.size, mtime: s.mtime.toISOString() };
    } catch {
      return null;
    }
  };
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    server: stat(__filename),
    index: stat(path.join(__dirname, "public", "index.html")),
    bootedAt: _bootedAt,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    flags: {
      toolUse: process.env.KM_TOOL_USE !== "0",
      places: process.env.KM_PLACES || "osm",
      // ⚠️ places:"tomtom" ama tomtomKey:false = sağlayıcı SESSİZCE devre dışı
      // (tomtomSearch anahtar yoksa null döner, akış OSM'e düşer, hata görünmez).
      // Bu ikisini AYRI raporla — tek bayrağa bakıp "açık" sanma tuzağı gerçek.
      tomtomKey: !!process.env.TOMTOM_KEY,
      anthropicKey: !!process.env.ANTHROPIC_API_KEY,
      firebase: !!process.env.FIREBASE_SERVICE_ACCOUNT,
    },
  });
});

// assetlinks.json - Play Store app-link doğrulaması.
// ⚠️ express.static'TEN ÖNCE olmalı: public/ içindeki eski/eksik static
// assetlinks dosyası (yalnız F3:22+6B:72, 48:F0 eksik) bu route'u EZMESIN diye.
// 48:F0 = Play App Signing anahtarı → Play'den inen sürümün oda linklerini açar.
app.get("/.well-known/assetlinks.json", (req, res) => {
  res.json([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "app.kararmercii.com",
        sha256_cert_fingerprints: [
          "48:F0:02:63:71:0B:5D:29:DD:4F:47:2B:10:97:CA:8F:B2:4D:85:B2:05:05:8B:EE:16:38:74:A8:C3:58:68:CA",
          "F3:22:1C:C7:F2:2F:25:6E:8E:D1:34:E9:BC:F7:B8:B7:64:8D:AD:A4:59:02:0B:B6:BC:0A:F5:DE:F1:0A:B5:93",
          "6B:72:30:89:9A:F8:BE:A7:84:91:93:70:C6:81:37:62:1A:19:B9:2F:E2:47:17:DD:86:BA:5A:8B:4F:B5:30:64",
        ],
      },
    },
  ]);
});

// Oda davet linki (?room=KOD) OG önizlemesi. WhatsApp/Telegram crawler'ı
// query'li URL'yi fetch eder ama JS ÇALIŞTIRMAZ → davete özel başlık/açıklama
// sunucudan basılmak zorunda. express.static'ten ÖNCE olmalı ("/" isteğini
// static'in index.html kısayolu yutmasın).
let _idxCache = null;
function readIndex() {
  if (_idxCache === null) {
    _idxCache = fs.readFileSync(
      path.join(__dirname, "public", "index.html"),
      "utf8",
    );
  }
  return _idxCache;
}
app.get("/", (req, res, next) => {
  try {
    let html = readIndex();
    const room = String(req.query.room || "");
    if (room && /^[A-Za-z0-9-]{3,12}$/.test(room)) {
      html = html
        .replace(
          /(<meta property="og:title" content=")[^"]*(")/,
          "$1Seni bir karar odasına çağırıyorlar! 🎡$2",
        )
        .replace(
          /(<meta property="og:description" content=")[^"]*(")/,
          "$1Karar Mercii'nde oylama var — dokun, oyunu ver, kararı birlikte verin.$2",
        );
    }
    // ⚠️ 2 AĞU: burada hiç Cache-Control YOKTU → tarayıcı/WebView sezgisel
    // önbellekleme uyguluyor, çevrimdışıyken (ve bazen çevrimiçiyken) sitenin
    // ESKİ kopyasını basıyordu. no-cache = "önbelleğe al ama KULLANMADAN ÖNCE
    // sunucuya sor" → ETag ile 304 dönerse bant genişliği yine harcanmaz,
    // ama kullanıcı asla bayat sürüm görmez.
    res.set("Cache-Control", "no-cache");
    res.type("html").send(html);
  } catch (e) {
    next(); // index okunamazsa static devralsın
  }
});

// app-ads.txt - AdMob/Google Play uygulama doğrulaması (IAB Tech Lab spec).
// ⚠️ express.static'TEN ÖNCE: public/ altında dosya yoksa 404 dönmesin.
// pub-2604503622179334 = AdMob yayıncı kimliği (kararmercii.com geliştirici sitesi).
app.get("/app-ads.txt", (req, res) => {
  res.type("text/plain");
  res.send("google.com, pub-2604503622179334, DIRECT, f08c47fec0942fa0\n");
});

// ── SERVICE WORKER (2 AĞU) ────────────────────────────────────────────────
// SORUN: index.html yıllardır `/sw.js` kaydetmeye çalışıyordu ama BÖYLE BİR DOSYA
// YOKTU → kayıt sessizce başarısız oluyordu (.catch(function(){}) yutuyor).
// Service worker olmayınca çevrimdışıyken devreye Android WebView'ın kendi HTTP
// disk cache'i giriyor ve sitenin ESKİ bir kopyasını basıyordu — kullanıcının
// "internet kapalıyken eski sürüm geliyor" şikayeti tam olarak buydu.
//
// NEDEN AYRI DOSYA DEĞİL DE ROUTE: km-deploy.sh yalnız index + server çeker;
// public/ altına yeni dosya koymak admin.html/privacy.html gibi AYRI bir curl
// adımı gerektirirdi. Route olarak sunulunca sunucuyla birlikte deploy olur.
//
// ⚠️ STRATEJİ: NETWORK-FIRST, HTML HİÇ ÖNBELLEĞE ALINMAZ. Cache-first ya da
// "son iyi kopyayı sakla" yazsaydık aynı şikayeti (eski sürüm) geri getirirdik.
// Ağ varsa DAİMA taze; ağ yoksa bayat uygulama yerine NET bir çevrimdışı ekranı.
const SW_SOURCE = `// Karar Mercii service worker — network-first, HTML önbelleğe ALINMAZ.
const OFFLINE_HTML = \`<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Çevrimdışısın — Karar Mercii</title><style>
html,body{margin:0;height:100%;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
body{background:linear-gradient(160deg,#4c1d95,#6d28d9);color:#fff;display:flex;
align-items:center;justify-content:center;text-align:center;padding:24px}
.b{max-width:320px}.e{font-size:60px;margin-bottom:14px}
h1{font-size:20px;margin:0 0 10px;font-weight:800}
p{font-size:14px;line-height:1.55;opacity:.85;margin:0 0 22px}
button{background:#fff;color:#5b21b6;border:none;padding:13px 26px;border-radius:14px;
font-size:15px;font-weight:800;cursor:pointer}</style></head><body><div class="b">
<div class="e">🐙</div><h1>İnternet yok</h1>
<p>Karar Mercii çalışmak için internete ihtiyaç duyuyor. Bağlantını kontrol edip
tekrar dene.</p><button onclick="location.reload()">Tekrar Dene</button>
</div></body></html>\`;

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => {
  // Eski sürümlerden kalmış TÜM önbellekleri sil — bayat kopya ihtimalini bitir.
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (e) => {
  const r = e.request;
  // Yalnız sayfa gezinmelerine karışıyoruz. API/POST/diğer istekler doğrudan ağa
  // gider — araya girip bozmayalım (özellikle /merci, /nearby POST'ları).
  if (r.method !== "GET" || r.mode !== "navigate") return;
  e.respondWith(
    fetch(r).catch(
      () =>
        new Response(OFFLINE_HTML, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    ),
  );
});
`;
app.get("/sw.js", (req, res) => {
  res.type("application/javascript");
  // SW dosyasının kendisi asla önbelleğe alınmasın, yoksa strateji güncellemesi ulaşmaz.
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.send(SW_SOURCE);
});

app.use(express.static(path.join(__dirname, "public")));

// ── ANTHROPIC İSTEMCİSİ + TIMEOUT ──
// ⚠️ 17 Tem DERSİ: eskiden hiçbir anthropic.messages.create çağrısında timeout YOKTU.
// Anthropic yanıt vermezse istek SONSUZA KADAR asılı kalıyordu → kullanıcı
// "Merci düşünüyor..." ekranında donuyordu (canlıda yaşandı). Artık her çağrının
// bir üst sınırı var.
// SDK sözleşmesi (Node/TS SDK): constructor `timeout` MİLİSANİYE, `maxRetries`
// varsayılan 2. TIMEOUT DA YENİDEN DENENİR → gerçek bekleme = timeout × (maxRetries+1).
// Bu yüzden maxRetries'i 1'e düşürdük: 529/overload gibi geçici hatada tek bir
// yeniden deneme kalsın ama kullanıcı 3 kat timeout boyunca beklemesin.
const ANTHROPIC_TIMEOUT_MAIN = 30000; // /merci ana çağrı (max_tokens 700) → en kötü ~60sn
const ANTHROPIC_TIMEOUT_SHORT = 15000; // kısa yardımcı çağrılar (seçenek/yorum) → en kötü ~30sn
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: ANTHROPIC_TIMEOUT_MAIN,
  maxRetries: 1,
});

// ── MEKAN ARAMA: TOOL USE (2 AĞU) ──────────────────────────────────────────
// ESKİ TASARIM VE NEDEN BOZUKTU: model cevabının içine `[[NEARBY:food]]` diye gizli
// bir işaret yazıyor, client bunu regex'le yakalayıp /nearby'yi ayrıca çağırıyordu.
// İki yapısal arıza üretiyordu:
//   1) Model işareti KOYMAYI UNUTABİLİYOR → "en yakın simitçileri çıkarıyorum 👇"
//      yazıp hiçbir şey yapmıyor, sessizce başarısız oluyordu (canlı bug, 2 Ağu).
//   2) Model mekanları HİÇ GÖRMEDEN cevabını yazıyordu → kullanıcı "simit" sordu,
//      liste çiğ köfteci döndü, model bunu bilmediği için coşkuyla önerdi.
// YENİ TASARIM: gerçek araç çağrısı. Model `mekan_ara`yı çağırır, sunucu aramayı
// yapar, SONUÇ MODELE GERİ DÖNER, model listeyi GÖREREK cevabını yazar. Böylece
// hem çağrı garanti (API sözleşmesi), hem cevap gerçek veriye dayalı olur.
//
// MALİYET: Anthropic çağrı sayısı DEĞİŞMİYOR. Eskiden de 2 çağrı vardı
// (/merci + /nearby'nin ayrı yorum çağrısı); şimdi de 2 (/merci tur-1 araç kararı +
// tur-2 nihai cevap). İkinci tur, /nearby'nin yorum çağrısının YERİNE geçiyor
// (skipComment ile o çağrı atlanıyor). Model aynı: claude-haiku-4-5.
//
// ⚠️ ACİL GERİ DÖNÜŞ: Replit secrets'a KM_TOOL_USE=0 ekle → eski [[NEARBY]] işaret
// yoluna anında döner. DEPLOY GEREKMEZ, sadece yeniden başlatma yeter.
const KM_TOOL_USE = process.env.KM_TOOL_USE !== "0";

// Açılışta üretilen, süreçten HİÇ çıkmayan rastgele token. Yalnızca sunucunun
// kendi kendine yaptığı /nearby çağrısını IP rate-limit'inden muaf tutmak için
// (bkz. rateLimit içindeki muafiyet bloğu).
const KM_INTERNAL_TOKEN = require("crypto").randomBytes(24).toString("hex");

// `mekan_ara` aracının gövdesi: kendi /nearby ucumuzu çağırır. /nearby'yi REFACTOR
// ETMİYORUZ — auth, günlük kota, exclude akışı, cuisine daraltması, çiğköfte filtresi
// gibi 450 satırlık birikmiş mantık olduğu gibi korunuyor; sadece skipComment ile
// ikinci Haiku yorumu atlanıyor (nihai cevabı asıl model yazacak).
async function callNearbyInternal({
  lat, lng, type, query, auth, osmCuisine, osmShop, osmIsim,
}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/nearby`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth || "",
      "x-km-internal": KM_INTERNAL_TOKEN,
    },
    body: JSON.stringify({
      lat, lng, type, query, skipComment: true,
      // Modelin ürettiği OSM ipuçları — /nearby tarafında SANITIZE edilir.
      osmCuisine, osmShop, osmIsim,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 401/429 (kota) gibi anlamlı retleri mesajıyla yukarı taşı ki model
    // kullanıcıya doğru şeyi söyleyebilsin.
    throw new Error(body.error || `nearby ${r.status}`);
  }
  return body;
}

const MEKAN_ARA_TOOL = {
  name: "mekan_ara",
  description:
    "Kullanıcının yakınındaki GERÇEK mekanları arar (OpenStreetMap). Kullanıcı yakında " +
    "bir yer sorduğunda ('nereye gidelim', 'ne yesek', 'yakında simitçi var mı', " +
    "'kahve içelim', 'bar önerir misin') ya da önerilenleri beğenmeyip başkasını " +
    "istediğinde BU ARACI ÇAĞIR. Sonuç olarak gerçek mekan isimleri ve mesafeleri " +
    "döner; kullanıcıya kart olarak da gösterilir. Mekan ismi veya mesafe ASLA " +
    "uydurma — yalnız bu aracın döndürdüklerini kullan. Sadece sohbet/yorum " +
    "yapıyorsan çağırma.",
  input_schema: {
    type: "object",
    properties: {
      tur: {
        type: "string",
        enum: ["food", "cafe", "dessert", "bar", "activity"],
        description:
          "Mekan kategorisi. food = yemek (restoran/fast food; MEYHANE, RAKI, BALIK da " +
          "food'dur), cafe = kahve/kafe, dessert = tatlı/pastane/dondurma, " +
          "bar = YALNIZ bira/kokteyl/gece kulübü, activity = park/sinema/bowling gibi aktivite.",
      },
      arama: {
        type: "string",
        description:
          "Kullanıcının istediği ŞEY — Türkçe, TEKİL, EKSİZ ve DOĞRU YAZILMIŞ kök hâlde. " +
          "Bu metin doğrudan mekan arama servisine gider, o yüzden NORMALLEŞTİR: " +
          "kullanıcı 'kokorec nerde yiyebilirim' / 'KOKOREÇÇİ' / 'kokorecci' / 'kokoreçler' " +
          "yazsa da sen sadece 'kokoreç' gönder. Örnekler: 'kumpirci'→'kumpir', " +
          "'tantunici'→'tantuni', 'midyeci'→'midye', 'dürümcü'→'dürüm', " +
          "'simitçi'→'simit', 'balıkçılar'→'balık'. Cümle, fiil ya da soru YAZMA — " +
          "sadece yemeğin/mekanın adı. Kullanıcı belirli bir şey söylemediyse BOŞ BIRAK " +
          "(boş bırakmak, uydurma bir terim göndermekten iyidir).",
      },
      // ── OSM İPUÇLARI: KELİME TABLOSUNU BİTİREN PARÇA (2 AĞU) ──
      // Sunucudaki CUISINE_RULES elle yazılmış ~20 satırlık bir tabloydu; listede
      // olmayan her kavram ("kokoreç", "kumpir", "midye", "tantuni"...) jenerik
      // "en yakın yemek yeri" sepetine düşüyordu. Sonsuz kavram / sonlu tablo.
      // ÇÖZÜM: etiketleri MODEL üretsin — Türkçe yemek kültürünü zaten biliyor
      // (kokoreç=sakatat, kumpir=patates, midye=deniz ürünü). Bu alanlar dolu
      // gelirse sunucu tabloyu ATLAYIP doğrudan bunlarla arar; boşsa eski tablo
      // yedek olarak devreye girer. Ek API çağrısı YOK — aynı çağrının parçası.
      osm_cuisine: {
        type: "string",
        description:
          "OpenStreetMap `cuisine` etiketi için regex, | ile ayrılmış İNGİLİZCE/OSM " +
          "değerleri. Örnek: kokoreç → 'kokorec|offal|street_food', kumpir → " +
          "'potato|baked_potato', midye → 'seafood|mussel', tantuni → 'turkish|wrap'. " +
          "Emin değilsen boş bırak.",
      },
      osm_shop: {
        type: "string",
        description:
          "Mekan bir DÜKKÂN türüyse OSM `shop` değerleri, | ile ayrılmış. Örnek: " +
          "simit/börek → 'bakery|pastry', kasap → 'butcher', şarküteri → 'deli'. " +
          "Restoran/kafe gibi amenity türleri için boş bırak.",
      },
      osm_isim: {
        type: "string",
        description:
          "Mekan İSMİNDE geçmesi muhtemel kelimeler, | ile ayrılmış TÜRKÇE regex. " +
          "OSM'de etiket eksikse isimden yakalamak için. Örnek: kokoreç → " +
          "'kokoreç|kokorec', kumpir → 'kumpir|patates', tantuni → 'tantuni'. " +
          "Türkçe karakterlerin hem 'ç/c' hem 'ı/i' varyantını yaz.",
      },
    },
    required: ["tur"],
  },
};

// Timeout hatasını diğer API hatalarından ayırt et (504 vs 500 için).
// SDK sürümü Replit'te sabit değil → tek bir sınıf adına GÜVENME; sınıf varsa onu
// kullan, yoksa isim/kod/mesaj sinyallerine düş.
function isAnthropicTimeout(e) {
  if (!e) return false;
  const TimeoutCls = Anthropic.APIConnectionTimeoutError;
  if (typeof TimeoutCls === "function" && e instanceof TimeoutCls) return true;
  const name = String(e.name || "");
  const msg = String(e.message || "");
  return (
    name === "AbortError" ||
    e.code === "ETIMEDOUT" ||
    e.code === "ECONNABORTED" ||
    /timed?\s?out|timeout/i.test(name + " " + msg)
  );
}

// ── FIREBASE ADMIN (kullanıcı doğrulama + sunucu taraflı kota) ──
// Modüler API: firebase-admin v13+ (+ pnpm/Node 24 require-ESM) ile namespace
// export (admin.credential) güvenilir değil; subpath import kullanıyoruz.
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require("firebase-admin/firestore");

initializeApp({
  credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const adminDb = getFirestore();

// ── ÇEVRİMİÇİ OYLAMA: sunucu tarafı zamanlı otomatik kapanış ──
// Host cihazı kapalı olsa bile closesAt dolan açık odaları sunucu kapatır.
// Bu, client _finalizeClose (live-index.html) tally mantığının BİREBİR portudur;
// yazılan alanlar client ile aynı olmalı ki showOnlineWinner kazanan kartını okuyabilsin.
// Admin SDK Firestore kurallarını bypass eder (delete:false engel değil).
async function autoCloseExpiredRooms() {
  try {
    const now = Date.now();
    // ⚠️ KOTA DERSİ (17 Tem): burada eskiden SADECE status=="open" filtresi vardı ve
    // closesAt JS'te süzülüyordu → süresi dolmamış VE closesAt'ı olmayan ("süresiz")
    // odalar da her turda OKUNUYORDU. Odalar hiç silinmediği için süresiz odalar
    // sonsuza kadar status:"open" kalıp her dakika tekrar okundu → 1440 tur/gün ×
    // ~35 oda ≈ 50K okuma = Firebase Spark günlük tavanı doldu, Firestore komple
    // durdu (giriş/geçmiş/AI/oda hepsi bozuldu). ASLA tüm koleksiyonu tarama.
    // Artık kapanma vakti GELMİŞ odaları Firestore'un kendisi süzüyor:
    // closesAt alanı OLMAYAN odalar bu sorguya hiç girmez (indekslenmez) → okunmaz.
    // Boşta okuma maliyeti = 0. Composite index gerekir (firestore.indexes.json).
    const snap = await adminDb
      .collection("rooms")
      .where("status", "==", "open")
      .where("closesAt", "<=", now)
      .orderBy("closesAt")
      .limit(50) // tur başına tavan; kalanları bir sonraki tur alır
      .get();
    for (const docSnap of snap.docs) {
      await adminDb.runTransaction(async (tx) => {
        const fresh = await tx.get(docSnap.ref);
        if (!fresh.exists) return;
        const data = fresh.data();
        if (data.status !== "open") return; // host/başkası bu arada kapatmış
        if (!data.closesAt || data.closesAt > Date.now()) return; // süre uzamış/temizlenmiş
        // === TALLY (client _finalizeClose ile AYNI) ===
        const parts = data.participants || {};
        const options = data.options || [];
        const voterCount = Object.values(parts).filter(
          (p) => p && p.submitted === true,
        ).length;
        // Hiç oy yok → client'la aynı: beraberlik + tüm seçenekler tieItems.
        if (voterCount === 0) {
          tx.update(docSnap.ref, {
            status: "tied",
            tieItems: options,
            closedBy: "server",
            closedAt: Date.now(),
          });
          return;
        }
        // Sadece "submitted" katılımcıların oylarını topla (client mantığı birebir).
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
        const winners = sorted
          .filter((x) => x[1] === topScore)
          .map((x) => x[0]);
        // Beraberlik → client normalde tiebreaker çarkı açar; host offline olduğu için
        // SUNUCU adil RASTGELE bir kazanan seçip KESİN sonuç (status:"closed") yazar.
        const winner = winners[Math.floor(Math.random() * winners.length)];
        tx.update(docSnap.ref, {
          status: "closed",
          winner: winner,
          winnerPoints: topScore,
          winnerVoters: voterCount,
          tieItems: [],
          closedBy: "server",
          closedAt: Date.now(),
        });
      });
    }
  } catch (e) {
    // Index yoksa Firestore FAILED_PRECONDITION + oluşturma linki döner. Sorgu hiç
    // çalışmadığı için OKUMA da yapmaz (güvenli başarısızlık: kota yanmaz).
    if (String(e.code) === "9" || /FAILED_PRECONDITION|index/i.test(e.message)) {
      console.error(
        "autoCloseExpiredRooms: composite index EKSİK (rooms: status ASC, closesAt ASC).",
        "Sunucu yedek kapanışı devre dışı — client deadlineClose çalışmaya devam ediyor.",
        "Firebase'in verdiği link ile index'i oluştur:",
        e.message,
      );
      return;
    }
    console.error("autoCloseExpiredRooms:", e.message);
  }
}
// ⚠️ 5 DAKİKA (eskiden 60sn). Süre-dolunca-kapanışın ASIL çözümü client tarafındaki
// deadlineClose (açık olan herhangi bir katılımcı kapatır); bu interval yalnız
// KİMSE açık değilken devreye giren yedek katman → sık dönmesi gereksiz.
setInterval(autoCloseExpiredRooms, 5 * 60 * 1000);
setTimeout(autoCloseExpiredRooms, 8000); // başlangıçta birikmiş süresi dolmuş odaları da kapat

// Günlük Merci mesaj limitleri (kullanıcı başına). Abuse/maliyet tavanı.
// MODEL (22 Tem): Pro OLMAYAN için ücretsiz günlük hak YOK — client'ta ödüllü reklam
// başına 4 mesaj (FREE_MSG_PER_DAY=0, AD_MSG_BONUS=4). Bu 60 sadece abuse tavanı
// (çok reklam izleyen için ~15 reklam/gün); reklam sonrası soru cevapsız kalmasın diye yüksek.
// Pro: UI'da "günde 50 mesaj" olarak sunulur; 300 abuse tavanı (Pro asla 50'de kesilmez, hep üzerinde).
const FREE_DAILY_LIMIT = 60;
const PRO_DAILY_LIMIT = 300;

// ── PRO GEÇERLİLİK ──
// isPro:true TEK BAŞINA yeterli değil: RC 'EXPIRATION' webhook'u kaçarsa bayrak
// sonsuza kadar true kalır. proExpiresAt ile çapraz doğrula.
// Alan yoksa/null ise (webhook öncesi eski kayıtlar, ömür boyu/tek seferlik ürün)
// isPro'ya güvenilir → mevcut PRO'lar bu değişiklikle kilitlenmez.
function isProValid(d) {
  if (!d || d.isPro !== true) return false;
  const exp = d.proExpiresAt;
  if (!exp) return true;
  try {
    const ms = typeof exp.toMillis === "function" ? exp.toMillis() : Number(exp);
    if (!Number.isFinite(ms)) return true;
    return ms > Date.now();
  } catch (e) {
    return true;
  }
}

// ── RATE LIMITING ──
// IP başına dakikada max 15 istek
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  // ── SUNUCU-İÇİ ÇAĞRI MUAFİYETİ (2 AĞU, tool use ile geldi) ──
  // /merci'nin `mekan_ara` aracı kendi sunucusundaki /nearby'yi çağırıyor. Bu
  // çağrılar 127.0.0.1'den geldiği için HEPSİ TEK IP kovasını paylaşırdı → dakikada
  // 15 mekan aramasından sonra TÜM kullanıcılar için iç çağrılar 429 yemeye başlardı.
  // Muafiyet, açılışta üretilen rastgele bir token'a bağlı: token süreçten hiç
  // çıkmadığı için dışarıdan tahmin edilip gönderilemez (düz bir "internal: 1"
  // başlığı olsaydı herkes rate-limit'i atlayabilirdi).
  // ⚠️ Bu YALNIZ IP rate-limit'ini atlar. /nearby'nin kendi Bearer doğrulaması ve
  // günlük locUsage kotası AYNEN çalışmaya devam eder.
  if (
    KM_INTERNAL_TOKEN &&
    req.headers["x-km-internal"] === KM_INTERNAL_TOKEN
  ) {
    return next();
  }
  // X-Forwarded-For: İLK değer client tarafından spoof edilebilir (her istekte
  // farklı yazıp rate-limit'i atlar). Proxy'nin eklediği SON (en güvenilir) değeri al.
  const xff = req.headers["x-forwarded-for"];
  const ip =
    (xff ? xff.split(",").pop().trim() : null) ||
    req.socket.remoteAddress ||
    "unknown";
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 dakika
  const maxRequests = 15;

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return next();
  }

  const data = rateLimitMap.get(ip);
  if (now - data.start > windowMs) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return next();
  }

  if (data.count >= maxRequests) {
    return res
      .status(429)
      .json({ error: "Çok fazla istek gönderdin, biraz bekle! 🐙" });
  }

  data.count++;
  return next();
}

// Haritayı her 5 dakikada temizle (bellek sızıntısı engellemek için)
setInterval(
  () => {
    const now = Date.now();
    for (const [ip, data] of rateLimitMap.entries()) {
      if (now - data.start > 5 * 60 * 1000) rateLimitMap.delete(ip);
    }
  },
  5 * 60 * 1000,
);

// ── KULLANICI DOĞRULAMA + GÜNLÜK KOTA ──
// Her /merci isteğinde Firebase ID token ister, uid çıkarır, isPro'ya göre
// günlük sayacı Firestore'da (transaction ile) artırır; limit aşılırsa 429 döner.
// ⚠️ 17 Tem DERSİ — CATCH'İ AYRI TUT: eskiden tek bir try/catch hem verifyIdToken'ı
// hem users get'ini hem aiUsage transaction'ını sarıyordu ve HER hatada
// "Oturum doğrulanamadı, tekrar giriş yap." dönüyordu. Firebase Spark okuma kotası
// dolunca (Firestore komple durdu) oturum TAMAMEN sağlamken kullanıcıya "tekrar giriş
// yap" dedirtti; kullanıcı boşuna çıkış/giriş yaptı, sorun çözülmedi ve teşhis saatler
// aldı. ARTIK: token hatası = 401 "giriş yap"; altyapı (Firestore) hatası = 503
// "sonra tekrar dene" — giriş yapmak onu ÇÖZMEZ, o yüzden ÖNERME.
async function authAndQuota(req, res, next) {
  // ── 1) KİMLİK (yalnız gerçek token hatası buraya düşer) ──
  let uid;
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return res
        .status(401)
        .json({ error: "Merci'ye danışmak için giriş yap." });
    }

    const decoded = await getAuth().verifyIdToken(token);
    uid = decoded.uid;

    // Anonim oturumlar AI uçlarını KULLANAMAZ: signInAnonymously sınırsız taze kimlik
    // üretir → her biri için yeni kota = maliyet/abuse. Anonim auth yalnız oda yazımı
    // içindir; AI için Google girişi şart.
    if (decoded.firebase && decoded.firebase.sign_in_provider === "anonymous") {
      return res
        .status(401)
        .json({ error: "Merci'ye danışmak için Google ile giriş yap." });
    }
  } catch (e) {
    console.error("AUTH FAIL (token geçersiz/süresi dolmuş):", e.message);
    return res
      .status(401)
      .json({ error: "Oturum doğrulanamadı, tekrar giriş yap." });
  }

  // ── 2) FIRESTORE OKUMA + KOTA (altyapı hatası ≠ oturum hatası) ──
  let allowed;
  try {
    // ── BAN: kötüye kullanan hesap AI uçlarını KULLANAMAZ ──
    // Kota/isPro'dan ÖNCE bakılır → PREMIUM/ÖDEME FARK ETMEZ, banlı hesap geçemez.
    // Yönetim paneli bans/{uid} yazınca burada 403 döner. (Ban kaldırınca doc silinir.)
    const banSnap = await adminDb.collection("bans").doc(uid).get();
    if (banSnap.exists) {
      const b = banSnap.data() || {};
      return res.status(403).json({
        error: b.reason
          ? "Merci erişimin kısıtlandı: " + b.reason
          : "Bu hesabın Merci erişimi kısıtlandı.",
      });
    }

    const userSnap = await adminDb.collection("users").doc(uid).get();
    const isPro = userSnap.exists && isProValid(userSnap.data());
    const limit = isPro ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT;

    const today = new Date().toISOString().slice(0, 10); // UTC günü (YYYY-MM-DD)
    const usageRef = adminDb.collection("aiUsage").doc(`${uid}_${today}`);

    allowed = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(usageRef);
      const count = snap.exists ? snap.data().count || 0 : 0;
      if (count >= limit) return false;
      tx.set(
        usageRef,
        {
          uid,
          date: today,
          count: count + 1,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return true;
    });
  } catch (e) {
    // Ağ / kota tavanı / izin / gecikme → oturum SAĞLAM, altyapı geçici bozuk.
    console.error(
      "INFRA FAIL (Firestore users/aiUsage — kota tavanı? ağ? izin?):",
      e.code || "",
      e.message,
    );
    return res
      .status(503)
      .json({ error: "Şu an sana bağlanamadım, biraz sonra tekrar dene 🐙" });
  }

  // Kota AŞIMI meşru bir REDDİR (altyapı hatası değil) → 429 aynen korunur.
  if (!allowed) {
    return res
      .status(429)
      .json({ error: "Günlük Merci hakkın doldu!", limitReached: true });
  }

  req.uid = uid;
  next();
}

app.post("/merci", rateLimit, authAndQuota, async (req, res) => {
  try {
    const { messages, groupCount, history, location, resultContext } = req.body;
    // Tool use için koordinat gerekir: eski tasarımda konum SADECE client'tan
    // /nearby'ye gidiyordu, /merci yalnız yer ADINI ("Kadıköy") biliyordu. Artık
    // arama sunucu içinde yapıldığı için client lat/lng'yi buraya da gönderiyor.
    // Yoksa (eski client / konum kapalı) araç devre dışı kalır, eski işaret yolu çalışır.
    const _lat = parseFloat(req.body && req.body.lat);
    const _lng = parseFloat(req.body && req.body.lng);
    const hasGeo = isFinite(_lat) && isFinite(_lng);

    // ── GİRDİ DOĞRULAMA (maliyet/abuse koruması) ──
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Geçersiz istek." });
    }
    if (messages.length > 40 || JSON.stringify(messages).length > 20000) {
      return res
        .status(400)
        .json({ error: "Konuşma çok uzun, yeni bir konu başlat." });
    }

    // ── GEÇMİŞ ANALİZİ ──
    let historyContext = "";
    if (history && history.length > 0) {
      const counts = {};
      const modes = {};
      history.forEach((h) => {
        counts[h.item] = (counts[h.item] || 0) + 1;
        if (h.mode) modes[h.mode] = (modes[h.mode] || 0) + 1;
      });
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const top = sorted[0];
      const recentItems = history
        .slice(0, 5)
        .map((h) => `"${h.item}"`)
        .join(", ");

      if (top && top[1] >= 2) {
        const tied = sorted.filter(([, n]) => n === top[1]);
        if (tied.length >= 2) {
          const names = tied.map(([name]) => `"${name}"`).join(" ve ");
          historyContext = `\nKİŞİLİK ANALİZİ: Bu grup geçmişte en çok ${names} seçti (her biri ${top[1]} kez). Son kararları: ${recentItems}. Bu kalıbı yorum ve önerilerine doğal yansıt — örn. pizza severler için farklı pizzacı öner, korku severler için yeni bir film öner.`;
        } else {
          historyContext = `\nKİŞİLİK ANALİZİ: Bu grup geçmişte "${top[0]}" seçeneğini ${top[1]} kez tercih etti. Son kararları: ${recentItems}. Bu tercihi yorum ve önerilerine doğal yansıt.`;
        }
      } else if (history.length >= 3) {
        historyContext = `\nGEÇMİŞ KARARLAR: Son seçimler: ${recentItems}. Bu çeşitliliği göz önünde bulundur.`;
      }
    }

    // ── KONUM ── (konum artık sohbette ONAY ile alınır; işaret koyup butonla iste)
    // İŞARET FORMATI: eski anlatımdaki "TUR" yer tutucusunu model LİTERAL sanıp
    // "[[NEED_LOCATION:TUR:bar]]" gibi bozuk işaret üretti (canlı bug, 13 Tem) →
    // artık birebir örnekle anlatılıyor; "TUR" kelimesi prompt'ta GEÇMİYOR.
    const locationContext = location
      ? `\nKONUM VAR: Kullanıcı ${location} içinde; konum hazır, tekrar konum/şehir/semt İSTEME. Kullanıcı yakında yer sorarsa ("nereye gidelim / dışarı çıkalım / yiyelim / içelim / bar / kahve / tatlı" vb.) YA DA mekan gelmedi diye takılırsa ("hani / nerede / ee?") YA DA önerilenleri beğenmeyip başkasını isterse ("beğenmedim / başka öner / farklı yerler / başkası yok mu / bunlar olmadı"), cevabının EN BAŞINA şu biçimde bir işaret koy: [[NEARBY:bar]] — iki nokta sonrasına SADECE şu kelimelerden BİRİNİ yaz: food, cafe, dessert, bar, activity (emin değilsen activity; başka kelime ya da ikinci iki nokta YOK). ÖNEMLİ: bar = YALNIZ bira/kokteyl/gece kulübü içindir. Rakı, meyhane, balık, meze, "rakı balık", "meyhaneye gidelim" gibi istekler bar DEĞİL food'dur (meyhane/balık lokantası oturmalı restorandır) → bunlarda [[NEARBY:food]] kullan, ASLA [[NEARBY:bar]] yazma. Örnek cevap: "[[NEARBY:bar]] En yakınları çıkarıyorum 👇". İşaretten sonra TEK kısa olumlu cümle yaz. Bu işaret gerçek mekanları (isim, mesafe) otomatik getirir; komşu semtten gelebilir, sorun değil. MEKAN DÜRÜSTLÜĞÜ: önerdiğin mekanların menü/içki/fiyat bilgisine sahip DEĞİLSİN ve mekan kartlarında da bu YAZMAZ (kartta sadece isim + "yol tarifi" butonu var). "Kartlarda yazıyor", "listesinde görürsün", "menüde var" DEME; bir mekânda belirli bir şeyin (rakı, spesifik yemek) olduğunu GARANTİ ETME ("kesin vardır" YOK). Dürüst ol: "meyhane/balık lokantası olduğu için genelde bulunur, emin olmak istersen mekânı arayabilirsin" gibi. Sadece sohbet/yorumsa işaret KOYMA.`
      : `\nKONUM YOK: Uygulama konumu otomatik alabiliyor — kullanıcıya ŞEHİR/SEMT/KONUM SORMA. Kullanıcı yakında yer sorarsa YA DA bir yere gitmek istediğini söylerse ("rakıya gidiyoruz", "kahve içelim" gibi), soru sormadan cevabının EN BAŞINA şu biçimde bir işaret koy: [[NEED_LOCATION:bar]] — iki nokta sonrasına SADECE şu kelimelerden BİRİNİ yaz: food, cafe, dessert, bar, activity (başka kelime ya da ikinci iki nokta YOK). ÖNEMLİ: bar = YALNIZ bira/kokteyl/gece kulübü içindir. Rakı, meyhane, balık, meze, "rakı balık", "rakıya gidiyoruz" gibi istekler bar DEĞİL food'dur (meyhane/balık lokantası oturmalı restorandır) → bunlarda [[NEED_LOCATION:food]] kullan, ASLA [[NEED_LOCATION:bar]] yazma. Örnek cevap: "[[NEED_LOCATION:bar]] Yakınındakilere bakıyorum 👇". Tek istisna: kullanıcı zaten şehir/semt yazdıysa işaret KOYMA, o bölgeye göre öner.`;

    // ── SONUÇ BAĞLAMI (Merci'ye Sor'dan geliyorsa) ──
    let resultPrompt = "";
    if (resultContext) {
      const { winner, mode, scores, peopleCount } = resultContext;
      if (mode === "wheel") {
        resultPrompt = `\nÖNEMLİ: Kullanıcı çarkı çevirdi ve "${winner}" çıktı. Bu sonucu esprili ve kişiselleştirilmiş şekilde yorum yap. Eğer tanınan bir şeyse (film, yemek, aktivite), onunla ilgili eğlenceli bir referans veya espri yap. Sonra ne yapabilecekleri hakkında pratik öneri ver.`;
      } else if (mode === "masa") {
        const scoreStr = scores
          ? Object.entries(scores)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `${k}: ${v} puan`)
              .join(", ")
          : "";
        resultPrompt = `\nÖNEMLİ: ${peopleCount || ""} kişilik masa oylaması bitti, kazanan: "${winner}". ${scoreStr ? `Sonuçlar: ${scoreStr}.` : ""} Masa oylamasına özel yorum yap — grubu tebrik et, yarışma hakkında esprili bir şey söyle ve kazanan kararı uygulamak için pratik öneri ver.`;
      } else if (mode === "online") {
        const scoreStr = scores
          ? Object.entries(scores)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `${k}: ${v} puan`)
              .join(", ")
          : "";
        resultPrompt = `\nÖNEMLİ: Online oylama bitti, kazanan: "${winner}". ${scoreStr ? `Sonuçlar: ${scoreStr}.` : ""} Online oylamaya özel yorum yap — katılımcıları tebrik et, demokratik karar sürecini esprili şekilde değerlendir ve kazanan kararı uygulamak için öneri ver.`;
      }
    }

    // ── ÖZEL SEÇİM YORUMU (kazanan seçeneğe göre espri) ──
    const winnerEspriPrompt = resultContext?.winner
      ? `
ÖZEL YORUM KURALI: Eğer kazanan "${resultContext.winner}" tanınmış bir şeyse (film, dizi, yemek, aktivite, mekan vb.), mutlaka ona özgü esprili bir referans yap:
- LOTR/Yüzüklerin Efendisi → "Dost ve öyle gir!" veya "TO THE KING!!!"
- Pizza → pizza dilimi emojisi veya İtalyan espri
- Korku filmi → "Işıkları kapatın!"
- Sushi → "Chopstick hazır mı?"
- Karaoke → "Mikrofonu kapın!"
- Bowling → "Strike!"
Tanımıyorsan normal yorum yap. Espriyi kısa tut, 1 cümle.`
      : "";

    // ── KONUM DÜZELTME İŞARETİ ──
    // Otomatik (GPS/reverse-geocode) konum yanlış çıkabiliyor (canlı bug: kullanıcı
    // Ümraniye'deyken sistem "Tuzla" dedi). Kullanıcı YAZIYLA doğru semti/şehri
    // verirse model [[SETLOC:Yer]] işareti koyar; sunucu bunu forward-geocode edip
    // (Nominatim) yeni koordinatı client'a döner, client konumu günceller.
    const setLocHint = `\nKONUM DÜZELTME: Kullanıcı bulunduğu yeri YAZIYLA söyler ya da düzeltirse (örn. "ben Ümraniye'deyim", "yok Kadıköy'deyim", "konumum yanlış, Beşiktaş'tayım"), cevabının EN BAŞINA [[SETLOC:YerAdı]] işareti koy — köşeli parantez içine SADECE o semt/şehir adını yaz (tek yer, ilçe+şehir olabilir: "Ümraniye, İstanbul"). Böylece konum oraya güncellenir. Sonra normal cevabını ver; kullanıcı yakında yer de soruyorsa ayrıca uygun [[NEARBY:tür]] işaretini de ekle. DİKKAT: bu işaret SADECE kullanıcının KENDİ bulunduğu konum içindir; sohbette geçen rastgele/anı yer adı ("geçen yıl Bodrum'a gittik") bunu TETİKLEMEZ.`;

    // ── ZAMAN FARKINDALIĞI (canlı bug: Merci "saati bilmiyorum" diyordu) ──
    // Türkiye saati = UTC+3 (2016'dan beri yaz saati YOK, sabit). ICU/locale'e
    // bağımlı olmasın diye gün/ay adlarını elle diziden veriyoruz.
    const _trNow = new Date(Date.now() + 3 * 3600 * 1000);
    const _gunler = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
    const _aylar = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
    const _saat = String(_trNow.getUTCHours()).padStart(2, "0") + ":" + String(_trNow.getUTCMinutes()).padStart(2, "0");
    const timeContext = `\nŞU AN (Türkiye saati): ${_gunler[_trNow.getUTCDay()]}, ${_trNow.getUTCDate()} ${_aylar[_trNow.getUTCMonth()]} ${_trNow.getUTCFullYear()}, saat ${_saat}. Kullanıcı saat/gün/tarih sorarsa bunu söyle — "bilmiyorum" DEME. Önerilerini de saate göre ayarla (sabah kahvaltı/kahve, öğlen öğle yemeği, akşam yemek/aktivite, gece geç saate uygun). Ama her cevaba saat yazma — sadece konuyla ilgiliyse.`;

    const systemPrompt = `Sen Merci — mor, sevimli ama keskin zekâlı bir karar-ahtapotu. İnsanların kararsızlığını bitirmek senin işin ve bundan keyif alıyorsun. Uygulamanın yıldızı sensin, sıkıcı bir asistan değil.

TARZIN:
- Kendinden emin, hafif ukala, esprili, sıcak. Net konuş, lafı dolandırma. Karar vermekten korkma — bir tarafı seç ve nedenini tek cümlede söyle.
- Doğal günlük Türkçe. Her zaman samimi tekil "sen" diliyle konuş (geçersen, ne dersin, oraya git) — grup kararı olsa bile. Aynı mesajda sen↔siz karıştırma.
- KISA ve NET: 1-3 cümle, en fazla 2 emoji. Karar-ahtapotusun — "hmmm, ne istediğini bilmeden nasıl karar veririm" gibi KARARSIZ/uzun/geveleyen girişler YASAK. Ya net bir öneri ver ya da TEK kısa soruyla daralt.
- YAZIM DOĞRU olsun: Türkçe dilbilgisi/imla hatasız yaz. Örn "karar vereyim / edeyim / gideyim / bakayım" (verim/edim/gidim/bakim YANLIŞ). "değil mi", "bir şey" ayrı; "yalnızca" doğru. Bozuk/yarım kelime yok. SORU EKİ ÜNLÜ UYUMU (mı/mi/mu/mü) — kelimenin SON ünlüsüne uy: kalın ünlü (a, ı, o, u) → "mı/mu"; ince ünlü (e, i, ö, ü) → "mi/mü". Örn "Yabancı mı" (mi DEĞİL!), "film mi", "gol mü", "sushi mi", "burger mı". Soru eki HER ZAMAN ayrı yazılır ve kesme işareti almaz ("Knives Out mu"). Yabancı film/marka adında soru ekini adın Türkçe okunuşundaki son sese göre seç. Özel ada gelen İSİM eki ise kesmeyle ayrılır ("Kadıköy'de", "Knives Out'u").${groupCount > 0 ? `\n- Grup ${groupCount > 6 ? "6+" : groupCount} kişilik — buna göre öner.` : ""}

İYİ CEVAP (net karar ver — çoğu soruda BÖYLE yap, seçenek/çark çıkarma):
K: "bu akşam film mi dizi mi izlesem" → S: "Film. Tek oturuşta biter, yarım kalma derdi olmaz 🎬 Tür söyle, sana birini seçeyim."
İYİ CEVAP (SADECE kullanıcı gerçekten kararsızsa daralt):
K: "akşam yemeği ne yesek, hiç fikrim yok, 4 kişiyiz" → S: "O zaman daraltalım 🍽️ [[SECENEKLER: Kebap | İtalyan | Balık | Burger]]"
KÖTÜ (ASLA): "hmmm, akşam yemeği heyecanı! ama ne istediğini bilmeden nasıl karar verim?" (yazım hatası + kararsız + gereksiz uzun)

NE YAPARSIN:
- Sadece karar konularında yardım et: nereye gidilsin, ne yenilsin/izlensin/yapılsın, kime ne hediye alınsın.
- Alakasız soruda (genel bilgi, matematik, kod) nazikçe geçiştir: "Ben karar kollarımı onun için sallamıyorum 🐙 Ama bir ikilemin varsa anlat, çözeriz!"
- ÇARK/OYLAMA = SON ÇARE, sık DEĞİL: Öncelik HER ZAMAN senin net önerin — çoğu soruda bir tarafı seç ve nedenini söyle. Çarka/oylamaya yönlendirmeyi SADECE gerçekten gerekince yap: kullanıcı açıkça "bilmiyorum / fark etmez / bir türlü karar veremiyorum" derse VEYA seçenekler gerçekten başa baş kilitlendiyse. Her cevaba "çevir bakalım / oylamaya alalım" EKLEME — bu bunaltıcı olur, arada bir kullan. Uygun olduğunda çark: "Kaderine bırak — çevir bakalım! 🎡"; büyük grup + gerçek anlaşmazlık: "Bunu kalabalık çözer, oylamaya alalım 📊".
- ⚠️ ÇARKA YÖNLENDİRİRKEN SEÇENEKLERİ MUTLAKA YÜKLE: Kullanıcı kendi verdiği 2+ somut seçenek arasında kararsızsa ("X mi Y mi", "ikisi arasında kaldım", "kararsız kaldım", "seç işte") ve sen de net seçmiyorsan, "çevir bakalım" derken O SEÇENEKLERİ aynı cevaba [[SECENEKLER: X | Y]] olarak KOY — böylece çark otomatik dolar, kullanıcı elle seçenek girmek zorunda kalmaz. Kullanıcının söylediği filmleri/yerleri/isimleri aynen kullan (ör. iki film: [[SECENEKLER: Cebimdeki Yabancı | Knives Out]]). BOŞ çarka "çevir bakalım" ASLA deme — çarkta seçenek yoksa "çevir bakalım" demek anlamsız olur.
- Kısıt gelince ("2 kişiyiz", "arabam yok", "bütçe az") soru sormadan DİREKT uygun alternatif öner. Eksik bilgi varsa en fazla 1 netleştirme sorusu sor — peş peşe soru yağdırma.
${timeContext}${historyContext}${locationContext}${setLocHint}${resultPrompt}${winnerEspriPrompt}

SEÇENEK BUTONU (ÖLÇÜLÜ kullan, SIK DEĞİL): Önce SENİN net önerin gelir. İşareti SADECE şu iki durumda koy: (1) kullanıcıya gerçekten bir set arasından seçtiriyorsan (net tek cevabın YOK, 2+ somut kategori sunuyorsun) VEYA (2) kullanıcı açıkça "sen seç / çevir / oylayalım / karar veremiyorum" dediyse. Net tek önerin varsa [[SECENEKLER]] KOYMA — refleks olarak her cevaba seçenek listesi EKLEME. Koyacaksan cevabının EN SONUNA [[SECENEKLER: ad1 | ad2 | ad3]] ekle (2-8 kısa isim, | ile ayır). Örn (yalnız gerçekten kararsızsa): "Hiç fikrin yoksa daraltalım 👇 [[SECENEKLER: Korku | Komedi | Aksiyon]]". Tek kesin öneride işaret KOYMA. DİKKAT: SECENEKLER soyut KATEGORİ/tür içindir (Pizza, Korku filmi, Kafe) — GERÇEK MEKAN İSMİ (Domino's, Big Chefs) ASLA yazma; [[NEARBY]] koyduğun mekan cevaplarında SECENEKLER'e mekan/işletme adı KOYMA.

KIRMIZI ÇİZGİLER:
- UYDURMA YASAK: Mekan ismi, telefon, semt/ilçe/cadde adı ya da mesafe ASLA uydurma. Gerçek mekan listesi kullanıcıya ayrı kartlarla gösterilir. Bir yeri nerede/ne kadar uzakta bulacağını sadece [[NEARBY]] işaretinin getirdiği gerçek kartlar söyler; sen metinde spesifik yer/mesafe yazma, "başka semte git" deme. "Burada yok / kültürü gelişmemiş" gibi kesin olumsuz hüküm verme — mevcudiyeti kartlar belirler.
- MEKAN CEVABINDA KATI KISIT: [[NEARBY]] işareti koyduğun her cevapta SADECE TEK kısa cümle yaz (ör. "En yakınları çıkarıyorum 👇"). ŞUNLAR KESİN YASAK: (1) kendi kafandan mekan İSMİ/zincir adı (Domino's, Big Chefs, Komagene, "X Dönercisi"); (2) yan tür/yemek listesi saymak (kokoreç, kebap, çiğköfte, büfe, tatlıcı...); (3) [[NEARBY]] ile AYNI cevaba [[SECENEKLER]] koymak — mekan cevabında SECENEKLER YOK, gerçek yerleri yalnızca kartlar getirir. İsim/tür sıralaması yaparsan YANLIŞ olur (alakasız yer sayarsın). Sadece işaret + tek cümle.
- SPESİFİĞE SADIK KAL: Kullanıcı spesifik istedi mi tam ona uy. "Tavuk döner" → kebap/kokoreç/çiğköfte DEĞİL. "Sushi" → başka mutfak DEĞİL. "Şarap / oturmalı / akşam yemeği" → fast-food, büfe, pizza-zinciri (Domino's) DEĞİL, oturmalı restoran. İstenen türe UYMAYAN bir yeri o türmüş gibi önerme; tam onu bulamıyorsan alternatifleri kartlar zaten "en yakın seçenekler" olarak getirir, sen alakasız türü İSTENEN ŞEYMİŞ gibi sunma. Emin değilsen ÖNERME — dürüst ol.
- İÇ İŞLEYİŞ GİZLİ: sistem, harita, GPS, API, sunucu, arkaplan, entegrasyon, "mekan kartı çekemiyorum", "yükleyemedim" gibi teknik/iç-işleyiş ifadeleri ASLA kullanma. Mekan gelmediğinde bahane uydurma; kısa ve neşeli kal ("Hemen tekrar bakıyorum 👇") ve uygun [[NEARBY:tür]] işaretini koy.
- ALKOL/KUMAR — TEŞVİK YOK: Kumar/bahis'e yönlendirme KESİNLİKLE yasak (uygulama konsepti dışı). Alkol: mekan önerebilirsin ama İÇME kararını SEN verme/özendirme. "Bira mı rakı mı içeyim", "kaç kadeh atayım" gibi içki-tüketim sorularında taraf tutma; nazikçe geç: "İçkini sana bırakıyorum 🐙 — ama nereye gidelim / ne yiyelim dersen hemen yardımcıyım." Kullanıcının yaşını doğrulayamadığımız için kimseyi alkole/kumara/tütüne teşvik etme; sarhoş olmayı veya aşırı içmeyi ASLA önerme.
- Yapay AI girişleri yok ("Tabii ki!", "Harika bir soru!", "ben yapay zekayım"). Aynı soruyu iki kez sorma. Konum varsa tekrar şehir/semt/konum isteme.`;

    // Araç YALNIZ bayrak açıkken VE koordinat varken verilir. Koordinat yoksa
    // (konum kapalı / eski client) araç listesi hiç gönderilmez → model eski
    // [[NEED_LOCATION]] işaret yolunu kullanır, davranış bugünküyle birebir aynı kalır.
    const useTools = KM_TOOL_USE && hasGeo;
    const baseReq = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      temperature: 0.5, // karar-asistanı → tutarlılık öncelik; persona sıcaklığı korunur (renk azalırsa 0.6)
      system: systemPrompt,
      messages: messages,
    };
    if (useTools) baseReq.tools = [MEKAN_ARA_TOOL];

    let response = await anthropic.messages.create(baseReq, {
      timeout: ANTHROPIC_TIMEOUT_MAIN, // yanıt gelmezse asılı kalma → 504 (aşağıda)
    });

    // ── ARAÇ DÖNGÜSÜ ──────────────────────────────────────────────────────
    // ⚠️ 2 AĞU — DÜZELTİLEN BUG ("kokoreç" canlı hatası): burası eskiden TEK
    // SEFERLİK bir `if` idi. Model ilk aramanın sonucunu alakasız bulup aracı
    // İKİNCİ kez çağırınca (ki bu DOĞRU davranış) ikinci yanıt da tool_use olup
    // metin içermiyordu → `text` boş → kullanıcı "Bir şeyler ters gitti, tekrar
    // dene!" görüyor, ama ilk aramanın kartları yine basıldığı için ekranda
    // "hata + alakasız mekanlar" çıkıyordu. Artık gerçek döngü: model bitirene
    // (stop_reason !== "tool_use") kadar dönüyor, üst sınır MAX_TOOL_TURN.
    const MAX_TOOL_TURN = 3; // 1 ilk çağrı + en fazla 3 araç turu
    // ⚠️ İKİ AYRI BİLGİ, KARIŞTIRMA:
    //   toolRan    = araç ÇALIŞTI mı (bulsun bulmasın) → emniyet ağı guard'ı
    //   toolPlaces = son BAŞARILI aramanın mekanları  → client'a giden kartlar
    // Tek değişkene indirilirse: araç çalışıp hiçbir şey bulamadığında toolPlaces
    // null kalır, emniyet ağı "araç hiç çalışmadı" sanıp işaret enjekte eder ve
    // client İKİNCİ bir /nearby araması tetikler (çift kota + çift kart).
    let toolRan = false;
    let toolPlaces = null;
    if (useTools) {
      let convo = messages.slice();
      let tur = 0;
      while (response.stop_reason === "tool_use" && tur < MAX_TOOL_TURN) {
        tur++;
        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== "tool_use" || block.name !== "mekan_ara") continue;
          const inp = block.input || {};
          let payload;
          try {
            const found = await callNearbyInternal({
              lat: _lat,
              lng: _lng,
              type: inp.tur || "food",
              query: inp.arama || "",
              auth: req.headers.authorization || "",
              // Modelin ürettiği OSM ipuçları (aşağıdaki şema notuna bak)
              osmCuisine: inp.osm_cuisine || "",
              osmShop: inp.osm_shop || "",
              osmIsim: inp.osm_isim || "",
            });
            const bulunan = Array.isArray(found.places) ? found.places : [];
            // Kartları SON BAŞARILI aramadan al; boş tur öncekini silmesin.
            if (bulunan.length) toolPlaces = bulunan;
            payload = bulunan.length
              ? "Bulunan GERÇEK mekanlar (bu kartlar kullanıcıya da gösterilecek):\n" +
                bulunan
                  .slice(0, 6)
                  .map((p) => `- ${p.name} | ${p.dist} m`)
                  .join("\n") +
                (found.broadened
                  ? "\n\nUYARI: Tam olarak istenen tür bulunamadı; bunlar en yakın " +
                    "ALTERNATİFLER. Kullanıcıya bunu dürüstçe söyle, istediği şeymiş gibi sunma."
                  : "") +
                "\n\nBu listedekiler DIŞINDA mekan/semt/mesafe uydurma. Menü, fiyat, içki " +
                "bilgisi sende YOK — bir mekânda belirli bir şeyin olduğunu garanti etme."
              : "Hiç mekan bulunamadı." +
                (tur < MAX_TOOL_TURN
                  ? " İSTERSEN bir kez daha dene: osm_cuisine/osm_shop/osm_isim " +
                    "ipuçlarını değiştir ya da tur'u genişlet. Denemek istemiyorsan " +
                    "kullanıcıya bulamadığını DÜRÜSTÇE söyle."
                  : " UYDURMA. Kullanıcıya kısaca bulamadığını söyle ve başka bir tür " +
                    "denemeyi ya da çarkı çevirmeyi öner.");
          } catch (e) {
            // Arama patlarsa sohbet ÖLMESİN: modele durumu bildir, kullanıcıya
            // teknik detay sızdırmadan neşeli bir cümle yazsın.
            console.error("mekan_ara araç hatası:", e.message);
            payload =
              "Arama şu an yapılamadı. Kullanıcıya kısa ve neşeli bir dille birazdan " +
              "tekrar denemesini söyle; sistem/teknik detay verme.";
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: payload,
          });
        }
        if (!toolResults.length) break; // tanımadığımız araç → döngüyü kilitleme
        toolRan = true; // araç gerçekten çalıştı (mekan bulmuş olması şart değil)
        convo = convo.concat([
          { role: "assistant", content: response.content },
          { role: "user", content: toolResults },
        ]);
        // Son turda aracı GERİ ÇEK → model mecburen metin yazar, sonsuz
        // araç-çağırma sarmalıyla boş cevap dönmesi imkânsız hale gelir.
        const sonTur = tur >= MAX_TOOL_TURN;
        const istek = { ...baseReq, messages: convo };
        if (sonTur) delete istek.tools;
        response = await anthropic.messages.create(istek, {
          timeout: ANTHROPIC_TIMEOUT_MAIN,
        });
      }
    }

    let text = "";
    response.content.forEach((block) => {
      if (block.type === "text") text += block.text;
    });

    // Türkçe-kesilme koruması: yanıt max_tokens limitine takılıp kesildiyse,
    // yarım kalan son cümleyi kırp (yoksa "anlaşılmıyor" hissi olur).
    // Model DEĞİŞMİYOR — sadece kesik çıktıyı zarifçe toparlıyoruz.
    if (response.stop_reason === "max_tokens" && text) {
      const trimmed = text.trimEnd();
      const lastStop = Math.max(
        trimmed.lastIndexOf("."),
        trimmed.lastIndexOf("!"),
        trimmed.lastIndexOf("?"),
        trimmed.lastIndexOf("…"),
      );
      // Son tam cümleye kadar kırp; hiç cümle sonu yoksa kibar devam ibaresi ekle.
      text = lastStop > 20 ? trimmed.slice(0, lastStop + 1) : trimmed + " …";
    }

    // ── KONUM DÜZELTME (SETLOC) → FORWARD-GEOCODE ──
    // Kullanıcı konumunu yazıyla verince model [[SETLOC:Yer]] koyar. İşareti
    // metinden HER durumda temizle (eski client bilmese de HAM sızmasın), sonra
    // yer adını Nominatim ile koordinata çevir; başarılıysa client'a döndür.
    let setLocation = null;
    const slMatch = text.match(/\[\[\s*SETLOC\s*:\s*([^\]]+?)\s*\]\]/i);
    text = text.replace(/\[\[\s*SETLOC\s*:[^\]]*\]\]/gi, "").trim();
    if (slMatch && slMatch[1]) {
      const place = slMatch[1].trim().slice(0, 60);
      if (place) {
        try {
          setLocation = await forwardGeocode(place, location);
        } catch (e) {
          console.error("SETLOC geocode error:", e.message);
        }
      }
    }

    // ── İŞARET NORMALİZASYONU (savunma hattı) ──
    // Model işaret biçimini yine de bozabilir (canlıda görüldü:
    // "[[NEED_LOCATION:TUR:bar]]"). Client regex'i tanıyamayınca işaret ekrana
    // HAM sızıyor ve mekan akışı hiç tetiklenmiyordu. Her varyantı yakala:
    // parantez içindeki SON geçerli türü çek, kanonik "[[NEED_LOCATION:bar]]"
    // biçimine indir; geçerli tür yoksa "food" varsay.
    const LOC_TYPES = ["food", "cafe", "dessert", "bar", "activity"];
    text = text.replace(
      /\[\[\s*(NEED_LOCATION|NEARBY)\b([^\]]*)\]\]/gi,
      (m, tag, rest) => {
        const toks = String(rest).toLowerCase().match(/[a-z]+/g) || [];
        let found = "food";
        for (const t of toks) if (LOC_TYPES.includes(t)) found = t;
        return `[[${tag.toUpperCase()}:${found}]]`;
      },
    );

    // ── VAAT VAR AMA İŞARET YOK → EMNİYET AĞI (2 AĞU) ──
    // CANLI BUG: model "Kadıköy'de en yakın simit satıcılarını çıkarıyorum 👇" yazdı
    // ama [[NEARBY:food]] işaretini KOYMADI → client hiçbir şey tetiklemedi → ekranda
    // sessizlik. Kullanıcı aynı soruyu TEKRAR sorunca bu sefer işareti koydu ve çalıştı.
    // Yani modelin SÖZ VERMESİ ile sistemin İŞ YAPMASI birbirinden kopuk; model işareti
    // unutabiliyor ve bu sessizce başarısız oluyor. Burada metni tarayıp "mekan
    // listeleyeceğim" vaadi varken işaret yoksa işareti BİZ ekliyoruz.
    //
    // NEDEN NEED_LOCATION (NEARBY değil): client NEED_LOCATION'da önce konum önbelleğine
    // bakar — konum VARSA doğrudan merciNearby() çağırır (NEARBY ile aynı sonuç), YOKSA
    // izin ister. Yani her iki durumda da doğru davranır; NEARBY ise konum yoksa boşa düşer.
    // ⚠️ toolPlaces !== null ise ARAÇ ZATEN ÇALIŞTI (mekan bulmuş ya da bulamamış
    // olabilir; her iki durumda da model cevabını buna göre yazdı). Emniyet ağı
    // burada işaret enjekte ederse client İKİNCİ bir /nearby araması tetikler →
    // çift kart, çift kota tüketimi. Bu yüzden araç turu olduysa ağ devre dışı.
    if (!toolRan && !/\[\[\s*(NEED_LOCATION|NEARBY)\s*:/i.test(text)) {
      const promisesLookup =
        /(bak[ıi]yorum|ç[ıi]kar[ıi]yorum|s[ıi]ral[ıi]yorum|listeliyorum|getiriyorum|buluyorum|tar[ıi]yorum)/i.test(
          text,
        );
      const aboutPlaces =
        /👇|yak[ıi]n|civar|etraf|mekan|mekân|yerler|sat[ıi]c[ıi]|restoran|lokanta|kafe/i.test(
          text,
        );
      if (promisesLookup && aboutPlaces) {
        // Tür tahmini: yalnız OSM bucket'ını seçer, yanlış tahmin sonucu bozmaz.
        let guess = "food";
        if (/kafe|cafe|kahve iç/i.test(text)) guess = "cafe";
        if (/tatl[ıi]|dondurma|pastane/i.test(text)) guess = "dessert";
        if (/\bbar\b|\bpub\b|bira|kokteyl/i.test(text)) guess = "bar";
        if (/aktivite|gezilecek|yap[ıi]lacak yer|park\b|sinema/i.test(text))
          guess = "activity";
        text += ` [[NEED_LOCATION:${guess}]]`;
        console.warn(
          "EMNİYET AĞI: model mekan vaat etti ama işaret koymadı → eklendi:",
          guess,
        );
      }
    }

    res.json({
      text: text || "Bir şeyler ters gitti, tekrar dene!",
      setLocation, // yazıyla verilen konumun koordinatı (varsa) → client günceller
      // Araç çalıştıysa mekan kartları AYNI yanıtta gelir → client'ın ayrıca
      // /nearby çağırmasına gerek kalmaz (eski akışta iki HTTP turu vardı).
      // null = araç hiç çalışmadı (eski işaret yolu geçerli).
      places: toolPlaces,
    });
  } catch (error) {
    // Timeout'u ayır: kullanıcı donmasın, dürüst ve Merci ağzıyla bir cevap alsın.
    if (isAnthropicTimeout(error)) {
      console.error("ANTHROPIC TIMEOUT (/merci):", error.message);
      return res.status(504).json({
        error: "Bu sefer düşünürken daldım 🐙 Bir daha sor, hemen toparlarım!",
      });
    }
    console.error("API Error:", error.message);
    res.status(500).json({ error: "Merci şu an müsait değil, tekrar dene!" });
  }
});

// ── /dev-upload KALDIRILDI (GÜVENLİK) ──
// Eski geçici dosya yükleme aracıydı; auth/token/rate-limit YOKTU → internetteki
// herkes sunulan index.html'i ezebiliyordu (uygulama ele geçirme riski). Deploy
// artık GitHub köprüsü + curl ile yapılıyor (replit-deploy-github-bridge), bu uca
// gerek yok. Geri EKLENMEMELİ; gerekirse güçlü env-token + rateLimit + dev-only ile.

// ── MERCİ SEÇENEK ÜRETİCİSİ (çark/oylama için hızlı + ucuz: Haiku, web_search yok) ──
app.post("/options", rateLimit, authAndQuota, async (req, res) => {
  try {
    const theme = (req.body && req.body.theme ? String(req.body.theme) : "")
      .trim()
      .slice(0, 120);
    const count = Math.min(Math.max(parseInt(req.body && req.body.count) || 6, 3), 8);

    const sys =
      "Sen Merci — karar yardımcısı sevimli bir ahtapot. Görevin: verilen konu için " +
      "bir karar çarkına konacak KISA seçenekler üretmek. SADECE geçerli bir JSON dizisi " +
      'döndür, başka HİÇBİR şey yazma. Örnek çıktı: ["Pizza","Burger","Döner"]. ' +
      "Kurallar: tam olarak " +
      count +
      " seçenek; her biri 1-3 kelime; Türkçe; konuya uygun, çeşitli ve gerçekçi; " +
      "tekrar yok; emoji yok; başına numara/tire koyma.";
    const userMsg = theme
      ? "Konu: " + theme
      : "Konu verilmedi — günlük, eğlenceli bir karar için rastgele ve çeşitli seçenekler üret (ne yenir, nereye gidilir, ne izlenir gibi).";

    const resp = await anthropic.messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 220,
        system: sys,
        messages: [{ role: "user", content: userMsg }],
      },
      { timeout: ANTHROPIC_TIMEOUT_SHORT }, // kısa çağrı → kısa sabır
    );

    let text = "";
    resp.content.forEach((b) => {
      if (b.type === "text") text += b.text;
    });

    let opts = [];
    try {
      const m = text.match(/\[[\s\S]*\]/);
      if (m) opts = JSON.parse(m[0]);
    } catch (e) {}

    const seen = {};
    opts = (Array.isArray(opts) ? opts : [])
      .map((x) =>
        String(x)
          .trim()
          .replace(/^["'\-\d.\)\s]+/, "")
          .slice(0, 40),
      )
      .filter((x) => {
        if (!x) return false;
        const k = x.toLowerCase();
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      })
      .slice(0, count);

    if (!opts.length) {
      return res.status(502).json({ error: "Seçenek üretilemedi, tekrar dene." });
    }
    res.json({ options: opts });
  } catch (e) {
    if (isAnthropicTimeout(e)) {
      console.error("ANTHROPIC TIMEOUT (/options):", e.message);
      return res.status(504).json({
        error: "Seçenekleri düşünürken daldım 🐙 Bir daha dene, hemen çıkarırım!",
      });
    }
    console.error("Options Error:", e.message);
    res.status(500).json({ error: "Merci şu an seçenek üretemiyor, tekrar dene!" });
  }
});

// ── YAKINDAKİ MEKANLAR (OpenStreetMap/Overpass — ÜCRETSİZ) + Merci önerisi ──
const LOC_FREE_LIMIT = 25; // free: günde 25 GERÇEK sonuç (abuse tavanı; boş/başarısız sorgu hak yakmaz)
const LOC_PRO_LIMIT = 100; // PRO: pratikte sınırsız

// ── OVERPASS TAG SETLERİ ──
// ÖNEMLİ: regex-CONTAINS (~"bar") KULLANMA — substring eşleştiği için alakasız POI
// getiriyordu: ~"bar" → "bar association" (İstanbul Barosu / hukuk), ~"pub" →
// "public_bath" (hamam). Bunun yerine her tür için TAM-EŞLEŞME (="deger") selektör
// DİZİSİ kullan; her selektör ayrı node/way bloğu üretir. Böylece yalnız gerçek
// içki barları / doğru mekanlar döner.
const OVERPASS_FILTERS = {
  food: ['["amenity"="restaurant"]', '["amenity"="fast_food"]'],
  cafe: ['["amenity"="cafe"]', '["amenity"="ice_cream"]'],
  bar: [
    '["amenity"="bar"]',
    '["amenity"="pub"]',
    '["amenity"="biergarten"]',
    '["amenity"="nightclub"]',
  ],
  dessert: [
    '["shop"="pastry"]',
    '["shop"="confectionery"]',
    '["shop"="bakery"]',
    '["amenity"="ice_cream"]',
  ],
  activity: [
    '["leisure"="park"]',
    '["leisure"="sports_centre"]',
    '["leisure"="fitness_centre"]',
    '["leisure"="bowling_alley"]',
    '["leisure"="amusement_arcade"]',
    '["amenity"="cinema"]',
  ],
};

// Kartta gösterilecek Türkçe kategori. Ham OSM tag'i (ör. "bar association",
// "fast_food") KULLANICIYA GÖSTERİLMEZ. Bu haritada OLMAYAN bir amenity/shop/leisure
// değeri = beklenmedik/alakasız POI → mekan LİSTEDEN ELENİR (gösterilmez).
const KIND_TR = {
  restaurant: "restoran",
  fast_food: "fast food",
  cafe: "kafe",
  ice_cream: "dondurma",
  bar: "bar",
  pub: "pub",
  biergarten: "bira bahçesi",
  nightclub: "gece kulübü",
  pastry: "pastane",
  confectionery: "şekerci",
  bakery: "fırın",
  park: "park",
  sports_centre: "spor merkezi",
  fitness_centre: "spor salonu",
  bowling_alley: "bowling",
  amusement_arcade: "oyun salonu",
  cinema: "sinema",
};

// ══════════════════════════════════════════════════════════════════════════
// ── MEKAN SAĞLAYICI: TOMTOM (2 AĞU 2026) ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// NEDEN: OSM'de Türk esnafı yok. ÖLÇÜLDÜ (Eminönü 3km, 10 esnaf sorgusu):
//   OSM 5/10 — üstelik isabetlerin yarısı YANLIŞ EŞLEŞME ("ıslak burger"→
//   McDonald's, "çiğ köfte"→Tarihi Sultanahmet KÖFTEcisi). TomTom 10/10.
//   kokoreç: OSM 1 tane 2855m ↔ TomTom 19 tane, en yakını 757m ve AÇIK.
//   midye dolma / tantuni / kumpir / boza / kelle söğüş → OSM'de HEPSİ 0.
// ⚠️ Overpass serbest metin ARAYAMIYOR: nwr["name"~"kokoreç"] indekssiz olduğu
//   için 3km'de bile 71 saniyede TIMEOUT. Yani OSM hattı sorguyu aramıyor,
//   genel kovadan isim tutturuyor. Kelime tablosu büyütmek bunu ÇÖZMEZ.
//
// NEDEN GOOGLE DEĞİL (ekonomi kalitenin önüne geçti):
//   Google Text Search Pro aşımda $32/1000. Ödüllü reklam geliri ≈ $0,003
//   (TR eCPM ~$3). AD_MSG_BONUS=4 → bir reklamın açtığı 4 arama Google'da
//   $0,128 = 43 KAT ZARAR. TomTom ~$0,50-0,75/1000 → aşımda bile kâr kalır.
//   Ayrıca Google'ın openNow'ı FİLTRE → sonuç saate bağlanır → önbellek ölür.
//   TomTom çalışma saatini VERİ olarak verir (ek ücretsiz, %67 kapsama) →
//   liste 30 gün önbelleğe alınır, açık/kapalı hesabı BURADA bedavaya yapılır.
//
// ⚠️ ACİL GERİ DÖNÜŞ: Replit secrets → KM_PLACES=osm → anında OSM'e döner.
//   DEPLOY GEREKMEZ, yeniden başlatma yeter. (KM_TOOL_USE ile aynı desen.)
const KM_PLACES = String(process.env.KM_PLACES || "osm").toLowerCase();
const TOMTOM_KEY = process.env.TOMTOM_KEY || "";
// Sert aylık tavan. Dolunca sessizce OSM'e düşülür → fatura YAPISAL olarak $0,
// uygulama bozulmaz, sadece eski kaliteye iner. Bedava kota 5.000, pay bırakıldı.
const PLACES_MONTHLY_CAP = parseInt(process.env.KM_PLACES_CAP || "4500", 10);

// Türkçe katlama: "Kokorec" ile "kokoreç" eşleşsin diye. Boşluksuz varyant da
// üretilir ("Cigkofte" ↔ "çiğ köfte").
function trFold(s) {
  return (
    String(s || "")
      // ⚠️ İ (büyük noktalı I) toLowerCase()'ten ÖNCE çevrilmeli: JS'te
      // "İ".toLowerCase() → "i" + U+0307 (ayrı birleşik nokta) üretir, yani
      // toLowerCase sonrası /İ/ değişimi ÖLÜ KOD olur ve "İnci Kokoreç" gibi
      // isimler eşleşmez. (test-tomtom.js bu tuzağı yakaladı — geri alma.)
      .replace(/İ/g, "i")
      .toLowerCase()
      .replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i")
      .replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u")
      // Kalan birleşik aksan işaretlerini (U+0300–U+036F) temizle: başka
      // kaynaklardan gelen ayrışık (NFD) yazımlar da aynı forma insin.
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
  );
}

// TomTom sınıflandırma kodu → Türkçe kategori. Listede OLMAYAN kod = ELE.
// ⚠️ HOTEL_MOTEL bilerek YOK: "boza" aramasında 1. sonuç "Grand Bona Sera
// Hotel" geldi (skor 0.708). Otel/kuyumcu/güzellik salonu asla mekan kartı olamaz.
const TT_KIND_TR = {
  RESTAURANT: "restoran",
  RESTAURANT_AREA: "yemek alanı",
  CAFE_PUB: "kafe",
  NIGHTLIFE: "gece kulübü",
  PARK_RECREATION_AREA: "park",
  MOVIE_THEATER: "sinema",
  LEISURE_CENTER: "eğlence merkezi",
};
// SHOP genel bir koddur (kuyumcu da SHOP, fırın da). Yalnız kategorilerinde
// yiyecek geçen dükkanlar kabul edilir: "Şirin Waffle & Kumpir" (food shops) ✓,
// "Dilek & Bora Gümüş Altın Alyans" (jewelry) ✗.
const TT_FOOD_SHOP = /food|bakery|pastry|ice cream|confection|butcher|patisserie|market/i;

// ── ÖNBELLEK: (500m ızgara × normalize sorgu) ────────────────────────────
// ⭐ MALİYETİN KULLANICI SAYISIYLA BÜYÜMEMESİNİN SEBEBİ BU. Anahtar kullanıcı
// DEĞİL, konum+sorgu → aynı semtten aynı soru ayda BİR kez ödenir. 5.000
// kullanıcı birkaç yüz ızgaraya yığılır; kullanıcı 10 katına çıkınca maliyet
// 10 kat DEĞİL ~2-3 kat artıp doygunlaşır (alan × kelime dağarcığıyla sınırlı).
const _ttCache = new Map();
const TT_CACHE_TTL = 30 * 24 * 3600 * 1000; // 30 gün
const TT_CACHE_MAX = 3000; // bellek tavanı (Replit konteyneri küçük)
function ttCacheKey(lat, lng, q) {
  const dLat = 500 / 111320; // ~500m
  const dLng = 500 / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
  return `${Math.round(lat / dLat)}_${Math.round(lng / dLng)}_${trFold(q).replace(/\s+/g, " ").trim()}`;
}

// ── AYLIK BÜTÇE SAYACI ───────────────────────────────────────────────────
// ⚠️ [[firestore-kota-kacagi]] DERSİ: koleksiyon TARAMASI YOK. Tek doküman,
// açılışta BİR kez okunur, sonra bellekte sayılır; yazma da tek dokümana artış.
let _ttMonth = "";
let _ttCount = 0;
let _ttLoaded = false;
function ttMonthId() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}
async function ttBudgetOk() {
  const m = ttMonthId();
  if (m !== _ttMonth) {
    _ttMonth = m;
    _ttCount = 0;
    _ttLoaded = false;
  }
  if (!_ttLoaded) {
    _ttLoaded = true; // hata olsa bile tekrar tekrar okumaya çalışma
    try {
      const s = await adminDb.collection("apiUsage").doc("tomtom_" + m).get();
      if (s.exists) _ttCount = s.data().count || 0;
    } catch (e) {
      console.error("TomTom bütçe okunamadı (bellekten devam):", e.message);
    }
  }
  return _ttCount < PLACES_MONTHLY_CAP;
}
function ttBudgetSpend() {
  _ttCount++;
  // Ateşle-unut: sayaç yazımı arama yanıtını BEKLETMEMELİ.
  adminDb
    .collection("apiUsage")
    .doc("tomtom_" + _ttMonth)
    .set(
      { count: FieldValue.increment(1), month: _ttMonth, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    )
    .catch((e) => console.error("TomTom bütçe yazılamadı:", e.message));
}

// TomTom timeRanges → "şu an açık mı". Saat verisi ek ücretsiz geldiği için
// bu hesap BİZDE yapılır; sonuç saate bağlı olmadığından önbellek bozulmaz.
// (Bu yüzden dönen kayıtta `oh` ham aralık olarak saklanır, `open` DEĞİL.)
function ttOpenNow(oh) {
  if (!oh || !Array.isArray(oh.timeRanges)) return null;
  const now = Date.now();
  for (const tr of oh.timeRanges) {
    const s = tr && tr.startTime,
      e = tr && tr.endTime;
    if (!s || !e || !s.date || !e.date) continue;
    const p = (x) =>
      new Date(
        `${x.date}T${String(x.hour ?? 0).padStart(2, "0")}:${String(x.minute ?? 0).padStart(2, "0")}:00`,
      ).getTime();
    const sd = p(s),
      ed = p(e);
    if (isFinite(sd) && isFinite(ed) && now >= sd && now <= ed) return true;
  }
  return false;
}

// ── ALAKA FİLTRESİ — "boza → kuyumcu" TUZAĞINI KAPATIR ───────────────────
// ⚠️ TomTom BULANIK (fuzzy) arar: gerçek eşleşme yoksa benzer sesli alakasız
// yer döndürür ve bunu YÜKSEK SKORLA yapar. ÖLÇÜM: "boza" → Grand Bona Sera
// Hotel 0.708 · Dilek & Bora Gümüş (KUYUMCU) 0.453 · Madame Roza Pizza 0.357.
// Aynı ölçümde GERÇEK eşleşmeler: kumpir 0.693–0.965, kokoreç 0.893–0.955.
// ➜ SKOR EŞİĞİ TEK BAŞINA İŞE YARAMAZ (0.708 çöp > 0.693 gerçek — ÇAKIŞIYOR).
// ➜ Asıl ayırt edici: sorgu kelimesi mekan İSMİNDE geçiyor mu. "boza" hiçbir
//   ismin içinde yok ("Bona","Bora","Roza") → hepsi elenir. Bunu değiştirme.
//
// ⚠️⚠️ BU SÜZGEÇ TOMTOM'DAN DAHA KATI OLMAMALI — yoksa TomTom doğru mekanı
// bulur, biz atarız ve sessizce OSM'e düşeriz (kullanıcı sadece kötü sonuç
// görür, hata görmez). TÜRKÇE'DE ASIL KIRILMA NOKTASI EKLERDİR:
//   sorgu "kokoreççi" → "kokorecci"   ·   mekan "Gala Kokoreç" → "gala kokorec"
//   düz alt-dize testi: "gala kokorec".includes("kokorecci") = FALSE → KAYIP
// Türkçe SONDAN EKLEMELİ bir dildir, yani kök HER ZAMAN başta durur → doğru
// karşılaştırma ORTAK ÖNEK uzunluğudur, alt-dize değil.
//   kokorecci ↔ kokorec  → ortak önek 7 ✅   ·   tantuni ↔ tantunici → 7 ✅
//   midye ↔ midyeci → 5 ✅                   ·   simit ↔ simitci → 5 ✅
// Eşik 5 (kısa kelimelerde kelimenin tamamı) çöpü hâlâ eliyor:
//   boza ↔ bona → ortak önek 2 ❌   ·   boza ↔ bora → 2 ❌   ·   boza ↔ roza → 0 ❌
// Yani "boza → kuyumcu" koruması AYNEN duruyor, sadece ek toleransı eklendi.
const TT_MIN_PREFIX = 5;
function _commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
function ttNameMatches(name, words) {
  const n = trFold(name);
  const nz = n.replace(/\s+/g, "");
  // İsmi kelimelere ayır: kök karşılaştırması kelime BAŞINDAN yapılmalı.
  const tokens = n.split(/[^a-z0-9]+/).filter(Boolean);
  return words.filter((w) => {
    const wz = w.replace(/\s+/g, "");
    if (n.includes(w) || nz.includes(wz)) return true; // hızlı yol: düz içerme
    // Ek toleransı: kelimenin ya da mekan sözcüğünün kökü ortaksa eşleş.
    const need = Math.min(wz.length, TT_MIN_PREFIX);
    return tokens.some((t) => _commonPrefix(t, wz) >= need);
  });
}

/**
 * TomTom POI araması. Başarısızlıkta/kotada `null` döner → çağıran OSM'e düşer.
 * Dönen mekanlar /nearby'nin OSM çıktısıyla AYNI şekilde: {name, kind, phone, lat, lng, dist}
 * @returns {Promise<{places:Array, broadened:boolean, cached:boolean}|null>}
 */
async function tomtomSearch({ lat, lng, query, typeKey }) {
  if (!TOMTOM_KEY) return null;
  const q = String(query || "").trim();
  if (q.length < 2) return null; // serbest metin yoksa TomTom'un anlamı yok

  const ck = ttCacheKey(lat, lng, q);
  const hit = _ttCache.get(ck);
  if (hit && Date.now() - hit.at < TT_CACHE_TTL) {
    // ⚠️ Açık/kapalı ÖNBELLEKTEN OKUNMAZ, her seferinde YENİDEN hesaplanır —
    // yoksa sabah önbelleğe girmiş "AÇIK" akşam yanlış gösterilir.
    return {
      places: hit.places.map((p) => ({ ...p, open: ttOpenNow(p.oh) })),
      broadened: hit.broadened,
      cached: true,
    };
  }

  if (!(await ttBudgetOk())) {
    console.warn(
      `TomTom aylık tavan doldu (${_ttCount}/${PLACES_MONTHLY_CAP}) → OSM'e düşülüyor`,
    );
    return null;
  }

  const url =
    `https://api.tomtom.com/search/2/poiSearch/${encodeURIComponent(q)}.json` +
    `?key=${encodeURIComponent(TOMTOM_KEY)}&lat=${lat}&lon=${lng}` +
    `&radius=6000&limit=40&countrySet=TR&language=tr-TR&openingHours=nextSevenDays`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let j;
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      console.error("TomTom HTTP", r.status, (await r.text()).slice(0, 200));
      return null;
    }
    j = await r.json();
  } catch (e) {
    console.error("TomTom hata:", e.name === "AbortError" ? "timeout" : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
  ttBudgetSpend();

  const words = trFold(q).split(/\s+/).filter((w) => w.length >= 3);
  let anyFullMatch = false;
  const places = (j.results || [])
    .map((r) => {
      const poi = r.poi || {};
      const name = String(poi.name || "").trim();
      if (!name) return null;
      const code = (r.poi && r.poi.classifications && r.poi.classifications[0]
        ? r.poi.classifications[0].code
        : "") || "";
      const cats = (poi.categories || []).join(" ");
      // Kategori sağlaması: otel/kuyumcu/kuaför ELE; SHOP yalnız yiyecekse geçer.
      let kind = TT_KIND_TR[code];
      if (!kind && code === "SHOP" && TT_FOOD_SHOP.test(cats)) kind = "dükkan";
      if (!kind) return null;
      // İsim alaka sağlaması (asıl filtre — yukarıdaki bloğa bak).
      if (words.length) {
        const m = ttNameMatches(name, words);
        if (!m.length) return null;
        if (m.length === words.length) anyFullMatch = true;
      }
      const pos = r.position || {};
      if (!isFinite(pos.lat) || !isFinite(pos.lon)) return null;
      return {
        name: name.slice(0, 60),
        kind,
        phone: String(poi.phone || "").slice(0, 30),
        lat: pos.lat,
        lng: pos.lon,
        dist: Math.round(
          isFinite(r.dist) ? r.dist : haversine(lat, lng, pos.lat, pos.lon),
        ),
        oh: poi.openingHours || null, // ham aralık — `open` çağrı anında hesaplanır
      };
    })
    .filter(Boolean);

  // Tam eşleşme yoksa (ör. "ıslak burger" → sadece "burger" tuttu) bu bir
  // GENİŞLETMEDİR; /nearby bu bayrakla kullanıcıya dürüstçe "tam onu bulamadım,
  // en yakın alternatifler" der. Sessizce doğru sonuç gibi sunma.
  const broadened = words.length > 1 && !anyFullMatch;

  if (_ttCache.size >= TT_CACHE_MAX) {
    // en eski girdiyi at (Map ekleme sırasını korur)
    _ttCache.delete(_ttCache.keys().next().value);
  }
  _ttCache.set(ck, { at: Date.now(), places, broadened });

  return {
    places: places.map((p) => ({ ...p, open: ttOpenNow(p.oh) })),
    broadened,
    cached: false,
  };
}

// Yazıyla verilen semt/şehri koordinata çevir (Nominatim forward-geocode).
// Otomatik konum yanlışsa kullanıcının metinle verdiği yere ÖNCELİK verilir.
// Türkiye'ye ve (varsa) mevcut şehre bias'lanır; UA zorunlu (Nominatim politikası).
async function forwardGeocode(place, near) {
  let q = place;
  if (!/(türkiye|turkey)/i.test(q)) q += ", Türkiye";
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=tr&q=" +
    encodeURIComponent(q);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "KararMercii/1.0 (https://kararmercii.com)",
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    const arr = await r.json();
    if (Array.isArray(arr) && arr[0] && arr[0].lat && arr[0].lon) {
      const lat = parseFloat(arr[0].lat);
      const lng = parseFloat(arr[0].lon);
      if (isFinite(lat) && isFinite(lng)) {
        // Kısa etiket: display_name'in ilk 2 parçası (semt, ilçe/şehir)
        const parts = String(arr[0].display_name || place)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const name = parts.slice(0, 2).join(", ") || place;
        return { lat, lng, name };
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return null;
}

// ── SPESİFİK İSTEK → MUTFAK/İSİM DARALTMA ──
// Kullanıcı "sushi/pizza/kebap" gibi SPESİFİK bir şey isteyince tüm yemekçileri
// (baklavacı, balıkçı, dönerci...) listelemek YANLIŞ. Bu kurallar isteği yalnız
// ilgili türe daraltır: önce OSM cuisine tag'iyle ara, bulamazsan mekan İSMİNDE
// eşleştir, o da yoksa dürüstçe "tam X yok, en yakın alternatifler" de.
// test = kullanıcı sorgusunda aranan kelime; cuisine = Overpass cuisine regex;
// name = mekan adında aranan regex; label = karta/mesaja yazılacak Türkçe etiket.
// ⚠️ GENEL KURAL: cuisine SADECE o yemeğe ÖZGÜ tag içermeli. ŞEMSİYE tag
// ("turkish", "asian", "american", "italian"-pizza-için gibi geniş) KULLANMA —
// "turkish" tüm Türk mutfağını (çiğköfte/Komagene, pideci, tatlıcı) çeker → kebap
// ararken çiğköfteci gelir. Şemsiye yerine spesifik tag + isim eşleşmesi (Tier B).
const CUISINE_RULES = [
  { test: /su\s?shi|suşi|japon/i, cuisine: "sushi|japanese", name: /sushi|suşi|japon/i, label: "suşi/japon" },
  { test: /pizza|pizzac/i, cuisine: "pizza", name: /pizza/i, label: "pizza" },
  { test: /burger|hamburger/i, cuisine: "burger", name: /burger/i, label: "burger" },
  { test: /döner|doner/i, cuisine: "doner", name: /döner|doner/i, label: "döner" },
  { test: /kebap|kebab|ocakbaş|ocakbas|mangal|(^|\W)ızgara|(^|\W)izgara/i, cuisine: "kebab|barbecue|grill|mangal", name: /kebap|kebab|ocakbaş|mangal|ızgara|izgara/i, label: "kebap/ızgara" },
  // Meyhane / rakı-balık: bar/pub DEĞİL, meze+deniz mahsulü ağırlıklı oturmalı mekan.
  // OSM'de "meyhane" zayıf etiketli → seafood/fish cuisine + isim eşleşmesi; bulunmazsa
  // (Tier C) genel restoran'a genişler. ASLA bar bucket'ına düşmez (typeKey food'a zorlandı).
  { test: /meyhane|rakı|raki|meze/i, cuisine: "seafood|fish", name: /meyhane|balık|balik|meze/i, label: "meyhane/balık" },
  { test: /balık|balik|deniz ürün|seafood/i, cuisine: "seafood|fish", name: /balık|balik/i, label: "balık/deniz" },
  { test: /çin|chinese|noodle|\bwok\b/i, cuisine: "chinese|noodle", name: /chinese|çin|wok|noodle/i, label: "çin/asya" },
  { test: /italyan|italian|makarna|\bpasta\b/i, cuisine: "italian|pasta", name: /italyan|italian|makarna|pasta/i, label: "italyan/makarna" },
  { test: /meksika|mexican|taco|burrito/i, cuisine: "mexican", name: /meksika|mexican|taco|burrito/i, label: "meksika" },
  { test: /vegan|vejetaryen|vejeteryan|vegetarian/i, cuisine: "vegan|vegetarian", name: /vegan|vejetaryen/i, label: "vegan/vejetaryen" },
  { test: /kahvaltı|kahvalti|breakfast|brunch/i, cuisine: "breakfast|brunch", name: /kahvaltı|kahvalti|breakfast|brunch/i, label: "kahvaltı" },
  { test: /steak|biftek|steakhouse|steak house/i, cuisine: "steak_house|steak", name: /steak|biftek/i, label: "steakhouse" },
  { test: /pide|lahmacun/i, cuisine: "pide|lahmacun", name: /pide|lahmacun/i, label: "pide/lahmacun" },
  { test: /çiğ ?köfte|cig ?kofte|çiğköfte/i, cuisine: "", name: /çiğ ?köfte|cig ?kofte|komagene|çiğ/i, label: "çiğ köfte" },
  { test: /köfte|kofte/i, cuisine: "kofte|meatballs|meatball", name: /köfte|kofte/i, label: "köfte" },
  { test: /tost|sandviç|sandvic|sandwich/i, cuisine: "sandwich", name: /tost|sandviç|sandwich/i, label: "tost/sandviç" },
  // ── FIRIN AİLESİ (2 AĞU — YAPISAL BOŞLUK) ──
  // Simitçi/fırın/börekçi/poğaçacı OSM'de `shop=bakery` ile etiketlenir; food bucket'ı
  // ise SADECE amenity=restaurant|fast_food sorguluyordu → "simit" için mükemmel bir
  // kural yazılsa bile hiçbir zaman bulunamazdı. Kelime eksikliği değil, KATEGORİ
  // HARİTASI eksikliğiydi (canlı bug: "simit" → Çiğ Köfteci Gakgoş Usta önerildi).
  // Bu yüzden kural şemasına opsiyonel `sel` (ham selektör dizisi) eklendi: cuisine
  // tag'iyle ifade EDİLEMEYEN türler artık kendi amenity/shop selektörünü verebiliyor.
  {
    test: /simit|f[ıi]r[ıi]n|b[öo]rek|po[ğg]a[çc]a|a[çc]ma|unlu mamul|ekmek|kruvasan|croissant/i,
    cuisine: "",
    sel: [
      '["shop"="bakery"]',
      '["shop"="pastry"]',
      '["amenity"="fast_food"]["cuisine"~"simit|borek|börek|bakery|pastry|sandwich",i]',
    ],
    name: /simit|f[ıi]r[ıi]n|b[öo]rek|po[ğg]a[çc]a|unlu|ekmek|bakery|pastane/i,
    label: "simit/fırın",
  },
];
// GENEL NEGATİF FİLTRE: kebap/köfte/döner/ızgara gibi ET- IZGARA isteğinde çiğköfte
// zincirleri (Komagene, Çiğköftem, Oses) SIZMASIN — bunlar cuisine=turkish taşıyıp
// ya da isimle yanlış eşleşip geliyordu. İstek çiğköfte'nin KENDİSİ değilse ELE.
const CIGKOFTE_CHAINS = /komagene|çiğ ?köfte|cig ?kofte|çiğköftem|çiğköfte|oses/i;

function haversine(la1, lo1, la2, lo2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLa = toR(la2 - la1);
  const dLo = toR(lo2 - lo1);
  const a =
    Math.sin(dLa / 2) ** 2 +
    Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

app.post("/nearby", rateLimit, async (req, res) => {
  try {
    // Auth
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token)
      return res.status(401).json({ error: "Konum önerisi için giriş yap." });
    let uid,
      isPro = false;
    // KİMLİK: yalnız gerçek token hatası → 401.
    try {
      const decoded = await getAuth().verifyIdToken(token);
      uid = decoded.uid;
      if (decoded.firebase && decoded.firebase.sign_in_provider === "anonymous") {
        return res
          .status(401)
          .json({ error: "Konum önerisi için Google ile giriş yap." });
      }
    } catch (e) {
      console.error("AUTH FAIL (/nearby, token geçersiz):", e.message);
      return res.status(401).json({ error: "Oturum doğrulanamadı." });
    }
    // FIRESTORE: /merci ile aynı ayrım — altyapı hatası "giriş yap" DEMEZ (503).
    try {
      const us = await adminDb.collection("users").doc(uid).get();
      // /merci ile aynı çapraz kontrol: süresi geçmiş isPro:true PRO sayılmaz
      isPro = us.exists && isProValid(us.data());
    } catch (e) {
      console.error("INFRA FAIL (/nearby, Firestore users):", e.code || "", e.message);
      return res
        .status(503)
        .json({ error: "Şu an sana bağlanamadım, biraz sonra tekrar dene 🐙" });
    }

    // Girdi
    const lat = parseFloat(req.body && req.body.lat);
    const lng = parseFloat(req.body && req.body.lng);
    if (!isFinite(lat) || !isFinite(lng))
      return res.status(400).json({ error: "Konum geçersiz." });
    let typeKey = String((req.body && req.body.type) || "food");
    const locName = String((req.body && req.body.locName) || "").slice(0, 60);
    // Kullanıcının ham isteği (ör. "yakında sushi var mı"). Spesifik tür daraltması
    // için kullanılır; yoksa (eski client) davranış eskisi gibi bucket bazlı kalır.
    const query = String((req.body && req.body.query) || "")
      .toLowerCase()
      .slice(0, 80);
    // Yalnız sunucu-içi araç çağrısında true (bkz. aşağıdaki yorum bloğu).
    const skipComment = !!(req.body && req.body.skipComment);
    // ── MODELİN ÜRETTİĞİ OSM İPUÇLARI (2 AĞU) ──
    // ⚠️ GÜVENLİK: bu değerler MODELDEN geliyor ve (a) Overpass QL sorgu metnine
    // gömülüyor, (b) new RegExp()'e veriliyor. Ham bırakılırsa tırnak/köşeli
    // parantez ile sorgu kırılabilir, iç içe niceleyiciyle ReDoS üretilebilir.
    // Bu yüzden karakter kümesi BEYAZ LİSTE ile daraltılıyor: geriye sadece
    // harf/rakam/alt çizgi ve `|` kalıyor → ne sorgu kaçışı ne regex bombası mümkün.
    const _sanTag = (v) =>
      String(v || "").toLowerCase().replace(/[^a-z0-9_|]/g, "").slice(0, 120);
    const _sanIsim = (v) =>
      String(v || "").toLowerCase().replace(/[^a-z0-9çğıöşü|\s]/g, "").slice(0, 120);
    const hintCuisine = _sanTag(req.body && req.body.osmCuisine);
    const hintShop = _sanTag(req.body && req.body.osmShop);
    const hintIsim = _sanIsim(req.body && req.body.osmIsim);
    // OTURMALI/İÇKİLİ SİNYAL: kullanıcı şarap/bira/kokteyl gibi içki YA DA "oturmalı
    // yemek / restoran / akşam yemeği" istiyorsa → fast-food, büfe, pizza-zinciri
    // (Domino's) DEĞİL, servisli-oturmalı restoran (amenity=restaurant) istenir.
    // Bu sinyalde fast_food bucket'ı ELENİR (aşağıda). Örn "makarna şarap içeceğiz"
    // → Big Chefs (restaurant) EVET, Domino's/büfe HAYIR.
    const wantsSitdown =
      /şarap|sarap|içki|icki|alkol|bira|kokteyl|kokteil|rakı|raki|meyhane|şaraph|saraph|oturmal|à la carte|a la carte|akşam yeme|aksam yeme|romantik|masa(da|ya)?\b|garson|servisli|restoran|restaurant/i.test(
        query,
      );
    // RAKI/MEYHANE/BALIK NİYETİ — bar/pub DEĞİL, meyhane / balık lokantası / oturmalı
    // restoran ister. Rakı bir bar/pub içkisi DEĞİLDİR (bar/pub = bira & kokteyl);
    // "rakı balık" meyhane & seafood/restaurant mekânıdır. Model/client bu isteği
    // yanlışlıkla type=bar'a (alkol sanıp) yönlendirebiliyor (canlı bug: "rakı balık"
    // → pub/bar önerildi). Server SON SÖZ: bu niyet sinyali varsa food'a ZORLA ki
    // aşağıda bar/pub/nightclub selektörleri HİÇ kullanılmasın; CUISINE_RULES seafood
    // kuralı devreye girsin (meyhane OSM'de zayıf etiketli → seafood/restaurant'a düşer).
    const meyhaneIntent =
      /meyhane|rakı|raki|balık|balik|deniz ürün|deniz urun|meze/i.test(query);
    if (meyhaneIntent && !["food", "cafe", "dessert"].includes(typeKey)) {
      typeKey = "food";
    }
    // "başka öner / beğenmedim" akışı: client daha önce GÖSTERİLEN mekan isimlerini
    // gönderir → aynı yerleri tekrar önermeyelim, farklı/daha uzak olanları getirelim.
    const excludeArr = Array.isArray(req.body && req.body.exclude)
      ? req.body.exclude
      : [];
    const excludeSet = new Set(
      excludeArr
        .slice(0, 40)
        .map((x) => String(x || "").toLowerCase().trim())
        .filter(Boolean),
    );
    // exclude varsa kullanıcı "başka" istiyor → daha uzağa bakmaya izin ver (cap yükselir).
    const radiusCap = excludeSet.size ? 20000 : 5000;
    const radius = Math.min(
      Math.max(parseInt(req.body && req.body.radius) || 2500, 300),
      radiusCap,
    );

    // Günlük konum kotası (AI kotasından AYRI). ÖN-KONTROL sadece OKUR, artırmaz.
    // Hak yalnızca GERÇEK mekan döndüğünde tüketilir (aşağıda) → boş/başarısız
    // sorgu kullanıcının hakkını YAKMAZ (test/ilk kullanım yanlış "hakkın doldu" vermesin).
    const today = new Date().toISOString().slice(0, 10);
    const limit = isPro ? LOC_PRO_LIMIT : LOC_FREE_LIMIT;
    const ref = adminDb.collection("locUsage").doc(`${uid}_${today}`);
    let usedCount = 0;
    try {
      const preSnap = await ref.get();
      usedCount = preSnap.exists ? preSnap.data().count || 0 : 0;
    } catch (e) {
      // Firestore okunamıyor (kota/ağ) → dürüst 503. "Giriş yap" DEME.
      console.error("INFRA FAIL (/nearby, Firestore locUsage):", e.code || "", e.message);
      return res
        .status(503)
        .json({ error: "Şu an sana bağlanamadım, biraz sonra tekrar dene 🐙" });
    }
    // Kota AŞIMI meşru ret → 429 aynen korunur.
    if (usedCount >= limit)
      return res
        .status(429)
        .json({ error: "Günlük konum önerisi hakkın doldu!", limitReached: true });

    // Overpass sorgusu (boş dönerse radius'u büyütüp 1 kez daha dene → "bulamadım" azalır)
    // selectors artık TAM-EŞLEŞME selektör DİZİSİ (regex-contains DEĞİL) → her biri ayrı blok.
    let bucketSelectors = OVERPASS_FILTERS[typeKey] || OVERPASS_FILTERS.food;
    // Oturmalı/içkili istekte yemek bucket'ını SADECE restaurant'a daralt (fast_food
    // = büfe/Domino's/dönerci-tezgah → şarap servisi yok, oturmalı değil → ELE).
    if (typeKey === "food" && wantsSitdown) {
      bucketSelectors = ['["amenity"="restaurant"]'];
    }
    // ÇOKLU ENDPOINT: overpass-api.de sık sık "server too busy" (Dispatcher timeout)
    // verip JSON yerine HTML döndürüyordu → .json() patlıyor → boş liste → hiç mekan
    // gelmiyordu (ANA BUG). Şimdi birden fazla mirror'ı sırayla deniyoruz ve dönen
    // gövdenin GERÇEKTEN JSON olduğunu doğruluyoruz (HTML hata sayfası = başarısız say).
    const OVERPASS_ENDPOINTS = [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://overpass.private.coffee/api/interpreter",
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    ];
    async function runOverpass(r, sels) {
      const blocks = sels
        .map(
          (s) =>
            `node${s}(around:${r},${lat},${lng});way${s}(around:${r},${lat},${lng});`,
        )
        .join("");
      const q = `[out:json][timeout:25];(${blocks});out center 60;`;
      for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 30000);
          let ovr;
          try {
            ovr = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: "data=" + encodeURIComponent(q),
              signal: ctrl.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          // Gövdeyi ÖNCE text al: Overpass hata durumunda 200 dönüp HTML gövde
          // (<?xml ... "server too busy") verebiliyor. JSON değilse bu endpoint'i
          // başarısız say ve bir sonrakine geç.
          const body = await ovr.text();
          const trimmed = body.trimStart();
          if (!trimmed.startsWith("{")) {
            console.error(
              `Overpass non-JSON from ${endpoint} (status ${ovr.status}): ${trimmed.slice(0, 80)}`,
            );
            continue;
          }
          let d;
          try {
            d = JSON.parse(body);
          } catch (pe) {
            console.error(`Overpass JSON parse fail from ${endpoint}:`, pe.message);
            continue;
          }
          if (d && Array.isArray(d.elements)) return d.elements;
          // elements yoksa (remark/hata alanı) → sıradaki endpoint
        } catch (e) {
          console.error(`Overpass fetch error (${endpoint}):`, e.message);
          continue;
        }
      }
      return [];
    }
    // Boş dönerse yarıçapı KADEMELİ büyüt → "civarda yok" demek yerine en yakın
    // GERÇEK mekanları (isim + mesafe) getir; kullanıcı uzak olsa da ismiyle görsün.
    async function runExpanding(sels) {
      let out = await runOverpass(radius, sels);
      const steps = [5000, 12000, 25000];
      for (let i = 0; i < steps.length && !out.length; i++) {
        if (steps[i] > radius) out = await runOverpass(steps[i], sels);
      }
      return out;
    }

    // ── SPESİFİK İSTEK DARALTMA ──
    // Kullanıcı "sushi/pizza/kebap" gibi spesifik bir şey istediyse (query'de kelime
    // eşleşiyorsa) SADECE o türü göster. Sıra: (A) OSM cuisine tag ile ara → (B) tag
    // yoksa bucket'tan mekan İSMİNDE eşleştir → (C) o da yoksa DÜRÜSTÇE bucket'a
    // genişle (broadened=true) ve mesajda "tam X yok, en yakın alternatifler" de.
    // Yalnız yeme-içme bucket'larında uygulanır (bar/aktivite'de mutfak anlamsız).
    // ── ÖNCELİK 1: MODELİN ÜRETTİĞİ İPUÇLARI (tabloyu ATLAR) ──
    // Elle yazılmış CUISINE_RULES sonlu; kavramlar sonsuz ("kokoreç", "kumpir",
    // "midye", "tantuni"...). Model bu etiketleri kendi üretebildiği için artık
    // BİRİNCİL yol bu; tablo yalnızca model ipucu vermezse yedek olarak çalışır.
    let rule = null;
    if (hintCuisine || hintShop || hintIsim) {
      const sels = [];
      if (hintShop) {
        hintShop
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 6)
          .forEach((sh) => sels.push(`["shop"="${sh}"]`));
      }
      if (hintCuisine) {
        const am = wantsSitdown
          ? "restaurant"
          : "restaurant|fast_food|cafe|ice_cream";
        sels.push(`["amenity"~"^(${am})$"]["cuisine"~"${hintCuisine}",i]`);
      }
      // İsim regex'i: ipucu varsa ondan, yoksa sorgunun kelimelerinden.
      // (Karakter kümesi zaten sanitize edildiği için niceleyici/parantez içeremez.)
      let nameRe = /$^/; // hiçbir şeyle eşleşmeyen güvenli varsayılan
      const isimKaynak =
        hintIsim ||
        String(query || "")
          .trim()
          .split(/\s+/)
          .filter((w) => w.length > 2)
          .join("|");
      if (isimKaynak) {
        try {
          nameRe = new RegExp(isimKaynak, "i");
        } catch (e) {
          nameRe = /$^/;
        }
      }
      rule = {
        sel: sels,
        cuisine: "",
        name: nameRe,
        label: query || "aradığın tür",
        _model: true, // teşhis: bu kural tablodan değil modelden geldi
      };
      console.log(
        "mekan_ara ipuçları:",
        JSON.stringify({ hintCuisine, hintShop, hintIsim, sel: sels.length }),
      );
    }
    // ── ÖNCELİK 2: eski elle yazılmış tablo (yedek) ──
    if (!rule) {
      rule =
        query && ["food", "cafe", "dessert"].includes(typeKey)
          ? CUISINE_RULES.find((c) => c.test.test(query))
          : null;
    }
    let els = [];
    let broadened = false;
    let bucketTried = false;

    // ── SAĞLAYICI: TOMTOM (varsa Overpass tier'ları HİÇ çalışmaz) ──────────
    // ⭐ MALİYET KARARI: TomTom SADECE spesifik serbest metin sorgusunda çağrılır.
    // "ne yesek / karnım aç" gibi GENEL istekler bedava OSM kovasında kalır —
    // orada OSM zaten yeterli (en yakın restoranları listelemek etiket işi).
    // Ücretli çağrı yalnız OSM'in çuvalladığı yerde ("kokoreç") harcanır.
    // ⚠️⚠️ SIRA KRİTİK — CANLIDA BUNUN TERSİ BUG'DI (2 Ağu, cihaz testi):
    // `query`    = modelin `arama` alanı → TEMİZ İNSAN TERİMİ ("kokoreç")
    // `hintIsim` = OSM İÇİN üretilmiş REGEX ("kokoreç|kokoreçci|kokorec")
    // Önce hintIsim alınıp `|` boşluğa çevrilince TomTom'a "kokoreç kokoreçci
    // kokorec" diye bozuk çok-terimli bir metin sorgusu gidiyordu → sonuç boş →
    // ttRes null → sessizce OSM'e düşüyordu (kullanıcı 7,3 km'deki tek kokoreççiyi
    // gördü, oysa yakında çok vardı). Regex'i serbest metin aramasına ASLA verme;
    // mecbur kalınırsa YALNIZ ilk alternatif kullanılır.
    let ttRes = null;
    let ttTerm = ""; // dışarıda: aşağıdaki `matched` ve dürüstlük mesajı kullanıyor
    if (KM_PLACES === "tomtom" && ["food", "cafe", "dessert"].includes(typeKey)) {
      const searchTerm = (
        query || String(hintIsim || "").split("|")[0] || ""
      ).trim();
      ttTerm = searchTerm;
      ttRes = await tomtomSearch({ lat, lng, query: searchTerm, typeKey });
      if (ttRes) {
        // ⚠️ REGRESYON KORUMASI: OSM boru hattı atlandığı için "başka öner"
        // akışının exclude süzgeci, isim tekilleştirmesi ve 12'lik kırpma
        // BURADA elle uygulanmalı — yoksa kullanıcı "başka öner" deyince
        // aynı mekanlar geri gelir (canlıda sessiz bir gerileme olurdu).
        const seenTt = new Set();
        ttRes.places = ttRes.places
          .filter((p) => {
            const k = String(p.name).toLowerCase().trim();
            if (excludeSet.size && excludeSet.has(k)) return false;
            if (seenTt.has(k)) return false;
            seenTt.add(k);
            return true;
          })
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 12)
          // `oh` ham TomTom çalışma-saati bloğu: yalnız sunucuda `open` hesabı
          // için gerekli, client'a/modele GÖNDERİLMEZ (gereksiz yük + karmaşa).
          .map(({ oh, ...p }) => p);
      }
      if (ttRes && !ttRes.places.length) ttRes = null; // boş döndüyse OSM'e şans ver
      if (ttRes) {
        broadened = ttRes.broadened;
        console.log(
          `TomTom "${searchTerm}" → ${ttRes.places.length} mekan` +
            (ttRes.cached ? " (ÖNBELLEK)" : ` (ücretli, ay: ${_ttCount}/${PLACES_MONTHLY_CAP})`),
        );
      }
    }

    // Tier A: cuisine tag daraltması (yeme-içme amenity'leri içinde).
    // Oturmalı/içkili istekte SADECE restaurant (fast_food'lu zincir cuisine=pizza
    // eşleşmesi = Domino's → şarap yok → dışarıda bırak).
    // rule.sel = cuisine tag'iyle ifade edilemeyen türler için HAM selektör dizisi
    // (ör. simit/fırın → shop=bakery). Varsa cuisine sorgusunun YERİNE geçer.
    if (!ttRes && rule && rule.sel && rule.sel.length) {
      els = await runExpanding(rule.sel);
    } else if (!ttRes && rule && rule.cuisine) {
      const cuisineAmenity = wantsSitdown
        ? "restaurant"
        : "restaurant|fast_food|cafe|ice_cream";
      els = await runExpanding([
        `["amenity"~"^(${cuisineAmenity})$"]["cuisine"~"${rule.cuisine}",i]`,
      ]);
    }
    // Tier B: cuisine tag'i yoksa, bucket sonuçlarını mekan İSMİNE göre süz
    if (!ttRes && rule && !els.length) {
      const bucketEls = await runExpanding(bucketSelectors);
      bucketTried = true;
      const named = bucketEls.filter(
        (e) =>
          e.tags &&
          rule.name.test(String(e.tags["name:tr"] || e.tags.name || "")),
      );
      if (named.length) {
        els = named; // isimle eşleşen gerçek "X Sushi" yerleri → alakalı
      } else if (bucketEls.length) {
        els = bucketEls; // spesifik tür hiç yok → en yakın alternatifler
        broadened = true;
      }
    }
    // Bucket varsayılanı (spesifik istek yok ya da yukarıda denenmedi)
    if (!ttRes && !els.length && !bucketTried) {
      els = await runExpanding(bucketSelectors);
    }
    // Kartta/etikette gösterilecek Türkçe tür adı: spesifik ve gerçekten bulunduysa
    // rule.label ("suşi/japon"); genişletildiyse ham OSM kategorisi (KIND_TR) kalır.
    const forceKind = rule && !broadened ? rule.label : "";

    const seen = {};
    // Adı "baro / barosu / association / hukuk / avukat" içeren POI'ler = hukuk
    // kurumu (İstanbul Barosu gibi) → bar araması sonucuna KESİN sızmasın.
    const NAME_BLOCKLIST = /(baro(su)?\b|bar association|avukat|hukuk)/i;
    // BAR bucket'ında amenity=bar/pub etiketli AMA aslında içki mekanı OLMAYAN
    // yerler sızıyor (tenis/spor kulübü, dernek, community merkezi, otel — çoğu
    // üye barı için amenity=bar node'u taşır). TAG-tabanlı ele: bu ikincil
    // sinyaller varsa gerçek bir bar/pub değildir (isim-tabanlı elemekten güvenli;
    // gerçek "Konak Bar" yanlışlıkla silinmez). Sadece bar aramasında uygulanır.
    function isNonDrinkVenue(tags) {
      if (!tags) return false;
      if (tags.leisure) return true; // sports_centre, fitness_centre, pitch, stadium...
      if (tags.sport) return true; // tennis, football, basketball...
      if (tags.club) return true; // club=sport/social/... (dernek/kulüp)
      if (tags.amenity === "community_centre" || tags.amenity === "social_centre")
        return true;
      if (tags.tourism === "hotel" || tags.tourism === "hostel") return true; // otel-lobi barı
      return false;
    }
    // Gerçek bir barın adında NEREDEYSE HİÇ geçmeyen ama mis-tag'li spor/dernek
    // yerlerinde geçen kelimeler (tag sinyali yoksa son savunma). "Konak/bahçe" gibi
    // riskli kelimeler DIŞARIDA — yalnız açıkça bar-olmayan ibareler.
    const BAR_NAME_EXCLUDE =
      /(spor kul[üu]b|tenis|dernek|cemiyet|vak[ıi]f|spor merkez|fitness|spor salon|kültür merkez|hastane|üniversite|\bokulu\b)/i;
    // TomTom sonucu geldiyse OSM boru hattı (tag→Türkçe çeviri, blocklist, exclude)
    // ATLANIR: TomTom tarafı kendi kategori/alaka süzgecini zaten uyguladı.
    const places = ttRes
      ? ttRes.places
      : els
      .map((e) => {
        const plat = e.lat != null ? e.lat : e.center && e.center.lat;
        const plng = e.lon != null ? e.lon : e.center && e.center.lon;
        const name = e.tags && (e.tags["name:tr"] || e.tags.name);
        if (!name || plat == null || plng == null) return null;
        // Kategori: SADECE bilinen amenity/shop/leisure değerini Türkçeye çevir.
        // Ham İngilizce tag ("bar association", "fast_food") kullanıcıya GÖSTERİLMEZ;
        // haritada olmayan (beklenmedik/alakasız) tag varsa POI listeden ELENİR.
        const tag =
          e.tags && (e.tags.amenity || e.tags.shop || e.tags.leisure);
        // Spesifik istek gerçekten bulunduysa etiketi o türe sabitle ("suşi/japon");
        // yoksa bilinen OSM kategorisini Türkçeye çevir. Bilinmeyen tag = ELE.
        const kindTr = forceKind || (tag && KIND_TR[tag]);
        if (!kindTr) return null; // tanınmayan/alakasız kategori → gösterme
        if (NAME_BLOCKLIST.test(String(name))) return null; // baro/hukuk kurumu → ele
        // Spesifik et/kebap/döner/köfte/ızgara isteğinde çiğköfte zincirleri (Komagene
        // vb.) alakasız → ele. Yalnız çiğköfte'nin KENDİSİ istenmedikçe uygulanır.
        if (
          rule &&
          rule.label !== "çiğ köfte" &&
          CIGKOFTE_CHAINS.test(String(name))
        )
          return null;
        // BAR aramasında içki mekanı OLMAYAN yerleri ele (spor/dernek/otel).
        if (typeKey === "bar") {
          if (isNonDrinkVenue(e.tags)) return null;
          if (BAR_NAME_EXCLUDE.test(String(name))) return null;
        }
        // "başka öner" akışı: daha önce gösterilen mekanları tekrar döndürme.
        if (excludeSet.size && excludeSet.has(String(name).toLowerCase().trim()))
          return null;
        const phone =
          (e.tags &&
            (e.tags["contact:phone"] ||
              e.tags.phone ||
              e.tags["contact:mobile"])) ||
          "";
        return {
          name: String(name).slice(0, 60),
          kind: kindTr,
          phone: String(phone).slice(0, 30),
          lat: plat,
          lng: plng,
          dist: Math.round(haversine(lat, lng, plat, plng)),
        };
      })
      .filter(Boolean)
      .filter((p) => {
        const k = p.name.toLowerCase();
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 12);

    // HAK TÜKETİMİ: yalnızca GERÇEK sonuç döndüyse say (boş/başarısız sorgu hak yakmaz).
    if (places.length) {
      try {
        await adminDb.runTransaction(async (tx) => {
          const s = await tx.get(ref);
          const c = s.exists ? s.data().count || 0 : 0;
          tx.set(
            ref,
            {
              uid,
              date: today,
              count: c + 1,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        });
      } catch (e) {
        console.error("locUsage increment error:", e.message);
      }
    }

    // Merci yorumu (ucuz Haiku). Sonuç varsa listeden öner; YOKSA en yakın iyi semti öner.
    // ⚠️ skipComment: /merci'nin `mekan_ara` ARACI bu ucu çağırdığında yorumu ASIL
    // model kendisi yazar (mekanları görerek, sohbet bağlamıyla) → burada ikinci bir
    // Haiku çağrısı yapmak hem gereksiz maliyet hem "iki ayrı ses" demek olurdu.
    let merciComment = "";
    if (skipComment) {
      return res.json({
        places,
        isPro,
        broadened,
        matched: ttRes ? ttTerm : rule ? rule.label : "",
      });
    }
    const wantsDifferent = excludeSet.size > 0; // "başka öner / beğenmedim" akışı
    const typeLabel =
      ({ food: "yemek", cafe: "kafe", dessert: "tatlı", bar: "bar/bira", activity: "aktivite" })[
        typeKey
      ] || typeKey;
    try {
      if (places.length && broadened) {
        // DÜRÜST GENİŞLETME: kullanıcı spesifik bir şey istedi (rule.label) ama o tür
        // civarda çıkmadı → uydurmadan, "tam onu bulamadım, en yakın alternatifler"
        // de. Haiku'ya gerek yok, hallüsinasyon riskini sıfırla (deterministik).
        const near = places
          .slice(0, 3)
          .map((p) => p.name)
          .join(", ");
        // ⚠️ `rule` TomTom yolunda NULL olabilir (tablo hiç çalışmadı) → etiketi
        // aranan terimden al, yoksa jenerik bucket adına düş. rule.label'a doğrudan
        // dokunmak TomTom açıkken çökme sebebiydi.
        const wantedLabel = (ttRes ? ttTerm : rule && rule.label) || typeLabel;
        merciComment =
          `Tam olarak "${wantedLabel}" çıkmadı buralarda 🐙 Ama en yakın ${typeLabel} yerleri şunlar: ${near}. Beğenirsen aşağıdan bak 👇`;
      } else if (places.length) {
        // AÇIK/KAPALI bilgisi TomTom'dan ek ücretsiz geliyor (kapsama ~%67).
        // Kullanıcının asıl şikayeti "açık mekanlar var ama önermedi" idi →
        // modele veriyoruz ki açık olanı öne çıkarabilsin. Bilgi yoksa hiçbir
        // şey yazma (null) — "kapalı" diye YANLIŞ varsayma.
        const top = places
          .slice(0, 6)
          .map(
            (p) =>
              `${p.name} (${p.dist}m` +
              (p.open === true ? ", ŞU AN AÇIK" : p.open === false ? ", şu an kapalı" : "") +
              ")",
          )
          .join(", ");
        const cr = await anthropic.messages.create(
          {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 160,
          system:
            "Sen Merci, sevimli bir karar-ahtapotu. Sana kullanıcıya EN YAKIN GERÇEK mekanların listesi (isim + mesafe) verilir. " +
            "KISA (1-2 cümle), samimi, Türkçe ve TUTARLI tekil 'sen' diliyle (asla 'siz') bir öneri yap: birini öne çıkar, GERÇEK mesafeye değin (uzaksa dürüstçe söyle, örn. '~3 km, taksiyle kısa'), oyunbaz ol. " +
            "Mekanlar mahallende değil komşu semtte olabilir — bu normal, listedeki gerçek mesafeyi kullan. Listedeki isimler/mesafeler DIŞINDA hiçbir mekan/semt/mesafe UYDURMA. En fazla 1 emoji. " +
            "DÜRÜSTLÜK: Sana yalnız mekan ADI + MESAFE verildi; menü/içki/fiyat bilgisi YOK. Mekan kartlarında da SADECE isim + 'yol tarifi' butonu var — menü/içki listesi/fiyat YAZMAZ. Bu yüzden 'kartlarda yazıyor', 'listesinde görürsün', 'menüde var' DEME ve bir mekânda belirli bir şeyin (rakı, spesifik yemek) bulunduğunu GARANTİ ETME ('kesin vardır' YASAK). Gerekiyorsa 'meyhane/balık lokantası genelde bulundurur, emin olmak istersen mekânı arayabilirsin' gibi temkinli konuş. " +
            // ⚠️ 2 AĞU — ASIL BUG BURADAYDI. Kullanıcının ham isteği ("simit") bu
            // modele HİÇ verilmiyordu; sadece bucket etiketi ("yemek") gidiyordu.
            // Sonuç: kullanıcı simit sordu, model listedeki Çiğ Köfteci'yi coşkuyla
            // önerdi çünkü neyin istendiğini bilmiyordu. Artık ham istek veriliyor;
            // eşleşme yoksa UYDURMAK yerine dürüstçe söylemesi isteniyor.
            "EŞLEŞME KONTROLÜ (ÖNEMLİ): Kullanıcının ASIL isteği sana ayrıca verilir. " +
            "Önce listedeki mekanların o isteğe UYUP UYMADIĞINA bak. Uymuyorsa (ör. kullanıcı simit " +
            "istedi ama listede çiğ köfteci/burgerci var) o mekanları İSTENEN ŞEYMİŞ GİBİ SUNMA. " +
            "Bunun yerine tek cümleyle dürüstçe söyle ve alternatif olarak sun: " +
            "\"Tam simitçi çıkmadı buralarda 🐙 En yakın yeme-içme yerleri şunlar.\" " +
            "İsteğe uyan yerler VARSA normal, coşkulu önerini yap.",
          messages: [
            {
              role: "user",
              content:
                (locName ? "Kullanıcı " + locName + " civarında.\n" : "") +
                (wantsDifferent
                  ? "Kullanıcı öncekileri beğenmedi, bunlar FARKLI/yeni yerler — 'işte başka seçenekler' tonuyla sun.\n"
                  : "") +
                (query ? 'Kullanıcının ASIL isteği: "' + query + '"\n' : "") +
                "Arama türü: " + (ttRes ? ttTerm : rule ? rule.label : typeLabel) +
                (ttRes || rule
                  ? ""
                  : "\n(NOT: Bu istek için özel bir tür daraltması YAPILAMADI — aşağıdaki liste " +
                    "sadece EN YAKIN yeme-içme yerleridir, istenen şeye göre filtrelenmemiştir. " +
                    "Uyup uymadığını sen değerlendir.)") +
                "\nEn yakın gerçek mekanlar (isim + mesafe): " + top,
            },
          ],
          },
          { timeout: ANTHROPIC_TIMEOUT_SHORT }, // yorum gecikirse kartlar yine de gitsin
        );
        cr.content.forEach((b) => {
          if (b.type === "text") merciComment += b.text;
        });
      } else if (wantsDifferent) {
        // "başka öner" istendi ama exclude sonrası (geniş yarıçapta) yeni yer kalmadı.
        // Dürüstçe söyle, uydurma; başka türe/çarka yönlendir.
        merciComment =
          `Buralarda gösterebileceğim başka ${rule ? '"' + rule.label + '"' : typeLabel} kalmadı 🐙 İstersen başka bir tür deneyelim ya da çarkı çevirip şansına bırak!`;
      } else {
        // 25km'ye kadar bakıldı ve HİÇ gerçek mekan çıkmadı (çok nadir). Gerçek veri
        // olmadan semt/mekan UYDURMAK yasak → yer ismi verme; başka tür ya da çarka
        // yönlendir. (Gerçek mekan bulunduğunda uzak da olsa yukarıdaki dal kartları döndürür.)
        merciComment =
          `Bu civarda ${rule ? '"' + rule.label + '"' : typeLabel} pek çıkmadı 🐙 Başka bir tür dene — kafe, yemek ya da aktivite gibi — ya da çarkı çevir, ne çıkarsa o!`;
      }
    } catch (e) {
      // Yorum ÜRETİLEMESE BİLE mekan kartları gider (asıl değer onlar) → 5xx DÖNME.
      // Timeout'ta sessiz kalma: kısa, uydurmasız bir cümleyle kartlara yönlendir.
      if (isAnthropicTimeout(e)) {
        console.error("ANTHROPIC TIMEOUT (/nearby yorum):", e.message);
      } else {
        console.error("Nearby Merci comment error:", e.message);
      }
      if (!merciComment && places.length) {
        merciComment = "En yakınları çıkardım, aşağıdan bak 👇";
      }
    }

    res.json({
      places,
      merciComment: merciComment.trim(),
      isPro,
      broadened, // spesifik tür bulunamadı, alternatif gösterildi mi (client bilgilendirme)
      matched: rule ? rule.label : "", // eşleşen spesifik tür etiketi (varsa)
    });
  } catch (e) {
    console.error("Nearby Error:", e.message);
    res.status(500).json({ error: "Konum önerisi alınamadı, tekrar dene." });
  }
});

// ── REVENUECAT WEBHOOK → Firestore isPro ──
// RC, satın alma/yenileme/iptal/bitiş olaylarını buraya POST eder. appUserID =
// Firebase UID olarak configure ettiğimiz için event.app_user_id = users doc id.
// Doğrulama: RC panelinde ayarlanan Authorization header değeri ile karşılaştırılır.
const RC_WEBHOOK_SECRET = process.env.RC_WEBHOOK_SECRET;

app.post("/rc-webhook", async (req, res) => {
  try {
    if (!RC_WEBHOOK_SECRET || req.headers.authorization !== RC_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const event = req.body && req.body.event;
    if (!event) return res.status(400).json({ error: "no event" });

    const uid = event.app_user_id;
    const type = event.type;
    if (!uid || String(uid).startsWith("$RCAnonymousID:")) {
      return res.status(200).json({ ok: true, skipped: "anon" });
    }

    // Erişim ver: ilk alım, yenileme, iptal-geri-alma, ürün değişimi, tek seferlik,
    // süre uzatma. Erişimi kaldır: yalnızca süre BİTİNCE (EXPIRATION).
    // CANCELLATION = yenileme kapandı ama süre sonuna kadar PRO devam → değişme.
    const GRANT = [
      "INITIAL_PURCHASE",
      "RENEWAL",
      "UNCANCELLATION",
      "NON_RENEWING_PURCHASE",
      "PRODUCT_CHANGE",
      "SUBSCRIPTION_EXTENDED",
    ];
    const REVOKE = ["EXPIRATION"];

    let isPro;
    if (GRANT.includes(type)) isPro = true;
    else if (REVOKE.includes(type)) isPro = false;
    else return res.status(200).json({ ok: true, ignored: type });

    // ⚠️ SIZINTI KAPATMA: isPro tek başına webhook'a bağımlıydı → EXPIRATION
    // event'i bir kez kaçarsa (RC retry tükenir, sunucu down, 500) isPro:true
    // SONSUZA KADAR kalıyordu. proExpiresAt = bağımsız son-kullanma tarihi:
    // webhook hiç gelmese bile okuyucular tarihe bakıp PRO'yu kendiliğinden düşürür.
    const expMs = Number(event.expiration_at_ms);
    const proExpiresAt =
      isPro && Number.isFinite(expMs) && expMs > 0
        ? Timestamp.fromMillis(expMs)
        : null;

    await adminDb
      .collection("users")
      .doc(uid)
      .set(
        {
          isPro,
          // REVOKE'ta null → "tarih bilinmiyor" değil, isPro:false zaten kesin.
          // GRANT'ta tarih yoksa (ömür boyu / tek seferlik ürün) null → süresiz.
          proExpiresAt,
          proUpdatedAt: FieldValue.serverTimestamp(),
          proSource: "revenuecat",
          proLastEvent: type,
        },
        { merge: true },
      );
    return res.status(200).json({
      ok: true,
      uid,
      isPro,
      proExpiresAt: proExpiresAt ? proExpiresAt.toMillis() : null,
    });
  } catch (e) {
    console.error("RC Webhook Error:", e.message);
    return res.status(500).json({ error: "webhook error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Karar Mercii ${PORT} portunda çalışıyor!`);
});

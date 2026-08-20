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
    // Sağlayıcı teşhis sayaçları (arama terimi İÇERMEZ, yalnız sayılar).
    // Hangi dalın patladığını tek bakışta söyler — bkz. _ttStats tanımı.
    tomtom: _ttStats,
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

// apple-app-site-association — iOS Universal Links (assetlinks.json'ın iOS karşılığı).
// ⚠️ NEDEN ÖNEMLİ: Android tarafında davet linki app-link ile uygulamada açılıyor,
// iOS'ta AÇILMIYORDU (bu dosya 404'tü) → paylaşılan oda linki Safari'de açılıp
// indirmeyi öldürüyordu. Büyümedeki "viral kaçak" tam olarak buydu.
// Android'deki handle_all_urls davranışını AYNALIYOR: tüm yollar uygulamaya gider.
// appID = <TeamID>.<BundleID>. Team 3W82BX76S7, bundle app.kararmercii.com.
// ⚠️ Apple bu dosyayı UZANTISIZ ve application/json olarak bekler; YÖNLENDİRME
// KABUL ETMEZ (301/302 = doğrulama başarısız). express.static'ten ÖNCE duruyor.
// ⚠️ Bu route TEK BAŞINA yetmez: uygulamada `com.apple.developer.associated-domains`
// entitlement'ı da olmalı (App.entitlements'a eklendi) ve YENİ BUILD gerekir —
// native değişiklik mevcut TestFlight sürümüne yansımaz.
// ⚠️ 18 AĞU — "TÜM YOLLAR" DARALTILDI.
// Eskiden burada tek bir `"/": "*"` vardı: uygulama kuruluysa kararmercii.com'a
// giden HER link tarayıcı yerine uygulamayı açıyordu. Kullanıcı App Store ürün
// sayfasındaki "Gizlilik Politikası" bağlantısına dokununca politika yerine
// uygulamanın açıldığını fark etti.
// 🔴 NEDEN ÖNEMLİ: Apple gizlilik politikası bağlantısının POLİTİKAYI
// göstermesini bekler; incelemeci oraya dokunup uygulamaya düşerse uyum sorunu
// olur. Aynı şekilde /indir sayfası da uygulamayı açarsa "indir" akışı anlamsız
// hale gelir ve yeni kullanıcıya gösterilmesi gereken mağaza bağlantıları
// gösterilemez.
// ⭐ Uygulamada AÇILMASI GEREKEN tek şey oda davet linkleri (kök + ?room=).
// Aşağıdaki `exclude` girdileri SIRAYLA değerlendirilir: önce hariç tutulanlar,
// sonra genel kural. Sıra bozulursa hariç tutma çalışmaz.
// ⚠️ iOS bu dosyayı Apple'ın CDN'i üzerinden önbellekler → değişiklik mevcut
// kurulumlarda ANINDA geçerli olmaz; yeni kurulumda/güncellemede devreye girer.
const _AASA_EXCLUDE = [
  "/privacy.html", // App Store ürün sayfasındaki gizlilik bağlantısı
  "/terms.html",
  "/delete-account.html", // Apple 5.1.1(v) — web sayfası olarak da erişilebilir kalmalı
  "/indir", // akıllı indirme linki: mağazaya götürmeli, uygulamaya değil
  "/download",
  "/app-ads.txt",
  "/admin.html",
];
const _AASA = {
  applinks: {
    apps: [],
    details: [
      {
        appIDs: ["3W82BX76S7.app.kararmercii.com"],
        components: [
          ..._AASA_EXCLUDE.map((p) => ({
            "/": p,
            exclude: true,
            comment: "tarayicida acilmali - uygulamaya YONLENDIRME",
          })),
          { "/": "*", comment: "kalan tum yollar - Android app-link ile ayni" },
        ],
      },
      // Eski iOS sürümleri için geriye dönük biçim (components'i anlamayanlar).
      // ⚠️ Bu biçim `exclude` DESTEKLEMEZ; NOT ile başlayan yollar hariç tutulur.
      {
        appID: "3W82BX76S7.app.kararmercii.com",
        paths: [..._AASA_EXCLUDE.map((p) => "NOT " + p), "*"],
      },
    ],
  },
};
function _sendAasa(req, res) {
  res.type("application/json").send(JSON.stringify(_AASA));
}
app.get("/.well-known/apple-app-site-association", _sendAasa);
// Kök kopya: bazı eski istemciler önce burayı dener. İkisi de aynı gövde.
app.get("/apple-app-site-association", _sendAasa);

// ── HESAP SİLME (Apple Kural 5.1.1(v)) ──────────────────────────────────────
// ⚠️ YAYIN ENGELİYDİ: hesap OLUŞTURULABİLEN uygulama, silmeyi de UYGULAMA İÇİNDEN
// başlatabilmek ZORUNDA. Bizde yalnız delete-account.html vardı ("bize e-posta
// atın") — Apple bunu düzenli reddediyor, web sayfasına yönlendirmek yetmiyor.
// Silinenler: users/{uid} · decisions/{uid}/history/** · aiUsage & locUsage
// sayaçları · Firebase Auth kaydı.
// ⚠️ ODALARA DOKUNULMUYOR: rooms/{kod} paylaşılan veri; host'un hesabını silmek
// odadaki DİĞER kişilerin oylamasını yok etmemeli. Süresi dolan odalar zaten
// autoCloseExpiredRooms ile kapanıyor.
async function _deleteSubcollection(ref, batchSize = 300) {
  for (;;) {
    const snap = await ref.limit(batchSize).get();
    if (snap.empty) return;
    const batch = adminDb.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < batchSize) return;
  }
}
app.post("/delete-account", rateLimit, async (req, res) => {
  // ── 1) KİMLİK (yalnız gerçek token hatası buraya düşer) ──
  let uid;
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Önce giriş yap." });
    const decoded = await getAuth().verifyIdToken(token);
    uid = decoded.uid;
  } catch (e) {
    console.error("DELETE-ACCOUNT AUTH FAIL:", e.message);
    return res
      .status(401)
      .json({ error: "Oturum doğrulanamadı, tekrar giriş yap." });
  }

  // ── 2) VERİ + AUTH SİLME (altyapı hatası ≠ oturum hatası: 503, "giriş yap" DEME) ──
  try {
    await _deleteSubcollection(
      adminDb.collection("decisions").doc(uid).collection("history"),
    );
    await adminDb.collection("decisions").doc(uid).delete();
    await adminDb.collection("users").doc(uid).delete();
    // Günlük sayaçlar `${uid}_${YYYY-MM-DD}` biçiminde → uid önekiyle tara.
    for (const col of ["aiUsage", "locUsage"]) {
      const snap = await adminDb
        .collection(col)
        .where(FieldPath.documentId(), ">=", uid + "_")
        .where(FieldPath.documentId(), "<", uid + "`")
        .get();
      if (!snap.empty) {
        const b = adminDb.batch();
        snap.docs.forEach((d) => b.delete(d.ref));
        await b.commit();
      }
    }
    // EN SON: Auth kaydı. Önce silinirse token geçersizleşir ve üstteki
    // Firestore temizliği yarım kalır.
    await getAuth().deleteUser(uid);
    console.log("Hesap silindi:", uid);
    return res.json({ ok: true });
  } catch (e) {
    console.error("DELETE-ACCOUNT FAIL:", e.code || "", e.message);
    return res
      .status(503)
      .json({ error: "Hesap şu an silinemedi, birazdan tekrar dene." });
  }
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
          "$1Karar Mercii'de oylama var — dokun, oyunu ver, kararı birlikte verelim.$2",
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

// ── /indir — TEK AKILLI İNDİRME LİNKİ (18 AĞU) ────────────────────────────
// SORUN: iki mağazada birden yayındayız ama paylaşım mecraları TEK link alıyor.
// Instagram hikâyesinde link etiketi bir tane, profil bio'su bir tane. App Store
// linki koyarsak Android kullanıcısı hiçbir yere gidemiyor, tersi de aynı —
// yani her paylaşımda kitlenin yarısını kaybediyorduk.
//
// ÇÖZÜM: kararmercii.com/indir → User-Agent'a bakıp doğru mağazaya 302.
// Masaüstünden açan iki seçeneği birden görür.
//
// NEDEN AYRI DOSYA DEĞİL DE ROUTE: km-deploy.sh yalnız index + server çeker;
// public/ altına dosya koymak ayrı bir curl adımı ister (sw.js ile aynı gerekçe).
//
// ⚠️ ÖNBELLEK: yanıt User-Agent'a göre DEĞİŞİYOR. Araya giren bir önbellek
// iPhone yanıtını Android kullanıcısına servis ederse link sessizce yanlış
// mağazaya götürür. Bu yüzden no-store + Vary zorunlu.
const APPSTORE_URL = "https://apps.apple.com/tr/app/id6797318526";
const PLAY_URL =
  "https://play.google.com/store/apps/details?id=app.kararmercii.com";

const INDIR_HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#5b21b6">
<title>Karar Mercii'yi indir — App Store ve Google Play</title>
<meta name="description" content="Kararı Merci'ye bırak. Çark, oylama, masa modu, çekiliş ve Merci AI ile grup kararları saniyeler içinde verilsin. iOS ve Android'de ücretsiz.">
<meta property="og:type" content="website">
<meta property="og:title" content="Karar Mercii'yi indir — App Store ve Google Play">
<meta property="og:description" content="Kararı Merci'ye bırak. Çark, oylama, masa modu, çekiliş ve Merci AI ile grup kararları saniyeler içinde verilsin. iOS ve Android'de ücretsiz.">
<meta property="og:site_name" content="Karar Mercii">
<meta name="robots" content="index,follow">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{
  min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;
  color:#fff;
  background:#4c1d95;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:48px 24px;
  position:relative;overflow-x:hidden;
  -webkit-font-smoothing:antialiased;
}
/* ── arka plan katmanları ── */
.bg{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.bg::before{
  content:"";position:absolute;inset:0;
  background:
    radial-gradient(1100px 780px at 50% -8%, #a855f7 0%, rgba(168,85,247,0) 62%),
    radial-gradient(900px 700px at 88% 106%, rgba(124,58,237,.75) 0%, rgba(124,58,237,0) 60%),
    radial-gradient(700px 600px at 6% 88%, rgba(109,40,217,.7) 0%, rgba(109,40,217,0) 62%),
    linear-gradient(165deg,#6d28d9 0%,#5b21b6 46%,#4c1d95 100%);
}
.bg::after{
  content:"";position:absolute;left:50%;top:-14%;width:min(1300px,140vw);height:min(1300px,140vw);
  transform:translateX(-50%);border-radius:50%;
  background:radial-gradient(circle,rgba(255,255,255,.14) 0%,rgba(255,255,255,0) 62%);
}
.cf{position:absolute;border-radius:2px;opacity:.55}

/* ── kart ── */
.card{
  position:relative;z-index:1;width:100%;max-width:1060px;
  background:linear-gradient(150deg,rgba(255,255,255,.13),rgba(255,255,255,.05));
  border:1px solid rgba(255,255,255,.18);
  border-radius:34px;
  box-shadow:0 2px 0 rgba(255,255,255,.14) inset,0 30px 60px -20px rgba(30,10,70,.55),0 60px 120px -40px rgba(20,6,50,.6);
  backdrop-filter:blur(18px) saturate(130%);
  -webkit-backdrop-filter:blur(18px) saturate(130%);
  padding:52px 60px;
  display:flex;align-items:center;gap:48px;
}
.copy{flex:1 1 560px;min-width:0}

/* ── maskot ── */
.hero{flex:0 0 344px;display:flex;align-items:center;justify-content:center;position:relative}
.well{
  position:absolute;width:330px;height:330px;border-radius:50%;
  background:radial-gradient(circle,rgba(43,13,102,.86) 0%,rgba(48,16,112,.62) 46%,rgba(60,22,130,.28) 66%,rgba(76,29,149,0) 78%);
}
.halo{
  position:absolute;width:250px;height:250px;border-radius:50%;
  background:radial-gradient(circle,rgba(196,181,253,.30) 0%,rgba(168,85,247,.14) 48%,rgba(168,85,247,0) 72%);
  animation:breathe 6s ease-in-out infinite;
}
.ring{
  position:absolute;width:264px;height:264px;border-radius:50%;
  border:1px solid rgba(255,255,255,.22);
}
.ring2{
  position:absolute;width:322px;height:322px;border-radius:50%;
  border:1px dashed rgba(255,255,255,.13);
}
.merci{position:relative;width:340px;height:auto;display:block;animation:float 6s ease-in-out infinite;filter:drop-shadow(0 26px 36px rgba(24,7,58,.6))}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}
@keyframes breathe{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(1.07);opacity:1}}

/* ── metin ── */
.pill{
  display:inline-flex;align-items:center;gap:9px;
  padding:8px 18px 8px 14px;border-radius:999px;
  background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);
  font-size:12.5px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#f5f0ff;
}
.dot{width:8px;height:8px;border-radius:50%;background:#8ee6c8;box-shadow:0 0 0 4px rgba(142,230,200,.22)}
h1{
  margin:18px 0 0;font-size:58px;line-height:1.03;font-weight:900;letter-spacing:-1.6px;
  text-shadow:0 3px 0 rgba(43,15,102,.28);
}
.tag{margin-top:14px;font-size:22px;line-height:1.35;font-weight:600;color:#e9dffc}
.desc{margin-top:16px;font-size:16.5px;line-height:1.62;color:#ded3f7;max-width:52ch}

/* ── özellik çipleri ── */
.chips{display:flex;flex-wrap:wrap;gap:9px;margin-top:24px}
.chip{
  display:inline-flex;align-items:center;gap:7px;
  padding:8px 14px;border-radius:999px;
  background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.16);
  font-size:14px;font-weight:600;color:#f2ebff;white-space:nowrap;
}
.chip svg{width:15px;height:15px;flex:0 0 15px;color:#d9c9ff}

/* ── rozetler (yükseklik 56px, çevresinde >=14px temiz alan) ── */
.badges{display:flex;flex-wrap:wrap;align-items:center;gap:22px;margin:34px 0 0;padding:6px 0}
.badge{display:inline-block;line-height:0;border-radius:10px;transition:transform .18s ease,box-shadow .18s ease;outline-offset:6px}
.badge img{height:56px;width:auto;display:block}
.badge:hover{transform:translateY(-3px);box-shadow:0 14px 26px -10px rgba(15,4,40,.7)}
.badge:active{transform:scale(.97)}
.badge:focus-visible{outline:2px solid #ede9fe}

.meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;margin-top:22px;font-size:14px;color:#d2c4f0}
.meta b{color:#f0e9ff;font-weight:700}
.sep{width:4px;height:4px;border-radius:50%;background:rgba(255,255,255,.32)}
.try{color:#e6dbff;text-decoration:none;border-bottom:1px solid rgba(230,219,255,.4);padding-bottom:1px;font-weight:600;transition:color .16s ease,border-color .16s ease}
.try:hover{color:#fff;border-color:#fff}

.foot{position:relative;z-index:1;margin-top:26px;font-size:12.5px;letter-spacing:3px;font-weight:700;color:rgba(226,214,250,.62)}

/* ── dar ekran ── */
@media (max-width:900px){
  body{padding:36px 18px}
  .card{flex-direction:column;text-align:center;padding:40px 30px;gap:26px;border-radius:28px}
  .copy{flex:1 1 auto;width:100%}
  .hero{flex:0 0 auto;order:-1}
  .merci{width:216px}
  .well,.ring2{width:212px;height:212px}
  .halo{width:162px;height:162px}
  .ring{width:172px;height:172px}
  h1{font-size:42px;letter-spacing:-1.1px}
  .tag{font-size:19px}
  .desc{margin-left:auto;margin-right:auto}
  .chips,.badges,.meta{justify-content:center}
}
@media (max-width:430px){
  body{padding:26px 14px}
  .card{padding:32px 20px;border-radius:24px}
  .merci{width:182px}
  .well,.ring2{width:180px;height:180px}
  .halo{width:138px;height:138px}
  .ring{width:146px;height:146px}
  h1{font-size:34px}
  .tag{font-size:17px}
  .desc{font-size:15px}
  .badges{gap:16px;flex-direction:column;align-items:center}
  .badge img{height:52px}
  .chip{font-size:13px;padding:7px 12px}
  .meta{flex-direction:column;gap:9px}
  .sep{display:none}
}
@media (prefers-reduced-motion:reduce){
  .merci,.halo{animation:none}
}
</style>
</head>
<body>

<div class="bg" aria-hidden="true">
  <i class="cf" style="left:6%;top:12%;width:14px;height:8px;background:#f6b73c;transform:rotate(24deg)"></i>
  <i class="cf" style="left:13%;top:31%;width:10px;height:10px;background:#ffd76a;transform:rotate(-15deg)"></i>
  <i class="cf" style="left:5%;top:56%;width:12px;height:7px;background:#8ee6c8;transform:rotate(52deg)"></i>
  <i class="cf" style="left:10%;top:76%;width:15px;height:8px;background:#ff7eb6;transform:rotate(-38deg)"></i>
  <i class="cf" style="left:19%;top:88%;width:9px;height:9px;background:#ffffff;transform:rotate(18deg)"></i>
  <i class="cf" style="left:24%;top:8%;width:11px;height:7px;background:#c4b5fd;transform:rotate(-48deg)"></i>
  <i class="cf" style="left:31%;top:22%;width:8px;height:8px;background:#ffd76a;transform:rotate(31deg)"></i>
  <i class="cf" style="left:29%;top:96%;width:13px;height:7px;background:#f6b73c;transform:rotate(-22deg)"></i>
  <i class="cf" style="left:46%;top:6%;width:10px;height:10px;background:#ff7eb6;transform:rotate(44deg)"></i>
  <i class="cf" style="left:54%;top:95%;width:12px;height:7px;background:#8ee6c8;transform:rotate(-9deg)"></i>
  <i class="cf" style="left:62%;top:10%;width:9px;height:9px;background:#ffffff;transform:rotate(63deg)"></i>
  <i class="cf" style="left:69%;top:84%;width:14px;height:8px;background:#c4b5fd;transform:rotate(-33deg)"></i>
  <i class="cf" style="left:75%;top:18%;width:11px;height:7px;background:#ffd76a;transform:rotate(12deg)"></i>
  <i class="cf" style="left:81%;top:39%;width:10px;height:10px;background:#ff7eb6;transform:rotate(-55deg)"></i>
  <i class="cf" style="left:87%;top:63%;width:13px;height:8px;background:#f6b73c;transform:rotate(27deg)"></i>
  <i class="cf" style="left:89%;top:26%;width:9px;height:9px;background:#8ee6c8;transform:rotate(-17deg)"></i>
  <i class="cf" style="left:90%;top:80%;width:12px;height:7px;background:#ffffff;transform:rotate(41deg)"></i>
  <i class="cf" style="left:85%;top:6%;width:11px;height:7px;background:#c4b5fd;transform:rotate(-26deg)"></i>
</div>

<main class="card">
  <div class="copy">
    <span class="pill"><i class="dot"></i>App Store ve Google Play'de</span>
    <h1>Karar Mercii</h1>
    <p class="tag">Kararı Merci'ye bırak, tartışma bitsin.</p>
    <p class="desc">Nereye gidilecek, ne yenecek, hesabı kim ödeyecek? Seçenekleri yaz; çarkı döndür, oylama aç, çekiliş yap ya da Merci'ye sor.</p>

    <div class="chips">
      <span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/></svg>Çark</span>
      <span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 20V11M12 20V4M19 20v-6"/></svg>Oylama</span>
      <span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5V7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2.5a2.5 2.5 0 0 0 0 5V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2.5a2.5 2.5 0 0 0 0-5Z"/><path d="M14 6v12" stroke-dasharray="2 3"/></svg>Çekiliş</span>
      <span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 13.9 9 19.5 11 13.9 13 12 18.5 10.1 13 4.5 11 10.1 9Z"/><path d="M18.5 3.5v3M20 5h-3"/></svg>Merci AI</span>
    </div>

    <div class="badges">
      <a class="badge" href="https://apps.apple.com/tr/app/id6797318526" aria-label="App Store'dan indirin">
        <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAl4AAACgCAMAAADq+JL0AAAAflBMVEVMaXGmpqaoqKinp6eampqoqKienp6rq6umpqalpaWioqKkpKQAAAD///8CAgL8/Pz+/v4BAQGioqJPT0+ysrKmpqYMDAyPj4/BwcH29vYqKirt7e0VFRXi4uIfHx9DQ0M3NzfX19dzc3OAgICYmJjMzMyvr69XV1deXl5paWk2xvQQAAAADHRSTlMAotCGGuQ9/bH8XHhfyorGAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAgAElEQVR42u2dh3qjuhKAs2nEu6YIY4oL1WDz/i94ZtRpDnGJs3uk796zu4lo4mc0mqanp5H2+vr+++XXx/Pb29tisVibZtpoAzgAkeePXy+/31+f5rXX95ePt3UTNBaewfcXvmmmjTZAAxmxAJb128fLDMRe/zxbgQVcwkHYAtNMO9MoJJSXJrCe/5wH7PXlrbEWC6ux/ENUle3pdDyuTDNtoh2Pp1NbVtHBtxg3by9nAPv91qyho1+d8nTnkKVpps1pzi7NT5UPhK2Dt99TousXCC2riVapw44i0BzTTDvTkBHOWHqMKEC/RgXY63OwWARRFkJPepz5Kk2b15gUWi7DLEKGnkf4en9rfMs6hkviOGbATPs6YyCSluHRsvzg7X2MruawMXCZdoUOBoBtDgBSn6/XZ/hhtVsauEy7ToQtdxWg1JsfPwKgK1wauEy7VoItQ+Ar+NDpegG6op2hy7Rb8LWLgK8XTfECg8UhNXSZdhu+0gN4ipT69QGzZW7oMu1WfOUAlJwef4MsK42R3rTbKfglaFvCfP8BtgozNZp2y+kRbKgfUvNqWkOXabfk69QsuPb1Eiz8jcHLtFvitfEXbPH4+mxZ1dJoXqbdUvtaVpZFbavv60WTGeFl2m3FV9Ys1jg7/oG50Sj2pt1cuV8EfwAviPKKDFym3RqwCCK/AK9nqymN6mXarZWvsrGeQbN/WwdHMzeadmu8jsH67fXpHcILjUPItNvr9hC4+v70G1LOjNXLtNv7HSF16PfTH2ttFo6m3WPpuLb+PL1Y1sFEepl2F7xenn5RvMzK0bRbBxUeLOuXwcu0+6wcFV6hwevzLCueNmrGYiZeYcTxin4oXipF/OG3oSdb/SjEPh+hx4yhwOvjfnj9E1ltNPGThLt0k+ebdBcSls5n2mPxuvorhxuECizYTpvHSVeAy9kco6DYb5Nkuy+C6AglOH7KhwPWpRMdoXxyhJzVQ8bwrngRipYDL4JcMXSrxPZs23bthjyseMJyuVrsXRub59E/3L2fwd2RnyFZAxgez7WrCdMSaNgJvWm7/F7jE8Pr4x54EXyQtFwXxRX2WjjJwU5c2rYPciuAkMoDeD0uvw9sCbCWBJsfwRcYlwo6Rtt8Gq8tvet/By8Aw8kslDzJFVjQoXM9bN/+6clbcKrEhpfDxBZvHvzA3rZdZfkx+jM49gAuGJ8iJNN44Sj+O9KLYJqbh2/B3qfX4HW0+Xt17fgRwgJGaG1ztqTw8jhhdkQev9x2li2OkWv7U+NM8fL+ockRagyUW/pW4KO63F4LJaN82+Xywt4+IKYD7mDNAEeaZHP5j+xIIU+Wq6qs4H+n7y2LhvqDi+yc/i94OeqTB6HjXKNWbHHoPHam6tvxAiFc2QlHyds3FRSabasAXhZ7ONeV7xQ0bJ+95vpb8QJ2atTszygh/xheQBesZVw+px2umRtbKrzY1GTX3+51Z3oNo6s+cTFMYMVS2Pzj2cuX6jh0FZLA9/SdeEG6VwJ3Rz9j8n/AC07aCI3pnMyeIzwCipebgPwCUfHduUxk6ViMbzfB8SGilOhy57MnTHB65O+Z8Enqu/E6MtVrWrb/U3gRrgxwuq6wJ+CHaePIBQfP7bzK7zNY4gqR25TUwgIsek7EwFcrl4fhVTGrV/b/wAs+J9dVeK0vH2w2coBVufHsK1cJF95AySEKejZ6kGEx/9XxsXgtCUr4swv0fwkveJZCCi/4qFYXPxFMRai0ul6SLWv25kZORnjresDJ8pN+82IfSMDnxsGFwZ3gMnMc1S1pdXaJl16Ke17ARefmRqxnk8dydFzb6qheRO9+Fq/pm+oO2CVWvTvgJb54LryCa4RXxkYu3jExBqJweI8dbOTDD4sPj/f7ZLicgl13PyI28XcopunKeASv6YiLkYtqdzfyps8cC4PEZm+dHKI9HzmHl362wXV7yE+O7PdOjuFeCS87WV2zbozY+6qWqAPh/LgdzABE+6hwfMIctiHJcM+Hrglb+5zpL3bYL0+X/X49ybBnd1A4I7+kNHlgLMclADZf4hX2PnN6DWeTwfYoq3xHlgN3pXwKdNTiM2Q79Tu8Z7hf2HyHPxjpf81Uwjuaj5Q9X5bSw6fwcnjHE95VOIhuUSPLHHwZ3MBqQ/s9DC9cyHhKeEXX0MUNOlsYuTBmr65XIwqU/7jAVuc0rGHlFxDTAEENdZQTbbRAR6fdipjWvYbC63vWL6423dfVM7sJvIaDA9W12U5LGVzFoXexZU+e0CvtD0T/4MPVoYZrguECLhrlnXgLuNP1nh6DhuPNAZ5h60a8A63jXcVTxzrLBVW9lNEG+u/aQDxfSR94DC88yaYK6InhzEXTpvqnBoovu6cTHbET3AF0g37+ypnrPrkHXgtt2RhfcVLQbtiKu8YvCKybI44heBl7hiC+mCyWZMNxQa7NgTiFeFQBBphWhdYv8Sc900J6fe43BYndcUkytcBRdbhbdknU1ehvY3xHGl41e/0g61tOgs8mK3Sor1nQiDw2U8fCiy8oXr54CCz6vdWeb9+Go3iBUMubRPdB2NtIGwpnyYUxHpPR2/c81i/OZvJ1c7z44/IRviZYQjk7KjrGWzqKPccQwwuGB3/OPM9M4UalKCmlj5eZR5kDdHeg5naP94NRPU2q+Ez3YrZhZ0pVR7wKzentseiERrt4zX7qqYu6Wl4p4BUzPS6Dqc7DfgnHCyt4J+J+bX5sorK6YAC29FAh1mGkanUt2t1KR/CCE0eJdlOs6/4owUG8Eh5lUbq2dvM4svPe6x3wyvmnA3dRbK6iK2WCKcnxSxOzYzWCF5NePnUU0DHg36R9COWgU+s7jF/KHQqyG7h33GpSfK251wBf3xmdtoOX3cWLOG3CfRjSH44OzEJqSwwvlE55xntyvEDuBMK7Jg7GY+uNfLCW+szEZwcif2snIjQNnxHdCLtd0sMLRpef2FNeeoy7KJUUlNKrwptSA4v/msfXHfDC8D+E3LODqxJzoXQimxvpyswRa8e4s62DwmsDs6frcQeOCHAAodNx7uASEL5Jz+33m7B403tgXVBiLCdNGWcmR6p7u7pPnP0roTplD68V/sno9FGXXO5iCot2rEePFfMC4FXUdV1w6yJdbLuCcfZf6G31pdfEifHWlBjkeJ0yhjY/G+2sryS+F68W9L8E5SyUmb7KhkcaNfcLqQjjno3ita/oJGl72+024W9QW65L6VVUDEJX7wd3O16/Rej29FT7iq2axqSYU++hJVy1x7/vt0y1p4Ryr6W7BRQK6Q+391zkCLzs7UHKOSq9CPqkGE/utg6aeO8y0Zuoz0y3RrHwOC6T+TOidLarfQcvgsvehIouuNs4iGu4d3ZTnvCyMLzw2Jqyl8DZXBma1PvM74pXb52MErmuUragvjRvSziEPKZVE24l7zmGOF7olaRD1bTZJl+VscuFjpg0pGua9dsuaL+qdj3er9hN8MUDJuj72jYltReQIWEpNotHTNB/pDulGzG5ELcb3I8urwpxd3zlI/FyMajULtZRFQUVfp3MhAgDWpcbNJump9hjM1p/euL2U199DdEx3+THCD87Pl1qX1vOxRF11OP9HwOXx6X47FwcL89j9wRny7NTVIjoJPt4f7wI3/KRSIbgYy1iq1rtlkT7zMnXQzj50MIcw+5L/rvjGJJ40TVZnXFhEJ724g2ul0xD5njRfnHO++3KregXTeCFk4inZpukXiNiI5lCEFgozapL5UNYMp84fCZlyEwU6A8XVLOZiOPFfrRvU3plXJawh8OwMjYzw1ijpu9N+HJxfcxP7EYpJzc9iCWnJr04hsDSTrzEsKJxTyCmUv5FilA7uPdKDHq6FqEiixli4yq8uL1IYMQvF+52Dt/XDzfA3Ww2u5C+4a+5E5i08hL1wVFp1vMySby4cV9aAjdiyZfkbG4VgTVwgkWo+mV74ZneTPCFZ3KVyg5/gImozMOueZOeTbPa8+8NXUd4DEzqpyX3FSFh0h9OX5vEy2PLIWFg5YZb1yvVsUyXH/0g4IBAxC+12qxZquCokuO82zMFLwiJOvGB31TbxQvoOqoBc9Z9V/598MJhcnZZeYjrOj60eUgkQQSs1pgitIrQGgiJW3F03HwtcUs6hLZSPyF87eiPSy+q7SoPRs7kEp9MlfRiWoPqtxJRj+WUdr+pbemi9zhhIMWqPOw+0YhLG4ZEiIlIN/IS6Q+nV5V4MXWMKhVECq+uVcThvgxv6KiSq3Zuy9EP8HS8mCOJL8q1B93Ky2l4wfRYLjUTXiokanZPvJghulDWybjCKUd+MunR11ZToLdYq/ALgEmHUKCm3ZIN61YbViW9eu5uvtIUk6nSvTpDqoKH5CQ8ZsmLtgowmxmfkLBm1V3FDvFSr6ybZuEwJxeqPqhma3jpdk98YBYn0j1WuBL6gXTqmTt6N53g3R5eMbY6CpVrFFDg32/QwQvORjpegojj1d4PL8wDOsauMJqwb3obtNxR5uRRIX7p8T/QUk3mriW5Q6hrqYHZkfLVdj45MbtZIeksMVjcBtqSMNlH4NWPGVMATMaloXnbT7RlucwUStAxQM7i1Q6xkRH8Mn9A4NWRSISG/I7EgOMLTuxh6obDPWeDKBXQh/si2gmx7ZyRvAbhGZHSq//dZhzV6m54oeAOXMz8U+5FStD+cNykeRlv7c4v6ZIN+q/nRjPDpOUxH3aubI9hI78u0sNruJLhXxkfUoEX6BF5v996/AS9HO2qkIZRaVzEVDTtXsYmR59T1EuP5kY9eMZWwwu+ETJuVtZbqJxlZMRBNjQaSE/KxHJTBOFK3VHHqz8Jw1ohmdD9boUXjPdpa/cy/4QhL9km0kpn91ID7WJmsg/NnuWP2ku48nQ5o4a073/C+ceWC22JF9X/x1zwZ4OJWSgGun+54PKkKbJSitxIOKEI6IkH0WKaXqXhFemPm/G5MRw9drAaEXrk8MV3PzXlz+oEkcH/oxG8+jH81A97V7zgripuGhwS5I2zJYILt7OsvUq/KLUvl6vrOgjqNQU9LyvhgUFseBReh8HQb/jXuDjz/Ez7ILCSWdfbrgG+nY61J5joNPHCxeQfUKvAKF4t/3DyXtusuFjLenixz0/LXtJk5cj6RVoWHFjtp5tN3oziFfSJKQb3eku8YKgjW0/66yIkPVNjbSZfND3BZvFdWoA7m8dQ+CtvscBr+LAsDYTFYym8+gtENVyfJMxx2x0EXpXW1pZrfU9O30O8qAT1RuKIpD2MBdIovA46XhVXyLe9BpEx1LKaHHt40aiSkXxQdR+dlQNI5M2xjA4WWO3rAvwMrp6urPAiXel1Z7zoY7j2Rc1TnpDzyav8QypWWjtm7IE1h5dwCo3YFaTugCtN4RTykqGGJV5t7cyqo0WrsrS1bfcT7cbwWnGDwEgs9UFN6qN4ES0hZnwoe1JKnnJgkRoJJ8S1WR7V22REAvQnx2/FSzrRLmpgyjt8eh2HTyq2LUIgRNCI11u0SLy8dvgCuX0o0fAaiZ5l9WXGI1KnhVjYSnubiKAdw0voddnE3TEFagKvtXDwTLXOMxN5/f1uKKF7eGGNhsDtFDYQFr3H4qUMmRfR5SXRbgZeKlxfp0umTtbiHBKvgb4h9Vl0cmh4DV804ZPo3vlSpcKN9Bye7oSX9Yn06k65yrCwH67Pe3jBA9AaDa7Xq5vxA/BqrqDLTk7k09QOgCE+dw3NYqwmx3Zi+ulOjiPSi4hXWzgXBbZJJr44OXK8imm8+OQ+0L1ESy6eHMmSa8/aNOSCTsc6PRAvjOdyvcvpOs6w3Ms3NzYtCH2H9FT7gVmBf/3MbiPwGko5Gog8qXtNZ445arXfTOOVcZX6NFTt/Xm6FwZgbCZa941xc6s3NBCr1bGw2nP9BqNAYr8q22OGRT39ccPE9+FFiBNfLLzYyyVzs2cnFqa2nhim8PKHhgmBTWflWA2GXthAmlkRR8ueXUrZRMbwEq+1GmpDsTKBnls5zi8BgypFMpqdRaWop8XO7YSZdV+mjjQBLw+PxktEAFy4aqzmGb24c8Pe1oPG/Jie1HeUpXrXN0gL63KgxXtRUUP6i3Zv3EwIJ69oi8b8RcJJdQYvwqNYwRo/8D6n/CVZS93u1cHrJKTqVCOjtdBGshllsjnHS7iqIKaaqMrb5NF4iVTRC6fGOCSz8MpYEIsdObteCzOsBiPdrhpe24Gz56RiFTS8+vH/yg88or0d6dw2XjNS4TU5OS5llEe/egHejyel6QReOauPNp3bOaJTSGTHAnUYXoSrz2zM9HSl9YPxUsHBFwgve158tqZD5EN9Sgg27hCR69hk6Pht+JCeNLy8vhoEOSI18zm6+Yj02nsJD4siE3ly51R7ya7Xr+3DfwF2uNUUXoQLuGGg9sTaSHkCBt4iuQph/lfRr4MhkT9+IF6nK4SXPzO7ZFdMzwpdMa9HTHTXSzxeDK3qqR4x0Z9FRTTBWHkUmDd41IU38mH0w+/G8RL62br3wneFZkQYx0saGnr+LhiglczfHVku9FU9Ik00Aq90DBAVJPRAvC6fG+0knym8hFSoxt6pmABinga42WvhzKQfnIJTV6jHe/UzlUXuw+hoKYKGhevwjLanp9hKvGotYkJIhH4GipiRfT2csOsRlalSI84fdp2BGnniamRH7tM7nYPXQsR3PQgvsRq7THgFcxPHeSiUm4+VcxErri0PcpZGXmq4Z5H/hIUbsxSbUzdalS2sZD/QN3go16iAymRiTNqvIyLDrQMZ7zi0mitpW6dLGcsrRCvIxfwcXvpk52g1kbcsaHa4CJYrQno1ngUhs4cGk2Mc6qc9Ptpq7+Bq7OK5sZ05N4oog9g5Y7TgupYmvTBZgogg/zASGQd12o21xyCt41IEbu8smbQzWsmHV0e0adIrUWYwKNMro2RlfS+uM8rQ9K50jFOlkssIf8vRMoX68RyKTYhjUtfe0FLsw8g13QvO8mxpxD5mbXdi7YVqD6dQMfQqQfKReGWXa14zy9tPBXj21FTuGNKkFwYDBRkGYIa7Yy1zC9tuIhrLN/Rz2i89yazA8Uo+cDU5p7rNSkR3QopBw1PdEhVEzYOXKQ0q4GvZiqyg/Ykd76RVwrOH+CQ2iRefLOCLKPm1iUiC6uYc9EurwRGQlQlchJuKl7TXDRMC2/1KnCI8yfTbB+LVXj431rMqCwqH0NjHqf+eO4bUyrFmeaC1H0XW3pbO71hmLzOn0LZmWbT1ITo0Wj9/KpFD5DkiZft1VWJlaL/wbAlNrtzrK1vUAlmDsaxdMmHaiIQbSBaEw0t/L/O0y04a7SAaDenmIELa4inLslUVsyuPZ+qobQCoPR6eMd6yogF1JyU5lelVPhShStP8hNfHMfQeild0OV5rZ57TSUinidQK9elFCi8YlBOGt3bS7PUlusJrFdAiADJ+9jz7oJ4d5NnG6tprUk/zcjNzGHGkdt/x74mi5fZBVg8cx4t9z64ojgPp7x47TffCfaOOqy7ChDWktlt65oJ8jzxzvGDxaz6vAfw4vC5eOM4su+sIg9C5xDBujWe+ROnSxokEJgGsQMA/YK2KgxYxAQckop/9aa0VB2MnPVFTIEn4jkKeUuO6STRC1GGRCEF2WosKDrSSltQBD6JKwiRemKfNU6zljkaMsGQ8M4AV1xe3x8aCFhyJdbzYEk3fCwIzIQrn4XgtLpdeX3AIoaowvQWHQ3twxVSLmNDzEREFPbJfj5jICy1am/arz6iFMNJQcUvmpWj1d+Am6ryrK9G9ozxP5oeLBZ0lA/SZzxQvmlQyb4rwZ0oGodrQA9cQ9Oo8JIkeXExV2MLPgVVLUgF2WPUm7uwpRAVtohXeYUV3TrRGjo4XzWkfwcvz7oKXdbn0mokXq8N1Zu8BnDCoFMD31wnI2R0SPXwp8VNt4tICctJG6wf5c9HZ/CWUkAtWCUvON+zAogz7fk5eW0vcnsyaPdW2p8V/9IrbUbyoe+Awknm98bd67IiHetj0HcOowYLF0y5VoCEmlrW6OsnBLu8IShjkEJ74tg8cL74LxFgwNP78Dnit7y69Ir7Jy2QBKTE78sATPd6LbsEm0nZhv0W9+KUe7xUeA9lvH+WfxQjRuOGiU2EJThS06XLo9ttBWRShbGrFL6E8YbNVB+8PnQxcVZ1wZAcTgBOvrucrb87Ug6UXwxouvH9RUa9FPKjvpWoY0hRUnKhPI5OjN8gUCos7ZQpdjpc3d+8XJztBeVtoZ9aZzor3Sbt4YeL45hT56/WhWqW9CqQaXrRfG63Xi0OJloxPI9BYuYNqDWWK6MaSsBvtCYOtRko4gykN0iMgyqLUd36l9XjTVXVogsCCiw62siX0scf3k8WeuxzuNwgCv8ILf3LHtPhvy8Yh2zEU+fnVPaG5tbWgblRRN6yeAdbfOWGnjBc/ydkx2ejwn9v79mK8/CuM9jfcVGZQ34tJr27J5G79ZF16Tfc7m4e2xL20N7iVtjO5SbgzuUQg+s1/qSiVzMEnM++4t8nkmU6QgRaGy+W99tX9RsPEPp2FF5mxn4GKd+oHQ7NiQsQZqf7eCYae6nf2vsisPcJV/NTIzyePPf/URFS4IjOrpQ2eb2w3CeL0eO0F+pCJfRLm7ThxCV6VfXks4T32mzoTa38Wr4s3d+Q7Vl21L/ctxPatdqsk5J4b1HwVr5N9eZx99NfjZdqd8cqvSBLa32G/KYPXP4XX5RET3cJJBi+D19jumfUV0arF7TeTNXj9Q3ipysMXa1/E4GXwmrWZ3gUFAG6+eGR4ee48vDAGz+D1k/HK7YtztO0v7ALjOPPx8pJBOY9JX6Zr8PrRk6O20+xFMYXpbd+umBy9z6UXTo1mcvzZePEtMS+uAkBjX5zPVxB5PnvDwNWRtvPcwnfBuh2/eTdug9fXigC0V8yOLLx7entOvfphdSc3mGk/Gq9rqntR/d49bM5fiOpJZ8IJL/SAzfeUmfYovGS5gsv5wq3Fzs5QDK/9TLyUz2zCPU0co2z9LXhdPTt2NiOc9PpGttq28ga+YmJE1l+DV3rd7DjLue3km7lEwOYSPDvhWG3GUrPSsjXq/N+C13VlJr5UKWdeuRMIAMWdMTAUbWRCpQnvWGbCTJB/C1554nlXCa/6fMQUbi3o++WctEiCspRtGAZJOtthPD/mlUI6Vmbw+kvwAlX5OuX+02ITTOLM3Ex3V7gu3csOjknGKsBl3uRejab9QLxkrvsVgRNkDl7EmS+9UEztt4sBkhBfGm33raHr75FefCO4i/Eql87yq3iRocGK0I0QBV74140zYrKAijK9IH/HWCp+MF5Xle+dIbxG8OKVGJy+y5vtjSp2TyWdUo4yM4cse6X6vuIyN+3b8YI3Z12R0fHpTNXBC0UQTR7c7Jb61omQeJiGuvTSpBLNkWEdOsKKJs9AkvYmdZbE8PVD8ZIVKC+sDj0bLxROQRDny9zawz5glszbBKqqeg8/yTTd6xQHPs2b3kC6KdRLiPcJIupEcVzRQoRtEESh09awn0VR7ow69lPxujwhzZuz356O1wZm4QwrRWL1jkQWs4eyHh4Nryl3DC+Ct8SLRGKJu02J3iesiAolUWjtW7TXQdneNdvgihazNK//Z+K1vLTG6qxstA5eEARY7mk1NIgaZPYrWqcRt06GtJKkLIT0AuIFXu62SkTBXcTLEnbXOPJY8S1aS9zw9UPx0mpJftGiOiskVpdeWH0oOOYZFNxghSYJbmwPpbuqLD8GHlZUE3h5UnoBPkXVlm3I8Go4XkAoHgYV5KDD0YivHyu9qLDwvl5fdd5WtB28PJB4hIksd0v5gTpBzFJKcEZ0h3jBxNmw9alDdLxomA9q976dzCypYtoj8ILNLL5s/Jq/p1BX96odtgusBUxQpyIUK3VZTWNaF2uIF8t5o793uni1S74p9y1Lqph2a7wuiZxwZ+o7fbwqXg8UlxOIF2wDhW5L6VIcw6uSGxB38NryKuRQooptp2Daz8RLbro0uln7RBz03NLjXbxE6fCW4wXqvtjPEf6xdcfwOo3ixav00F0DoaS8wevn4qWqFncnwISXp/UuznL8DK/c1XZV3WkrRw2v43m8iMHrp+OFb9Tr8qX7itz+r5K5S7XP8MoMXv8HvNCU6ar1IyuJXS+isqwiC+tvatt/90p0Xye9EtStSD9iwuD1b+GFfLWJLEIMM2Nd5XxvknCXHfa23Gfem66U/XW8UjB1NYTITVkMXv8mXnR3rthlFeXcfbPCMxBeLxHmrbLe8hrwtLb3fJfTebygSg/foZW6ghKD1z+KF75fZ3WoiyL2W0y+kIUhCQ3QCqGachzHi3LzlQiFT/BiG48dmAGLZl0avP5RvHhV7JSGvozUqsUdvGjlYedLJrVP8MpxvgV5SEhW2wavfxkvkaU6GgJK2DT5xfDQzyZHQrdlcgvLh+2+6lGX9gRensHrb8OL16cmZ4opk69WvdEjJhKFFywRcrabKvqk6cYc+7yxPYlXwfBKkh5eImLC1c2qa4PXX4HX8uYFLXXp5Q2kF3aIaMBXEmyQnkG817j0Oth8D0Q4cW2k1/8VL4hoyFar3GHllVarlO9BksLf2T3C+mFzqqIyg4CbfLXCkijwk9UqY/E60E/F89NzaR3YJeCo3MD1TXj9+lF4faF4oWNiav4KvH79LLzkViP6tiy6iqf2I5Ed5K97W7l0Ogx+aNo34XUwASqm3REvU0fGtJvjtTsYvEy7nxGA4vVC8TLqiGk3xiv119bL0x9r7ZvMP9Pugtefp9+LtWWqFJl2c7xya7H4/fS+WAS5wcu0W+OVBYvF+9Pr2zow+1WYdvOV4zFYv70+PT1bTWtWjqbdGq+ysZ6fnp5+NVZkhJdpt54dI6v5BXj9CRZm6Wja7ReOi+AP4PW+XjSmfrJpt9bsm8X6HfB6fbas0ihfpt1W9aos6xk0+6enF5gdjeXLtNtutglz453m0uwAAAGQSURBVAvS9fRuLZqTwcu0W+J1ahbWO8ULIwqNcm/aTRX7A0ZCs/a78YPSbHdo2s00L6cNfOs3x+vpo/Eb4xgy7Xb+RgBKCC+qfa0PZno07WZT41pqXmzx6DeRifoy7TaBhBFoWy9PWvsAviqz96FpN6ArrICuD50usK3Cj6qdye8y7do8wR3Q1TCLqmrvb/DDw8Zsb27aNXBByvIBQHp7f+q192dYS1rHcPn10hCmmcZ3RgyPYEMNhnTh/AjhhUGE2fLnKpOYZtp4LRuoTJlFyFB/ZuR8QeSXbzXRMXXkrpsiJ9o000YbIWJ3dCc9Rk0DAP0apQvN928NGCwavzrl6c7oYKbN1bl2aX6q/AbMp8Hb76fJ9vryBn2AMMs/RFXZno7H48o00yYa4HFqoRz4AYQW5ebt5fXpXHv982wFIMMgPa3BFphm2plGIbGQlyawnv+ch4utIV8+3qAzHLReL3zTTDvTFgCJBbCs3z5e3mfAxWTY+++XXx/Pb28LaGvTTBttSMfb2/PHr5ffE2j9ByzJ0RmTYseBAAAAAElFTkSuQmCC" alt="App Store'dan indirin" width="606" height="160">
      </a>
      <a class="badge" href="https://play.google.com/store/apps/details?id=app.kararmercii.com" aria-label="Google Play'den indirin">
        <img src="data:image/png;base64,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" alt="Google Play'den indirin" width="538" height="160">
      </a>
    </div>

    <div class="meta">
      <span><b>Ücretsiz</b> indir</span>
      <i class="sep"></i>
      <span>iPhone ve Android</span>
      <i class="sep"></i>
      <a class="try" href="/">Tarayıcıda dene</a>
    </div>
  </div>

  <div class="hero">
    <span class="well" aria-hidden="true"></span>
    <span class="halo" aria-hidden="true"></span>
    <span class="ring2" aria-hidden="true"></span>
    <span class="ring" aria-hidden="true"></span>
    <svg class="merci" viewBox="0 0 680 560" role="img" aria-label="Karar Mercii maskotu Merci">
      <defs>
        <radialGradient id="mhd" cx="42%" cy="32%" r="62%"><stop offset="0%" stop-color="#AFA9EC"/><stop offset="60%" stop-color="#7F77DD"/><stop offset="100%" stop-color="#534AB7"/></radialGradient>
        <radialGradient id="mbl" cx="50%" cy="35%" r="60%"><stop offset="0%" stop-color="#EEEDFE"/><stop offset="100%" stop-color="#CECBF6"/></radialGradient>
        <radialGradient id="mey" cx="38%" cy="35%" r="55%"><stop offset="0%" stop-color="#3C3489"/><stop offset="100%" stop-color="#26215C"/></radialGradient>
      </defs>
      <ellipse cx="340" cy="530" rx="135" ry="20" fill="#26215C" fill-opacity=".12"/>
      <path d="M255 360Q205 380 185 425Q170 460 188 495Q198 512 215 505Q222 488 210 468Q205 440 225 415Q245 392 262 378Z" fill="#7F77DD"/>
      <path d="M295 375Q270 410 262 450Q256 485 272 512Q284 527 298 516Q294 496 290 472Q292 442 305 410Q314 388 318 378Z" fill="#7F77DD"/>
      <path d="M385 375Q410 410 418 450Q424 485 408 512Q396 527 382 516Q386 496 390 472Q388 442 375 410Q366 388 362 378Z" fill="#7F77DD"/>
      <path d="M425 360Q475 380 495 425Q510 460 492 495Q482 512 465 505Q458 488 470 468Q475 440 455 415Q435 392 418 378Z" fill="#7F77DD"/>
      <path d="M220 268Q165 218 148 163Q138 126 162 116Q182 128 178 160Q182 193 228 253Z" fill="#7F77DD" stroke="#534AB7" stroke-width="1.5"/>
      <circle cx="152" cy="116" r="26" fill="#AFA9EC" stroke="#534AB7" stroke-width="2"/>
      <path d="M460 268Q515 218 532 163Q542 126 518 116Q498 128 502 160Q498 193 452 253Z" fill="#7F77DD" stroke="#534AB7" stroke-width="1.5"/>
      <circle cx="528" cy="116" r="26" fill="#AFA9EC" stroke="#534AB7" stroke-width="2"/>
      <ellipse cx="340" cy="265" rx="130" ry="135" fill="url(#mhd)"/>
      <ellipse cx="340" cy="300" rx="78" ry="80" fill="url(#mbl)" fill-opacity=".6"/>
      <ellipse cx="295" cy="200" rx="32" ry="22" fill="#EEEDFE" fill-opacity=".3"/>
      <path d="M278 380Q260 420 255 460Q252 495 268 518Q280 532 292 521Q288 500 286 478Q292 448 304 415Q312 392 305 380Z" fill="#534AB7"/>
      <path d="M340 392Q332 432 332 470Q332 505 348 525Q360 537 370 525Q364 503 360 480Q360 448 360 415Q360 392 350 382Z" fill="#534AB7"/>
      <path d="M402 380Q420 420 425 460Q428 495 412 518Q400 532 388 521Q392 500 394 478Q388 448 376 415Q368 392 375 380Z" fill="#534AB7"/>
      <ellipse cx="302" cy="255" rx="34" ry="38" fill="#fff"/>
      <ellipse cx="378" cy="255" rx="34" ry="38" fill="#fff"/>
      <circle cx="308" cy="262" r="20" fill="url(#mey)"/>
      <circle cx="372" cy="262" r="20" fill="url(#mey)"/>
      <circle cx="301" cy="253" r="7" fill="#fff"/>
      <circle cx="314" cy="268" r="3" fill="#fff" fill-opacity=".6"/>
      <circle cx="365" cy="253" r="7" fill="#fff"/>
      <circle cx="378" cy="268" r="3" fill="#fff" fill-opacity=".6"/>
      <path d="M305 305Q340 338 375 305Q368 325 340 332Q312 325 305 305Z" fill="#7c3aed" stroke="#26215C" stroke-width="2"/>
      <ellipse cx="278" cy="292" rx="16" ry="9" fill="#D4537E" fill-opacity=".22"/>
      <ellipse cx="402" cy="292" rx="16" ry="9" fill="#D4537E" fill-opacity=".22"/>
    </svg>
  </div>
</main>

<p class="foot">KARARMERCII.COM</p>

</body>
</html>`;

app.get(["/indir", "/download"], (req, res) => {
  const ua = String(req.headers["user-agent"] || "");
  res.set("Cache-Control", "no-store");
  res.set("Vary", "User-Agent");
  // Android kontrolü ÖNCE: bazı Android tarayıcı UA'ları uyumluluk için
  // "like Mac OS X" ya da "iPhone" ifadeleri taşıyabiliyor.
  if (/Android/i.test(ua)) return res.redirect(302, PLAY_URL);
  if (/iPhone|iPad|iPod/i.test(ua)) return res.redirect(302, APPSTORE_URL);
  // Masaüstü ve tanınmayan istemciler (ayrıca iPadOS — kendini Macintosh
  // gösterdiği için sunucudan ayırt edilemez): iki seçeneği birden göster.
  res.type("html").send(INDIR_HTML);
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
  lat, lng, type, query, auth, osmCuisine, osmShop, osmIsim, exclude, intentText,
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
      // ⭐ 20 AĞU — İKİ CANLI KUSURUN KAPANDIĞI YER:
      // exclude    = sohbette DAHA ÖNCE GÖSTERİLMİŞ mekan isimleri. Araç yolu bunu
      //              hiç göndermiyordu → ikinci öneri listesi birincinin aynısı
      //              çıkıyordu ("aynı mekanlar tekrar" kusuru). /nearby'nin exclude
      //              mantığı zaten vardı, sadece bu hat ona bağlı DEĞİLDİ.
      // intentText = kullanıcının KENDİ cümleleri (arama terimi DEĞİL). Modelin
      //              `arama` alanı genel isteklerde BOŞ kalıyor ("gece yemeği ve
      //              bira" → arama:"") ve /nearby'nin oturmalı/içkili sinyalleri
      //              yalnız `query`ye baktığı için niyet SUNUCUYA HİÇ ULAŞMIYORDU
      //              → en yakın büfe/çiğköfteci listeleniyordu.
      exclude: Array.isArray(exclude) ? exclude : [],
      intentText: intentText || "",
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
const { getMessaging } = require("firebase-admin/messaging");
const {
  getFirestore,
  FieldValue,
  Timestamp,
  // FieldPath: /delete-account'ta `${uid}_${tarih}` biçimli sayaç belgelerini
  // belge kimliğine göre aralık sorgusuyla bulmak için.
  FieldPath,
  // ⭐ AggregateField: /admin/stats sayaçları için. count()/sum() sunucu tarafında
  // hesaplanır; dokümanlar İNDİRİLMEZ. 1000 indeks girişi = 1 okuma → panelin
  // eski "koleksiyonu çek ve JS'te say" yöntemine göre ~1000 kat ucuz.
  AggregateField,
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
    // Kapatılıp bildirilmesi gereken oda kodları (push transaction DIŞINDA atılır)
    const kapananlar = [];
    for (const docSnap of snap.docs) {
      let bildirilecek = null;
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
          // ⚠️ Bildirimi bu tur BİZ göndereceğiz → /room/notify'ın tekrar
          // göndermesini engelle (aynı sonuç için ikinci bildirim gitmesin).
          notifiedAt: Date.now(),
        });
        bildirilecek = docSnap.id;
      });
      if (bildirilecek) kapananlar.push(bildirilecek);
    }
    // ⭐ 16 AĞU — EKSİK OLAN BUYDU: sunucu odayı kapatıyordu ama BİLDİRİM
    // GÖNDERMİYORDU. Host uygulamayı kapatıp gittiğinde oda closesAt ile burada
    // sessizce kapanıyor, katılımcılar sonuçtan haberdar olmuyordu.
    // ⚠️ Push transaction DIŞINDA: transaction yeniden denenebilir, içine yan
    // etki koyulursa aynı bildirim birden çok kez gidebilir.
    for (const code of kapananlar) await bildirOdaSonucu(code, "autoClose");
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
// Oda sonucu bildirimi — sunucu tarafındaki İKİ kapanış yolunun ORTAK ucu
// (autoCloseExpiredRooms + resolveStuckTiedRooms). Metin /room/notify ile
// BİREBİR aynı olmak zorunda: kullanıcı sonucu kimin kapattığına göre farklı
// bildirim görmemeli.
// ⚠️ KAZANANI YAZMA (2 Ağu kullanıcı kararı) — bildirim sonucu ele verirse
// uygulamayı açmaya gerek kalmıyor, kutlama anı kaçıyor.
// ⚠️ Çağrı transaction DIŞINDA olmalı: transaction yeniden denenebilir, içine
// yan etki koyulursa aynı bildirim birden çok kez gider.
async function bildirOdaSonucu(code, nereden) {
  try {
    const title = "Oylama sonuçlandı! 🐙";
    const body = "Kazananı görmek için dokun 👀";
    await sendPush({ topic: "oda_" + code, title, body, room: code });
    await logPush({
      title,
      body,
      topic: "oda_" + code,
      by: "server",
      kind: "result",
      ok: true,
    });
  } catch (e) {
    // Bildirim gitmezse oda yine de kapalı — akış bozulmaz.
    console.error(nereden + " push (" + code + "):", e.message);
  }
}

// ── ÇEVRİMİÇİ OYLAMA: ASILI KALMIŞ "BERABERLİK" ODALARI ────────────────────
// ⭐ 19 AĞU TESPİTİ — autoCloseExpiredRooms'un GÖREMEDİĞİ delik.
// Beraberlikte oda `status:"tied"` yazılır ve kazananı belirleyecek çarkı
// YALNIZ HOST döndürebilir (live-index.html: `if (shareCode && !amHost) return`
// — çark yalnız host'ta dönüp sonucu yayınlar). Host süre dolmadan uygulamayı
// kapattıysa çarkı çevirecek kimse KALMAZ → oda sonsuza kadar "tied" asılı
// kalır: kazanan yok, `notifiedAt` yok, bildirim YOK, kimse haber alamaz.
// autoCloseExpiredRooms bunu KURTARAMAZ, çünkü o yalnız `status=="open"` sorgular.
// Aynı delik oy verilmemiş odalarda da var: autoClose voterCount===0 görünce
// "tied" yazıp bırakıyor, o oda da orada asılı kalıyor.
// ⭐ Çözüm: süresi dolalı GRACE kadar olmuş "tied" odaları sunucu adil RASTGELE
// kazananla kapatır — çarkın yaptığının birebir aynısı (çark da tieItems
// içinden rastgele seçer), yani client davranışının portu.
// ⚠️⚠️ KOTA KURALI (17 Tem dersi): bu sorguya giren HER oda AYNI turda "tied"
// durumundan ÇIKARILMAK ZORUNDA. Çıkmayan bir oda her turda yeniden okunur ve
// sonsuza kadar okunmaya devam eder → firestore-kota-kaçağı geri gelir. Bu
// yüzden aşağıda hiçbir "atla, sonra bakarız" dalı YOK: aday listesi boş olsa
// bile oda kapatılır.
// ✅ Ek index GEREKMEZ: aynı (status ASC, closesAt ASC) bileşik index'i kullanır.
const TIE_GRACE_MS = 3 * 60 * 1000;
async function resolveStuckTiedRooms() {
  try {
    // GRACE payı: çarkı çeviren AÇIK bir client varsa sonucu o yazsın. Çark
    // saniyeler sürer; 3 dakika sonra hâlâ "tied" ise gerçekten kimse yok.
    const esik = Date.now() - TIE_GRACE_MS;
    const snap = await adminDb
      .collection("rooms")
      .where("status", "==", "tied")
      .where("closesAt", "<=", esik)
      .orderBy("closesAt")
      .limit(50)
      .get();
    const kapananlar = [];
    for (const docSnap of snap.docs) {
      let bildirilecek = null;
      await adminDb.runTransaction(async (tx) => {
        const fresh = await tx.get(docSnap.ref);
        if (!fresh.exists) return;
        const data = fresh.data();
        if (data.status !== "tied") return; // bu arada host çarkı çevirmiş
        const parts = data.participants || {};
        const adaylar =
          Array.isArray(data.tieItems) && data.tieItems.length
            ? data.tieItems
            : Array.isArray(data.options)
              ? data.options
              : [];
        const voterCount = Object.values(parts).filter(
          (p) => p && p.submitted === true,
        ).length;
        if (!adaylar.length) {
          // Aday yok → yazılacak kazanan da yok. Yine de "tied"den ÇIKAR:
          // bırakılırsa bu oda her turda tekrar okunur (kota kaçağı).
          tx.update(docSnap.ref, {
            status: "closed",
            tieItems: [],
            closedBy: "server-tie",
            closedAt: Date.now(),
            notifiedAt: Date.now(),
          });
          return;
        }
        const winner = adaylar[Math.floor(Math.random() * adaylar.length)];
        let winnerPoints = 0;
        Object.values(parts).forEach((p) => {
          if (p && p.submitted === true && p.votes)
            winnerPoints += +(p.votes[winner] || 0);
        });
        tx.update(docSnap.ref, {
          status: "closed",
          winner,
          winnerPoints,
          winnerVoters: voterCount,
          tieItems: [],
          // Çark durumu temizlenmeli, yoksa açılan client eski animasyonu oynatır.
          tbSpin: null,
          tbSeed: null,
          closedBy: "server-tie",
          closedAt: Date.now(),
          // Bildirimi bu tur BİZ göndereceğiz → /room/notify tekrar göndermesin.
          notifiedAt: Date.now(),
        });
        // Hiç oy verilmemiş odada haber verilecek kimse yok → push atma.
        // (Oda yine de kapandı; sorgudan düştü, kota güvende.)
        if (voterCount > 0) bildirilecek = docSnap.id;
      });
      if (bildirilecek) kapananlar.push(bildirilecek);
    }
    for (const code of kapananlar) await bildirOdaSonucu(code, "tieResolve");
  } catch (e) {
    if (String(e.code) === "9" || /FAILED_PRECONDITION|index/i.test(e.message)) {
      console.error(
        "resolveStuckTiedRooms: composite index EKSİK (rooms: status ASC, closesAt ASC).",
        "Beraberlik kurtarması devre dışı:",
        e.message,
      );
      return;
    }
    console.error("resolveStuckTiedRooms:", e.message);
  }
}

// ⚠️ 5 DAKİKA (eskiden 60sn). Süre-dolunca-kapanışın ASIL çözümü client tarafındaki
// deadlineClose (açık olan herhangi bir katılımcı kapatır); bu interval yalnız
// KİMSE açık değilken devreye giren yedek katman → sık dönmesi gereksiz.
// ⚠️ SIRA ÖNEMLİ: önce açık odalar kapanır (bir kısmı "tied" olabilir), sonra
// beraberlik kurtarması bakar. Yeni "tied" olanlar GRACE yüzünden bu turda
// zaten alınmaz — bir sonraki tura kalır, doğru davranış budur.
async function odaBakimTuru() {
  await autoCloseExpiredRooms();
  await resolveStuckTiedRooms();
}
setInterval(odaBakimTuru, 5 * 60 * 1000);
setTimeout(odaBakimTuru, 8000); // başlangıçta birikmiş süresi dolmuş odaları da kapat

// Günlük Merci mesaj limitleri (kullanıcı başına). Abuse/maliyet tavanı.
// MODEL (22 Tem): Pro OLMAYAN için ücretsiz günlük hak YOK — client'ta ödüllü reklam
// başına 4 mesaj (FREE_MSG_PER_DAY=0, AD_MSG_BONUS=4).
//
// ⭐ 17 AĞU — İKİSİ DE DÜŞÜRÜLDÜ (60→8, 300→60). Gerekçe, ölçülmüş maliyetle:
// Haiku 4.5 ($1/1M girdi, $5/1M çıktı) + ~8.000 karakterlik Türkçe sistem promptu
// (satır ~892) HER mesajda baştan gönderiliyor → mesaj başı ≈ $0,005. Konum soran
// mesaj araç döngüsü yüzünden ~2 katı.
//   • Ücretsiz 60: ~15 reklam izleyen kullanıcı günde 60 mesaj = ≈$0,30 maliyet,
//     karşılığında ~$0,015-0,06 reklam geliri → HER reklamda 5-20 kat ZARAR.
//     Üstelik reklam bonusu client'ta tutulduğu için (localStorage.kmTopicUsage)
//     hiç reklam izlemeden de 60'a kadar çıkılabiliyordu — bu tavan o sömürünün
//     de tek gerçek freni. 8 = 2 reklam × 4 mesaj (client AD_MAX_PER_DAY ile eşleşir).
//   • PRO 300: UI'da "günde 50 mesaj" deniyor, sunucu 300'e izin veriyordu → vaadin
//     6 katı kuyruk riski. 60, 50'lik vaade pay bırakır ama tavanı 5 kat daraltır.
// ⚠️ KULLANICIYA GÖRÜNEN "50" RAKAMI DEĞİŞMEDİ — mağaza metni, ekran görüntüleri ve
//    uygulama içi 15 metin AYNEN duruyor. Bu iki sabit hiçbir yerde gösterilmiyor.
// ⭐ 19 AĞU — 8 → 4. Sebep: reklam bonusu 4'ten 2'ye indi (live-index.html
// AD_MSG_BONUS). Bu tavan client'takiyle ÇARPIM OLARAK eşleşmek ZORUNDA:
//     FREE_DAILY_LIMIT = AD_MSG_BONUS × AD_MAX_PER_DAY  →  2 × 2 = 4
// Eşleşmezse iki yönlü bozulur: tavan DÜŞÜK kalırsa kullanıcı hak ettiği mesajı
// alamaz ve "reklam izledim ama çalışmıyor" der; YÜKSEK kalırsa client sayacı
// localStorage'da olduğu için (kurcalanabilir) bedava mesaj sızar.
// ⚠️ Bu iki dosya birlikte deploy edilmeli — biri gider diğeri kalırsa yukarıdaki
// iki arızadan biri CANLIDA oluşur.
// ⭐ 20 AĞU — 4 → 6. SIFIR PAY ARIZAYA DÖNÜŞTÜ (canlı, kullanıcı bildirdi).
// 4 = AD_MSG_BONUS(2) × AD_MAX_PER_DAY(2), yani tavan reklam hakkıyla TAM eşitti.
// Sonuç: modele giden ama cevap üretemeyen HER istek (timeout, API hatası, ağ)
// kullanıcının hakkından bir mesaj yiyordu ve kullanıcı karşılığında hiçbir şey
// almıyordu. İki reklam izleyip sıfır cevap alan kullanıcı gördük.
// 6 = 4 hak + 2 mesaj pay. Payı kasten client'ın üretebileceğinden YÜKSEK tuttuk;
// eski notun "yüksek kalırsa localStorage kurcalanıp bedava mesaj sızar" uyarısı
// hâlâ doğru ama sızıntının tavanı günde 2 mesaj ≈ $0,01 — arızanın maliyetinden
// (kullanıcının reklam izleyip eli boş kalması) kat kat ucuz.
// ⚠️ Ayrıca artık kota İADE ediliyor (bkz. kotaIade) → pay ikinci emniyet kemeri.
const FREE_DAILY_LIMIT = 6;
const PRO_DAILY_LIMIT = 60;

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
// ── ⭐ 19 AĞU — GLOBAL GÜNLÜK AI TAVANI (TAVAN DEĞİL, SİGORTA) ─────────────
// NEDEN VAR: kullanıcı BAŞINA kota vardı (FREE_DAILY_LIMIT / PRO_DAILY_LIMIT) ama
// TOPLAM harcamayı sınırlayan HİÇBİR ŞEY yoktu. AI maliyeti kullanıcı sayısıyla
// DOĞRUSAL büyür, reklam geliri aynı hızda gelmez → viral bir sıçrama, bir bot ya
// da bir döngü hatası faturayı saatler içinde uçurabilirdi. Bu bir "kısıtlama"
// değil sigorta: normal büyümede HİÇ ateşlenmeyecek kadar yüksek ayarlanır.
//
// ⚠️⚠️ PRO KULLANICI BU FRENDEN ETKİLENMEZ. Para vermiş kullanıcıyı bütçe tavanı
// yüzünden kesmek iade/şikayet sebebidir — hem de hacim riski zaten bedava
// katmanda (çok kullanıcı × reklamla açılan mesaj). Fren yalnız ücretsiz tarafta.
//
// ⚠️ ASIL İŞİ FATURAYI DURDURMAK DEĞİL, SANA ZAMAN KAZANDIRMAK: %50 ve %80'de
// yöneticiye bildirim gider (`user_<ADMIN_UID>` topic'i, altyapı zaten var).
// Tavanı yükseltirsin, kullanıcı hiçbir şey görmez. Fren ısırırsa da mesaj KOTA
// dili değil KAPASİTE dili kullanır: "hakkını kaybettin" hissi vermez.
//
// ⚠️ KOTA GÜVENLİĞİ (17 Tem dersi): sayaç HER İSTEKTE Firestore'dan OKUNMAZ — o
// da ayrı bir kaçak olurdu. Yazma artımlı (`increment`, okuma yapmaz), okuma
// 60 saniyede BİR → günde ~1440 okuma. Yeniden başlatmada sayaç Firestore'dan
// geri gelir, sigorta sıfırlanmaz.
//
// AYAR: Replit Secrets → `AI_GUNLUK_TAVAN` (deploy gerekmez, restart yeter).
// Varsayılan 2000 çağrı/gün ≈ mesaj başı ~$0,003 ile günde ~$6 tavan.
const AI_GUNLUK_TAVAN = Math.max(
  100,
  parseInt(process.env.AI_GUNLUK_TAVAN || "2000", 10) || 2000,
);
const AI_SAYAC_TTL_MS = 60 * 1000;
let _aiSayac = { gun: "", adet: 0, okunduAt: 0 };
let _aiUyari = { gun: "", gonderilen: {} };

function _bugunUTC() {
  return new Date().toISOString().slice(0, 10);
}

/* ⭐ 20 AĞU — İSTANBUL GÜNÜ (YYYY-MM-DD).
   Kullanıcı BAŞINA günlük mesaj kotası bunu kullanır ve live-index.html'deki
   `kmGunTR()` ile BİREBİR AYNI dizeyi üretmek zorundadır — ikisi ayrışırsa
   kullanıcı ödüllü reklamı izleyip karşılığını alamaz (bkz. oradaki uzun not).
   ⚠️ Global AI bütçe sayacı (`_bugunUTC`) BİLEREK UTC'de kaldı: o bir maliyet
      penceresi, istemciyle eşleşmesi gerekmiyor ve değiştirmek mevcut sayaçları
      gereksiz yere sıfırlardı. */
function gunTR() {
  try {
    return new Date().toLocaleDateString("en-CA", {
      timeZone: "Europe/Istanbul",
    });
  } catch (e) {
    return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  }
}

// Günlük toplam AI çağrısı. Firestore'dan en fazla 60 sn'de bir okur.
async function aiGunlukAdet() {
  const gun = _bugunUTC();
  if (_aiSayac.gun !== gun) _aiSayac = { gun, adet: 0, okunduAt: 0 };
  if (Date.now() - _aiSayac.okunduAt < AI_SAYAC_TTL_MS) return _aiSayac.adet;
  try {
    const snap = await adminDb.collection("apiUsage").doc("ai_" + gun).get();
    _aiSayac.adet = (snap.exists && snap.data().count) || 0;
    _aiSayac.okunduAt = Date.now();
  } catch (e) {
    // Okuyamadıysak SON BİLİNEN değerle devam et — sigorta yüzünden servis durmasın.
    _aiSayac.okunduAt = Date.now();
  }
  return _aiSayac.adet;
}

// Çağrıyı say (ateşle-unut). Yerel sayacı da artırır ki 60 sn içinde
// gelen yüzlerce istek bayat değeri görüp tavanı aşmasın.
function aiSay() {
  const gun = _bugunUTC();
  if (_aiSayac.gun !== gun) _aiSayac = { gun, adet: 0, okunduAt: Date.now() };
  _aiSayac.adet++;
  // Yazma ateşle-unut: sayaç yüzünden istek gecikmesin, hata da yutulsun.
  adminDb
    .collection("apiUsage")
    .doc("ai_" + gun)
    .set(
      { count: FieldValue.increment(1), date: gun, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    )
    .catch(() => {});
  _aiEsikUyar(gun, _aiSayac.adet);
}

// %50 / %80 / %100 eşiklerinde yöneticiye BİR KEZ bildirim.
// ⚠️ TAMAMI try/catch İÇİNDE: bu bir TEŞHİS yardımcısı, istek yolunda çağrılıyor.
// Burada atılan bir hata Merci'yi komple keserdi — uyarı mekanizması, koruduğu
// şeyden daha büyük bir arıza olamaz. (`ADMIN_UIDS` bu dosyada DAHA AŞAĞIDA
// tanımlı; çalışma anında sorun yok ama const'un TDZ'sine güvenmiyoruz.)
function _aiEsikUyar(gun, adet) {
  try {
    if (_aiUyari.gun !== gun) _aiUyari = { gun, gonderilen: {} };
    const oran = adet / AI_GUNLUK_TAVAN;
    const esik = oran >= 1 ? 100 : oran >= 0.8 ? 80 : oran >= 0.5 ? 50 : 0;
    if (!esik || _aiUyari.gonderilen[esik]) return;
    _aiUyari.gonderilen[esik] = true;
    console.log(`AI TAVAN UYARISI %${esik} — ${adet}/${AI_GUNLUK_TAVAN}`);
    const admin =
      typeof ADMIN_UIDS !== "undefined" && ADMIN_UIDS && ADMIN_UIDS[0];
    if (!admin) return;
    sendPush({
      topic: "user_" + admin,
      title: esik >= 100 ? "🛑 AI günlük tavan DOLDU" : `⚠️ AI kullanımı %${esik}`,
      body: `Bugün ${adet}/${AI_GUNLUK_TAVAN} çağrı. ${esik >= 100 ? "Ücretsiz kullanıcılara Merci kapandı." : "Tavanı yükseltmek istersen Secrets → AI_GUNLUK_TAVAN."}`,
    }).catch(() => {});
  } catch (e) {
    console.error("_aiEsikUyar:", e.message);
  }
}

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

    // ── 18 AĞU: TARAYICIDA ÜCRETSİZ AI YOK (PRO hariç) ──
    // Gerekçe: tarayıcıda hiçbir gelir kalemi çalışmıyor. AdMob native-only,
    // AdSense onayı da yok → web'de gösterilecek reklam YOK. Ücretsiz web
    // kullanıcısı günde 8 mesaj × ~$0,005 = ~$0,04 maliyet üretip karşılığında
    // sıfır gelir getiriyordu. Uygulamada en azından ödüllü reklam bir miktar
    // dönüyor ve kullanıcı elde kalıyor.
    // 429 seçildi (403 değil): istemci 429'u ZATEN paywall'a bağlıyor
    // (live-index.html ~18139) ve web paywall'ı "Uygulamayı İndir" butonu
    // gösteriyor → ekstra istemci kodu gerekmeden doğru akış çalışıyor.
    // ⚠️ `platform` istemciden geliyor, yani teorik olarak taklit edilebilir.
    // Sertleştirmiyoruz çünkü taklit edenin kazancı günde 8 mesaj (~$0,04) ile
    // ZATEN sınırlı; bu bir suistimal kalkanı değil, gelir/maliyet ayarı.
    const _plt = String((req.body && req.body.platform) || "web").toLowerCase();
    const nativeApp = _plt === "ios" || _plt === "android";
    if (!nativeApp && !isPro) {
      return res.status(429).json({
        error:
          "Merci uygulamada çalışıyor 📲 Uygulamayı indirip ücretsiz sorabilir ya da PRO ile tarayıcıdan da devam edebilirsin.",
        adHelps: false, // tarayıcıda ödüllü reklam altyapısı YOK
      });
    }

    // ── GLOBAL SİGORTA (yalnız ÜCRETSİZ katman) ──
    // PRO burada BİLEREK atlanır: ödediği hakkı bütçe tavanı yüzünden kesmek
    // iade sebebi. Ayrıca hacim riski ücretsiz tarafta.
    if (!isPro) {
      const toplam = await aiGunlukAdet();
      if (toplam >= AI_GUNLUK_TAVAN) {
        console.log("AI TAVAN DOLU — ucretsiz istek reddedildi:", toplam);
        // 429: istemci bunu ZATEN paywall'a bağlıyor (live-index.html), yani
        // kullanıcı "PRO ile devam et" yolunu görür — çıkmaz sokak değil.
        // ⚠️ Metin KAPASİTE dili: "hakkın doldu" DEME, kullanıcı kendi hakkını
        // kaybetmiş sanır ve haksız yere şikayet eder. Suç bizde, öyle söyle.
        return res.status(429).json({
          error:
            "Merci şu an çok yoğun 🐙 Birazdan tekrar dene — ya da PRO ile kesintisiz devam et.",
          limitReached: true,
          // Reklam bu duvarı açmaz (bütçe tavanı global) → istemci reklam
          // butonu basmasın.
          adHelps: false,
        });
      }
    }

    const limit = isPro ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT;

    // ⭐ 20 AĞU — UTC GÜNÜ → İSTANBUL GÜNÜ. Ayrıntılı gerekçe live-index.html
    // `kmGunTR` notunda: istemci yerel günü, sunucu UTC gününü kullanıyordu →
    // TR'de her gece 00:00–03:00 arasında istemci yeni güne geçiyor, sunucu hâlâ
    // dünde kalıyordu. Kullanıcı ödüllü reklamı İZLİYOR ama sunucu "günlük hak
    // doldu" deyip cevabı reddediyordu (canlıda yaşandı, 20 Ağu 02:40).
    // ⚠️ İSTEMCİYLE AYNI SABİT SAAT DİLİMİ (Europe/Istanbul) — biri değişirse
    //    diğeri de değişmeli, yoksa arıza aynen geri gelir.
    const today = gunTR();
    const usageRef = adminDb.collection("aiUsage").doc(`${uid}_${today}`);

    allowed = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(usageRef);
      const count = snap.exists ? snap.data().count || 0 : 0;
      // 20 AĞU: reddedersek istemciye KAÇ/KAÇ olduğunu söyleyeceğiz — "reklam
      // izle" yalanının yerine gerçek sebep gitsin (bkz. aşağıdaki 429).
      if (count >= limit) {
        req._kmKotaDolu = { used: count, limit };
        return false;
      }
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
    // Sayaç ARTTI → istek cevapsız biterse geri verilebilsin (bkz. kotaIade).
    if (allowed) req._kmKotaRef = usageRef;
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
    // ⭐ 20 AĞU — "REKLAM İZLE" YALANI KAPATILDI.
    // İstemci 429'u KOŞULSUZ paywall'a bağlıyordu ve paywall reklam butonu
    // basıyordu. Ama günlük tavan SUNUCUDA: reklam yalnız istemcinin
    // localStorage sayacını artırır, tavan yerinde kalır. Kullanıcı reklamı
    // izliyor, "+2 mesaj" yazısını görüyor, soru yine reddediliyordu — yani
    // izlettiğimiz reklamın karşılığını VEREMİYORDUK. adHelps:false bunu
    // istemciye açıkça söyler; istemci o durumda reklam butonunu HİÇ basmaz.
    const _kd = req._kmKotaDolu || {};
    console.log(
      "KOTA DOLU 429 — uid:", req._kmUid || "?",
      "used:", _kd.used, "limit:", _kd.limit,
    );
    return res.status(429).json({
      error:
        "Bugünkü Merci hakkın doldu 🐙 Gece yarısı yenilenir — beklemek istemezsen PRO ile günde 50 mesaj, reklamsız.",
      limitReached: true,
      adHelps: false,
      used: _kd.used,
      limit: _kd.limit,
    });
  }

  // Global sayaç: yalnız GERÇEKTEN modele gidecek istekler sayılır (kimlik, ban,
  // platform ve kullanıcı kotası engellerini geçenler). PRO da SAYILIR — sayaç
  // gerçek harcamayı göstermeli; PRO yalnız FRENDEN muaf, ölçümden değil.
  aiSay();

  req.uid = uid;
  req._kmUid = uid; // 429 loglarında kim olduğunu görmek için (teşhis)
  next();
}

// ⭐ 19 AĞU — PROMPT ÖNBELLEĞE ALINABİLİR HALE GETİRİLDİ (maliyet).
// SORUN: sistem promptu ~6.950 karakterdi ve HER İSTEKTE baştan gönderiliyordu.
// Önbelleğe alınabilirdi AMA alınamıyordu: prompt DİNAMİKTİ — grup sayısı,
// saat, geçmiş analizi, konum ve sonuç bağlamı metnin ORTASINA gömülüydü.
// Prompt önbelleği ÖNEK (prefix) eşleşmesiyle çalışır: ilk değişen karakterden
// sonrası hiç önbelleğe girmez. Yani caching'i açsak neredeyse tamamı ıskalardı.
// ÇÖZÜM: metin İKİYE ayrıldı — değişmeyen kurallar (aşağıdaki sabit, her istekte
// BAYT BAYT aynı) önce ve `cache_control` ile; isteğe özel bağlam SONRA, ayrı
// blok olarak. Önbellek okuması ~0,1x maliyet → girişte büyük tasarruf.
// ⚠️ METİN DEĞİŞMEDİ, yalnız SIRASI değişti: değişken bağlam ortadan SONA taşındı.
// (Kullanıcıya özel bağlamı sona koymak yaygın ve genelde daha iyi uyum sağlar,
// ama davranış kayması ihtimali sıfır değil → cihazda Merci'nin tonu ve
// saat/konum/geçmiş farkındalığı bir kez sınanmalı.)
// ⚠️⚠️ BU SABİTİ DEĞİŞTİRMEK ÖNBELLEĞİ SIFIRLAR. Tek bir boşluk bile eklenirse
// o andan sonra ilk isteklerde yeniden yazım (1,25x) maliyeti oluşur. Sık sık
// oynanacak metinleri buraya değil, aşağıdaki DEĞİŞKEN BAĞLAM bloğuna koy.
// ⚠️ Değişken bağlam BOŞSA ikinci blok hiç gönderilmez — API boş metin bloğunu
// reddeder.
const MERCI_SISTEM_STATIK = `Sen Merci — mor, sevimli ama keskin zekâlı bir karar-ahtapotu. İnsanların kararsızlığını bitirmek senin işin ve bundan keyif alıyorsun. Uygulamanın yıldızı sensin, sıkıcı bir asistan değil.

TARZIN:
- Kendinden emin, hafif ukala, esprili, sıcak. Net konuş, lafı dolandırma — bir tarafı seç ve nedenini tek cümlede söyle.
- 1-3 cümle, en fazla 2 emoji. KARARSIZ/geveleyen girişler YASAK. Ya net öneri ver ya TEK kısa soruyla daralt.
- Doğal günlük Türkçe, her zaman samimi tekil "sen" (grup kararı olsa bile). Aynı mesajda sen↔siz karıştırma; "gidin / yapın / ister misiniz" gibi çoğul-nezaket çekimi YOK → "git / yap / ister misin".
- Cevabın TAMAMI Türkçe: İngilizce kelime ya da kalıp kullanma (spot, vibe, chill, option, "top 3" vb.); yalnız özel adlar (film, dizi, marka) ve köşeli parantezli işaretlerin İÇİ (ör. [[NEARBY:bar]]) bu kuralın dışındadır — işaretteki kodu tarif edildiği gibi aynen yaz. Devrik/çeviri kokan cümle kurma, günlük konuşma sırasıyla yaz.
- İmla hatasız: "karar vereyim / edeyim / gideyim" (verim/edim/gidim YANLIŞ) · "değil mi", "bir şey", "her şey" ayrı · "yalnızca" · yanlız→yalnız, herkez→herkes, süpriz→sürpriz.
- SORU EKİ: HER ZAMAN ayrı yazılır ve kesme ALMAZ ("geldi mi" ✓ · "geldimi", "geldi-mi", "geldi'mi" ✗). Biçimi kendinden ÖNCEKİ SON ÜNLÜYE göre DÖRDE ayrılır: a/ı → mı · e/i → mi · o/u → mu · ö/ü → mü. Doğru: "Yabancı mı" ("Yabancı mi" YANLIŞ), "film mi", "burger mi", "gol mü", "kokoreç mi", "Knives Out mu" (yabancı adda Türkçe okunuşun son sesi esas: "aut" → mu).
- ÖZEL ADA GELEN EK kesmeyle bağlanır: "Kadıköy'de", "Netflix'te", "İstanbul'a", "Knives Out'u".
- MARKA: uygulamanın adı "Karar Mercii", sen "Merci"sin. İkisi de ünlüyle bittiği için ekler -y- kaynaştırmasıyla gelir: "Mercii'ye", "Mercii'yi", "Mercii'de", "Merci'ye sor" ✓ — "Mercii'ne / Mercii'ni / Mercii'nde" YANLIŞ (bunlar "senin Mercii'n" anlamına gelir). Tamlayan hâli ayrıdır, -nin alır: "Merci'nin Notu" ✓.

ÖRNEK — net karar (çoğu soruda BÖYLE yap, seçenek/çark çıkarma):
K: "bu akşam film mi dizi mi izlesem" → S: "Film. Tek oturuşta biter, yarım kalma derdi olmaz 🎬 Tür söyle, sana birini seçeyim."
ÖRNEK — SADECE gerçekten kararsızsa daralt:
K: "akşam yemeği ne yesek, hiç fikrim yok, 4 kişiyiz" → S: "O zaman daraltalım 🍽️ [[SECENEKLER: Kebap | İtalyan | Balık | Burger]]"
KÖTÜ (ASLA): "hmmm, akşam yemeği heyecanı! ama ne istediğini bilmeden nasıl karar verim?" (yazım hatası + kararsız + uzun)

NE YAPARSIN:
- Sadece karar konularında yardım et: nereye gidilsin, ne yenilsin/izlensin/yapılsın, kime ne hediye alınsın.
- Alakasız soruda (genel bilgi, matematik, kod) nazikçe geçiştir: "Ben karar kollarımı onun için sallamıyorum 🐙 Ama bir ikilemin varsa anlat, çözeriz!"
- Kısıt gelince ("2 kişiyiz", "arabam yok", "bütçe az") soru sormadan DİREKT uygun alternatif öner. En fazla 1 netleştirme sorusu — peş peşe soru yağdırma.


ÇARK/OYLAMA = SON ÇARE: Öncelik HER ZAMAN senin net önerin. Yalnızca kullanıcı "bilmiyorum / fark etmez / bir türlü karar veremiyorum" derse VEYA seçenekler gerçekten başa baş kilitlendiyse yönlendir — her cevaba "çevir bakalım / oylamaya alalım" ekleme, bunaltıcı olur. Çark: "Kaderine bırak — çevir bakalım! 🎡" · büyük grup + gerçek anlaşmazlık: "Bunu kalabalık çözer, oylamaya alalım 📊".

[[SECENEKLER]] İŞARETİ — ölçülü, refleks olarak her cevaba EKLEME. Cevabın EN SONUNA [[SECENEKLER: ad1 | ad2 | ad3]] (2-8 kısa isim, | ile ayrık). SADECE iki durumda: (1) net tek cevabın YOK, 2+ somut kategori sunuyorsun; (2) kullanıcı "sen seç / çevir / oylayalım / karar veremiyorum" dedi. Net tek önerin varsa KOYMA.
- Yalnız soyut KATEGORİ/tür yazılır (Pizza, Korku filmi, Kafe). GERÇEK MEKAN/ZİNCİR İSMİ ASLA.
- Seçenek adları da Türkçe imlaya tabi: 1-3 kelime, Türkçe, ilk harf büyük gerisi küçük ("Korku filmi"), tekil ve eksiz kök hâlde (kullanıcının verdiği özel adlar hariç — onlar aynen kalır), emoji/noktalama yok. ("pizza yicez", "Movie Night", "Kebaplar" YANLIŞ.)
- ⚠️ ÇARKA YÖNLENDİRİRKEN SEÇENEKLERİ YÜKLE: kullanıcı kendi verdiği 2+ somut seçenek arasında kararsızsa ("bu mu şu mu", "ikisi arasında kaldım", "seç işte") ve sen de net seçmiyorsan, "çevir bakalım" derken O SEÇENEKLERİ aynı cevaba koy — çark otomatik dolsun, kullanıcı elle girmesin. Kullanıcının söylediği isimleri koru — sadece yazımını/büyük harfini düzelt ("cebimdeki yabancı" → "Cebimdeki Yabancı"), ismi değiştirme veya kısaltma (ör. [[SECENEKLER: Cebimdeki Yabancı | Knives Out]]). BOŞ çarka "çevir bakalım" ASLA deme.

MEKAN CEVABI — [[NEARBY]] koyduğun HER cevapta katı kısıt:
- SADECE TEK kısa cümle + işaret (ör. "En yakınları çıkarıyorum 👇"). Başka hiçbir şey yok.
- Aynı cevaba [[SECENEKLER]] KOYMA — gerçek yerleri yalnızca kartlar getirir.
- Kendi kafandan mekan/zincir İSMİ (Domino's, Big Chefs, Komagene, "X Dönercisi") yazma; yan tür/yemek listesi sayma (kokoreç, kebap, çiğköfte, büfe...). Sıralama yaparsan alakasız yer saymış olursun.

KIRMIZI ÇİZGİLER:
- UYDURMA YASAK: mekan ismi, telefon, semt/ilçe/cadde adı, mesafe ASLA uydurma. Bir yerin nerede/ne kadar uzakta olduğunu SADECE [[NEARBY]] işaretinin getirdiği gerçek kartlar söyler. "Başka semte git" deme. "Burada yok / kültürü gelişmemiş" gibi kesin olumsuz hüküm verme — mevcudiyeti kartlar belirler.
- SPESİFİĞE SADIK KAL: "Tavuk döner" → kebap/kokoreç/çiğköfte DEĞİL. "Sushi" → başka mutfak DEĞİL. "Şarap / oturmalı / akşam yemeği" → fast-food, büfe, pizza-zinciri DEĞİL, oturmalı restoran. İstenen türe UYMAYAN yeri o türmüş gibi sunma; alternatifleri kartlar zaten "en yakın seçenekler" olarak getirir. Emin değilsen ÖNERME — dürüst ol.
- İÇ İŞLEYİŞ GİZLİ: sistem, harita, GPS, API, sunucu, arkaplan, entegrasyon, "mekan kartı çekemiyorum", "yükleyemedim" gibi teknik ifadeler ASLA. İç terimleri de yazma: araç adı (mekan_ara), işaret adları ([[SECENEKLER]], [[NEARBY]], [[SETLOC]] — bunları yalnız tarif edilen yerde İŞARET olarak kullan, cevap metninde adlarını anma), tür kodları (food/cafe/dessert/bar/activity yerine "yemek/kafe/tatlı/bar/aktivite" de), OSM/etiket/regex/model/prompt/token gibi kelimeler. Kullanıcı bunları hiç görmemeli. Mekan gelmediğinde bahane uydurma; kısa ve neşeli kal ("Hemen tekrar bakıyorum 👇") ve uygun [[NEARBY:tür]] işaretini koy.
- ALKOL/KUMAR — TEŞVİK YOK: Kumar/bahise yönlendirme KESİNLİKLE yasak. Alkol: mekan önerebilirsin ama İÇME kararını SEN verme/özendirme. "Bira mı rakı mı içeyim", "kaç kadeh atayım" gibi sorularda taraf tutma: "İçkini sana bırakıyorum 🐙 — ama nereye gidelim / ne yiyelim dersen hemen yardımcıyım." Yaşı doğrulayamadığımız için kimseyi alkole/kumara/tütüne teşvik etme; sarhoş olmayı veya aşırı içmeyi ASLA önerme.
- Yapay AI girişleri yok ("Tabii ki!", "Harika bir soru!", "ben yapay zekayım"). Konum varsa tekrar şehir/semt/konum isteme.
- ⛔ CEVAPLANMIŞI TEKRAR SORMA — EN AĞIR HATA. Kullanıcının konuşmada verdiği hiçbir bilgiyi yeniden isteme; ne aynı soruyu, ne kılık değiştirmiş hâlini. "Bi yere gidelim" dedin, sen "ne tarz?" diye sordun, o "gece yemeği ve bira" dediyse tür BELLİDİR — "ne tarz yemek istersiniz?" diye sormak yasaktır. Arama boş dönse bile soruya GERİ DÖNME: elindeki bilgiyle ya net bir öneri ver ya [[SECENEKLER]] koy. Soru, yalnız konuşmada gerçekten hiç bilgi yokken serbesttir.
- ⛔ ZORLAMA ARGO YOK. Samimi ol ama Türkçen düzgün olsun. Oturmayan sokak ağzı uydurma: "hangisine kıyak?", "kanka moduna geçtim", "efsane olur mu?" gibi zorlama kalıplar YAZMA. Emin olmadığın argoyu hiç kullanma — sade ve doğal Türkçe her zaman daha iyi.`;

// ⭐ 19 AĞU — SOHBET GEÇMİŞİ SINIRSIZ GÖNDERİLİYORDU (sessiz maliyet kaçağı).
// `messages` client'tan OLDUĞU GİBİ alınıp modele veriliyordu. Konuşma her turda
// baştan gönderildiği için 10 turluk bir sohbette 10. mesajın girdisi 1.'nin
// 3-4 KATI oluyordu → mesaj başı maliyet konuşma boyunca tırmanıyor, faturada
// görünen sayı "ortalama mesaj maliyeti" tahmininin çok üstüne çıkıyordu.
// Merci kısa etkileşimli bir KARAR asistanı; 20 turluk bağlama ihtiyacı yok.
// ⚠️ Eski kod 40 mesaj / 20.000 karakteri aşınca isteği REDDEDİYORDU
// ("Konuşma çok uzun, yeni bir konu başlat") — yani uzun sohbet hem pahalıydı
// hem de kullanıcıyı duvara toslatıyordu. Artık KIRPILIYOR: kullanıcı akışını
// kaybetmez, maliyet sabit tavanda kalır.
// ⚠️ İLK ELEMAN "user" OLMAK ZORUNDA (API kuralı: ilk mesaj user olmalı).
// Sondan kırpınca başa assistant düşebilir → baştaki user olmayanlar atılır.
const MERCI_TUR_TAVANI = 10; // son 10 mesaj ≈ 5 soru-cevap
const MERCI_KARAKTER_TAVANI = 8000; // tek mesaj bile devasa olabilir
function kirpKonusma(messages, turTavani, karakterTavani) {
  const N = turTavani || MERCI_TUR_TAVANI;
  const K = karakterTavani || MERCI_KARAKTER_TAVANI;
  const userMi = (m) => m && m.role === "user";
  let a = messages.slice(-N);
  while (a.length && !userMi(a[0])) a.shift();
  // Karakter tavanı: baştan atarak sığdır, her atıştan sonra yine user'a hizala.
  while (a.length > 1 && JSON.stringify(a).length > K) {
    a.shift();
    while (a.length && !userMi(a[0])) a.shift();
  }
  // Hiç user kalmadıysa (bozuk/tek taraflı payload) son user mesajından devam et.
  if (!a.length) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (userMi(messages[i])) return messages.slice(i, i + N);
    }
  }
  return a;
}

// ⭐ 20 AĞU — KOTA İADESİ.
// authAndQuota sayacı modeli ÇAĞIRMADAN ÖNCE artırıyor (yarış koşulunu önlemek
// için doğru), ama cevap üretilemezse geri VERMİYORDU → her hata kullanıcının
// hakkından bir mesaj yiyordu, karşılığında hiçbir şey almıyordu. Günlük hak 4
// iken iki hata günün yarısını siliyordu.
// ⚠️ Yalnız CEVAPSIZ biten istekte çağır (500/504). Cevap gittiyse hak meşru
// harcanmıştır. İki kez iade etmemek için referans null'lanıyor.
async function kotaIade(req) {
  try {
    const ref = req && req._kmKotaRef;
    if (!ref) return;
    req._kmKotaRef = null;
    await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? snap.data().count || 0 : 0;
      if (count <= 0) return;
      tx.set(
        ref,
        { count: count - 1, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    });
    console.log("KOTA IADE — cevap uretilemedi, hak geri verildi:", req._kmUid || "?");
  } catch (e) {
    console.error("KOTA IADE HATASI:", e.message);
  }
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
    // Kaba tavan: gövde saçma büyüklükteyse hiç uğraşma (abuse/bozuk client).
    if (messages.length > 200 || JSON.stringify(messages).length > 200000) {
      return res
        .status(400)
        .json({ error: "Konuşma çok uzun, yeni bir konu başlat." });
    }
    // ⭐ 19 AĞU — KIRP, REDDETME (aşağıdaki kirpKonusma'nın gerekçesi orada).
    const konusma = kirpKonusma(messages);

    // ── 20 AĞU — NİYET METNİ (mekan alakası için) ────────────────────────────
    // ⚠️ KÖK NEDEN (canlı): kullanıcı "gece yemeği ve bira" dedi, kartlarda büfe,
    // çiğköfteci, DÜĞÜN SALONU çıktı. Sebep prompt DEĞİL, hattın kendisi:
    // `mekan_ara`nın `arama` alanı — şemanın kendi talimatıyla — genel isteklerde
    // BOŞ bırakılıyor ("belirli bir şey söylemediyse BOŞ BIRAK"). /nearby'deki
    // oturmalı/içkili sinyalleri (`wantsSitdown`) YALNIZ o alana bakıyordu →
    // kullanıcının cümlesi arama katmanına HİÇ ULAŞMIYORDU.
    // ➜ Kullanıcının son cümleleri niyet SİNYALİ olarak taşınıyor. ARAMA TERİMİ
    //    DEĞİL (serbest metin aramasına verilmez — o tuzak 2 Ağu'da yaşandı),
    //    sadece "oturmalı mı / içki var mı" gibi kova kararlarında kullanılır.
    const _kullaniciMetni = konusma
      .filter((m) => m && m.role === "user" && typeof m.content === "string")
      .slice(-3)
      .map((m) => m.content)
      .join(" ")
      .slice(0, 300);
    // Sohbette DAHA ÖNCE GÖSTERİLMİŞ mekan isimleri (client biriktirir, yeni konuda
    // sıfırlar). Araç yolu bunu göndermediği için aynı kartlar tekrar tekrar
    // basılıyordu; /nearby'nin exclude süzgeci hazır duruyordu, bağlı değildi.
    const _gosterilenMekanlar = (
      Array.isArray(req.body && req.body.shownPlaces) ? req.body.shownPlaces : []
    )
      .slice(-40)
      .map((x) => String(x || "").slice(0, 60).trim())
      .filter(Boolean);

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

    // İsteğe özel bağlam — önbelleğe ALINMAZ, statik bloktan SONRA gider.
    const grupSatiri =
      groupCount > 0
        ? `\n- Grup ${groupCount > 6 ? "6+" : groupCount} kişilik — buna göre öner.`
        : "";
    const degiskenBaglam = `${grupSatiri}${timeContext}${historyContext}${locationContext}${setLocHint}${resultPrompt}${winnerEspriPrompt}`;

    // Araç YALNIZ bayrak açıkken VE koordinat varken verilir. Koordinat yoksa
    // (konum kapalı / eski client) araç listesi hiç gönderilmez → model eski
    // [[NEED_LOCATION]] işaret yolunu kullanır, davranış bugünküyle birebir aynı kalır.
    const useTools = KM_TOOL_USE && hasGeo;
    const baseReq = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      temperature: 0.5, // karar-asistanı → tutarlılık öncelik; persona sıcaklığı korunur (renk azalırsa 0.6)
      // Statik blok önbelleğe alınır (aynı önek tüm kullanıcılarda paylaşılır),
      // değişken bağlam ayrı blokta ve önbelleksiz gider.
      system: [
        { type: "text", text: MERCI_SISTEM_STATIK, cache_control: { type: "ephemeral" } },
        ...(degiskenBaglam.trim()
          ? [{ type: "text", text: degiskenBaglam }]
          : []),
      ],
      messages: konusma,
    };
    if (useTools) baseReq.tools = [MEKAN_ARA_TOOL];

    let response = await anthropic.messages.create(baseReq, {
      timeout: ANTHROPIC_TIMEOUT_MAIN, // yanıt gelmezse asılı kalma → 504 (aşağıda)
    });

    // ⭐ ÖNBELLEK TEŞHİSİ — BU LOG OLMADAN CACHING'İN ÇALIŞIP ÇALIŞMADIĞI BİLİNEMEZ.
    // Prompt önbelleği SESSİZCE ıskalar: önek bir bayt değişirse hiçbir hata
    // alınmaz, sadece fatura eskisi gibi gelir. Bu projedeki arızaların ortak
    // deseni tam bu ("index deploy edilmemiş", "esc() kaçışlamıyor") → ölçülmeyen
    // şey sessizce bozulur. Sunucu logunda "MERCI USAGE" satırını ara:
    //   cacheRead > 0  → önbellek ÇALIŞIYOR (asıl istenen)
    //   cacheWrite > 0 → o istek önbelleği KURDU (ilk istek / süresi dolmuş: normal)
    //   ikisi de 0 ve input yüksek → önbellek ISKALIYOR, önek bozulmuş demektir
    //     (MERCI_SISTEM_STATIK'e istek bazlı bir şey sızmış olabilir).
    try {
      const u = response.usage || {};
      console.log(
        "MERCI USAGE input=" + (u.input_tokens || 0) +
          " cacheRead=" + (u.cache_read_input_tokens || 0) +
          " cacheWrite=" + (u.cache_creation_input_tokens || 0) +
          " output=" + (u.output_tokens || 0) +
          " mesajSayisi=" + konusma.length,
      );
    } catch (e) {}

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
    // Son GEÇERLİ konuşma (araç sonuçları dahil). Model metin üretmeden biterse
    // (ör. tool_use bloğunun ortasında max_tokens'a takılırsa) buradan TEK bir
    // araçsız kurtarma turu atılır — bkz. "BOŞ METİN KURTARMA".
    let sonKonusma = null;
    if (useTools) {
      let convo = konusma.slice();
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
              // Sohbette zaten gösterilmiş mekanlar bir daha gelmesin.
              exclude: _gosterilenMekanlar,
              // Kullanıcının kendi cümlesi → oturmalı/içkili niyet sinyali.
              intentText: _kullaniciMetni,
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
                  ? "\n\nUYARI: Tam olarak istenen tür çıkmadı; bunlar en yakın " +
                    "ALTERNATİFLER. İstediği şeymiş gibi SUNMA — \"tam onu göremedim ama " +
                    "yakında şunlar var\" gibi MEKAN diliyle dürüstçe alternatif ver. " +
                    "Arama/sistem diliyle (\"aramam sonuç vermedi\") ANLATMA ve " +
                    "kullanıcıyı dış bir servise/haritaya YÖNLENDİRME."
                  : "") +
                "\n\nBu listedekiler DIŞINDA mekan/semt/mesafe uydurma. Menü, fiyat, içki " +
                "bilgisi sende YOK — bir mekânda belirli bir şeyin olduğunu garanti etme."
              : "Bu arama sonuç vermedi. UYARI — BU BİLGİ SANA AİT: kullanıcıya arama " +
                "yaptığını, sonuç gelmediğini ya da bir şeyi bulamadığını ANLATMA." +
                (tur < MAX_TOOL_TURN
                  ? " İSTERSEN bir kez daha dene: osm_cuisine/osm_shop/osm_isim " +
                    "ipuçlarını değiştir ya da tur'u genişlet (sinema/bowling/park " +
                    "istekleri için tur=activity ve arama=\"sinema\" GERÇEK sinemaları getirir)."
                  : "") +
                " Sonuç yine gelmezse şu ÜÇ şeyden BİRİNİ yap, dördüncüsü YOK: " +
                "(1) kullanıcının kendi saydığı seçenekler varsa TARAF TUT, birini seç ve " +
                "nedenini tek cümlede söyle; (2) taraf tutmuyorsan aynı cevaba " +
                "[[SECENEKLER: ...]] koyup çarkı ONUN seçenekleriyle doldur; " +
                "(3) SADECE konuşmada gerçekten HİÇ bilgi yoksa TEK kısa soruyla daralt. " +
                "⛔⛔ KULLANICININ ZATEN VERDİĞİ BİLGİYİ TEKRAR SORMAK KESİN YASAK — " +
                "kılık değiştirmiş hâli de yasak. (Canlı hata, 20 Ağu: kullanıcı " +
                "\"gece yemeği ve bira\" dedi, arama boş döndü, model \"ne tarz yemek " +
                "istiyorsunuz?\" diye SORDU. Tür zaten belliydi.) Konuşmada tür/istek " +
                "verilmişse (3) KAPALIDIR → (1) veya (2)'yi kullan. " +
                "KESİN YASAK: mekan/mesafe UYDURMA · kendi eksiğini itiraf etme " +
                "(\"bulamadım / bulamamışım / sonuç gelmedi / gösteremiyorum\") · " +
                "\"orada yok / civarda hiç yok\" gibi kesin olumsuz hüküm verme · " +
                "Google, Google Maps, Haritalar, Yandex gibi DIŞ SERVİS adı verme ya da " +
                "\"aratırsan bulursun\" diye ima etme — kullanıcıyı uygulamadan ÇIKARMA.";
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
        sonKonusma = convo; // araç sonuçlarıyla kapanmış GEÇERLİ konuşma
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

    // ── BOŞ METİN KURTARMA (20 AĞU — "Bi şeyler ters gitti" + ALAKASIZ KARTLAR) ──
    // CANLI KUSUR: kullanıcı önce "Bir şeyler ters gitti, tekrar dene!" hata
    // mesajını gördü, ARDINDAN mekan kartları geldi. Sebep: aşağıdaki yanıtta
    // `text` boş kalınca hata metni basılıyor AMA `places: toolPlaces` yine
    // gönderiliyor → tek istekte "hata + kart" çelişkisi.
    // METİN NEDEN BOŞ KALIR: araç döngüsü yalnız `stop_reason === "tool_use"`
    // durumunu sürdürür. Model bir tool_use bloğunun ORTASINDA max_tokens'a
    // takılırsa (uzun osm_isim regex'i vb.) stop_reason "max_tokens" olur,
    // içerikte tek bir text bloğu bulunmaz ve döngü sessizce biter.
    // ➜ Kurtarma: elde araç sonuçlarıyla kapanmış GEÇERLİ bir konuşma varsa TEK
    //   bir araçsız çağrı at — araç verilmediği için model metin yazmak ZORUNDA.
    //   Bu yol yalnız bu nadir arızada çalışır, normal akışta maliyet değişmez.
    if (!text && sonKonusma) {
      console.warn(
        "BOŞ METİN → araçsız kurtarma turu (stop_reason=" +
          (response && response.stop_reason) + ")",
      );
      try {
        const kurtarma = { ...baseReq, messages: sonKonusma };
        delete kurtarma.tools;
        const r2 = await anthropic.messages.create(kurtarma, {
          timeout: ANTHROPIC_TIMEOUT_MAIN,
        });
        response = r2;
        r2.content.forEach((block) => {
          if (block.type === "text") text += block.text;
        });
      } catch (e) {
        console.error("Kurtarma turu da başarısız:", e.message);
      }
    }

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

    if (!text) {
      console.error(
        "BOŞ METİN TEŞHİSİ:",
        JSON.stringify({
          stop_reason: response && response.stop_reason,
          bloklar: (response && response.content
            ? response.content.map((b) => b.type)
            : []),
          metinBlokUzunluk: (response && response.content
            ? response.content
                .filter((b) => b.type === "text")
                .map((b) => (b.text || "").length)
            : []),
          toolRan,
          mekanSayisi: toolPlaces ? toolPlaces.length : null,
          sonSoru: String(
            (messages[messages.length - 1] &&
              messages[messages.length - 1].content) ||
              "",
          ).slice(0, 200),
        }),
      );
    }
    // ⚠️ HATA MESAJI + KART AYNI YANITTA OLAMAZ ([[ai-hata-mesaji-tuzagi]]).
    // Kurtarma turundan sonra hâlâ metin yoksa: elde GERÇEK mekan varsa hata
    // DEĞİL, kartları takdim eden nötr bir cümle gönderilir (uydurma yok, teknik
    // detay yok). Mekan da yoksa eski dürüst hata mesajı kalır.
    const guvenliMetin =
      text ||
      (toolPlaces && toolPlaces.length
        ? "En yakındakileri çıkardım, aşağıda 👇"
        : "Bir şeyler ters gitti, tekrar dene!");
    res.json({
      text: guvenliMetin,
      setLocation, // yazıyla verilen konumun koordinatı (varsa) → client günceller
      // Araç çalıştıysa mekan kartları AYNI yanıtta gelir → client'ın ayrıca
      // /nearby çağırmasına gerek kalmaz (eski akışta iki HTTP turu vardı).
      // null = araç hiç çalışmadı (eski işaret yolu geçerli).
      places: toolPlaces,
    });
  } catch (error) {
    // Cevap üretilemedi → harcanan hakkı geri ver (bkz. kotaIade).
    kotaIade(req);
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
// ── ÇARK SEÇENEĞİ NORMALİZASYONU (Türkçe-duyarlı) ───────────────────────────
// ⚠️ DAVRANIŞ DEĞİŞİKLİĞİ (18 Ağu): etiket imlası artık yalnız prompt'un iyi
// niyetine bırakılmıyor, burada deterministik olarak garanti altına alınıyor.
// KAPSAM: buradan SADECE MODELİN ürettiği seçenekler geçer. Kullanıcının elle
// yazdığı seçenekler istemcide kalır, bu koda hiç uğramaz — onları bozmayız.
// TÜRKÇE TUZAĞI: düz toUpperCase() "istanbul" → "Istanbul" yapar (doğrusu
// "İstanbul"), düz toLowerCase() "IZMIR" → "izmir" yapar (doğrusu "ızmır").
// Bu yüzden her yerde locale'li ("tr") sürüm kullanılıyor.
const trUp = (s) => String(s).toLocaleUpperCase("tr");
const trLow = (s) => String(s).toLocaleLowerCase("tr");

// Tekrar (dedup) anahtarı: büyük/küçük harf + boşluk farkını yok say.
// "Islak kek" ile "ıslak kek" aynı şeydir → tek anahtara düşsün (düz
// toLowerCase() bunu KAÇIRIR, çünkü "I" → "i" der, "ı" değil).
function optKey(s) {
  return trLow(s).replace(/\s+/g, " ").trim();
}

function normalizeOption(raw) {
  let s = String(raw == null ? "" : raw)
    .replace(/\s+/g, " ") // satır sonu + içerideki çoklu boşluk → tek boşluk
    .trim()
    .replace(/^["'\-\d.\)\s]+/, "") // baştaki numara/tire/tırnak (eski davranış)
    .trim()
    .slice(0, 40) // eski uzunluk sınırı korundu — yeni kısaltma EKLENMEDİ
    .replace(/["'.,;:!?]+$/, "") // sondaki artık noktalama ("sinema" → sinema)
    .trim();
  if (!/\p{L}/u.test(s)) return ""; // hiç harf yok (salt emoji/noktalama) → ele
  // İlk HARFİ büyüt. Seçenek emoji ya da tırnakla başlayabilir, o yüzden ilk
  // harfin YERİNİ arıyoruz; s[0] "ilk harf" demek değil.
  // Sadece o kelimenin TAMAMI küçükse dokun → "iPhone", "eBay", "IMDb" gibi
  // karışık yazımlar ve "KFC" gibi kısaltmalar olduğu gibi kalır.
  const i = s.search(/\p{L}/u);
  const kelime = s.slice(i).split(" ")[0];
  if (kelime === trLow(kelime)) {
    const ilk = String.fromCodePoint(s.codePointAt(i)); // yüzey çifti güvenli
    s = s.slice(0, i) + trUp(ilk) + s.slice(i + ilk.length);
  }
  return s;
}

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
      "tekrar yok; emoji yok; başına numara/tire koyma. " +
      "TÜRKÇE İMLA: Türkçe karakterleri eksiksiz kullan (ş, ğ, ı, İ, ö, ü, ç — 'corba/kofte' DEĞİL 'Çorba/Köfte'); " +
      "ilk harf büyük gerisi küçük ('Korku filmi'); tekil ve eksiz kök hâl ('Kebaplar' DEĞİL 'Kebap'); İngilizce kelime yok.";
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

    const seen = Object.create(null); // prototipsiz: "constructor"/"toString" adlı seçenek sessizce elenmesin
    opts = (Array.isArray(opts) ? opts : [])
      .map(normalizeOption)
      .filter((x) => {
        if (!x) return false;
        const k = optKey(x); // Türkçe-duyarlı tekrar elemesi
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
// ⚠️ .trim() ŞART — CANLIDA 401 SEBEBİYDİ (2 Ağu gece). Replit Secrets'a
// yapıştırılan değerin sonunda görünmez boşluk/satır sonu kalmıştı; URL'ye
// encodeURIComponent ile girince "%20"ye dönüşüp anahtarı geçersiz kıldı →
// TomTom HTTP 401 → sessizce OSM'e düşüş → "Ümraniye'de kokoreç bulamadım"
// (oysa 515 m'de Otağ Kokoreç vardı). Görünmez karakteri ASLA kullanıcıya
// borç bırakma, kod temizlesin.
const TOMTOM_KEY = String(process.env.TOMTOM_KEY || "").trim();
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

// ── TEŞHİS SAYAÇLARI (2 AĞU akşam) ───────────────────────────────────────
// SEBEP: TomTom başarısız olunca akış SESSİZCE OSM'e düşüyor — kullanıcı sadece
// "kötü sonuç + yavaş" görüyor, sunucu logları dışarıdan okunamıyor. Bu sayaçlar
// /version'da açılıp hangi dalın patladığını TEK BAKIŞTA söyler:
//   filtered ↑ → TomTom mekanı BULDU ama alaka süzgecim eledi (süzgeç fazla katı)
//   httpErr ↑  → anahtar/kota/istek sorunu (lastStatus'a bak)
//   netErr ↑   → Replit'ten TomTom'a erişilemiyor (timeout)
//   empty ↑    → TomTom gerçekten hiçbir şey bulamadı (veri yok)
// ⚠️ Kullanıcının yazdığı ARAMA TERİMİ BİLEREK TUTULMUYOR (gizlilik) — sadece
// sayılar. Teşhis için hangi dalın patladığı yeterli, terimin kendisi gerekmiyor.
const _ttStats = {
  attempts: 0,   // tomtomSearch ağ isteğine kadar geldi
  ok: 0,         // en az 1 mekan döndürdü
  empty: 0,      // TomTom 0 ham sonuç döndürdü
  filtered: 0,   // ⭐ ham sonuç VARDI ama süzgeçten 0 çıktı
  httpErr: 0,    // HTTP 4xx/5xx
  netErr: 0,     // timeout / bağlantı hatası
  capped: 0,     // aylık tavan doldu
  cacheHit: 0,   // önbellekten karşılandı (ücretsiz)
  lastStatus: 0, // son HTTP durum kodu
  lastMs: 0,     // son çağrı süresi (ms)
  lastRaw: 0,    // son çağrıda TomTom'un döndürdüğü HAM mekan sayısı
};
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
      // ⚠️ Firestore `.get()` kendi içinde uzun süre yeniden dener (60sn+) →
      // ağ/kota sorununda bu await İSTEĞİ ASKIDA BIRAKIR. Bütçe sayacı
      // "olsa iyi olur" bilgisidir, uğruna kullanıcı bekletilmez: 3sn'de
      // vazgeç, bellekteki sayaçla devam et.
      const s = await Promise.race([
        adminDb.collection("apiUsage").doc("tomtom_" + m).get(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
      ]);
      if (s && s.exists) _ttCount = s.data().count || 0;
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
// İsim tutmasa bile TomTom'un alaka skoru bu eşiğin üstündeyse mekan KABUL edilir
// (adı "Kuzureç"/"Bereket Büfe" olan kokoreççiler böyle kurtarılır). Eşik ölçümle
// seçildi: gerçek eşleşmeler 0.82–0.93, "boza" çöpü 0.708 ve altı → 0.80 ayırır.
const TT_SCORE_TRUST = 0.8;
// Yarıçap kademeleri: yakında yoksa komşu ilçelere bak. Ek ÜCRETLİ çağrı yalnız
// bir önceki kademe 0 sonuç verirse yapılır.
const TT_RADII = [6000, 15000, 30000];
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
    _ttStats.cacheHit++;
    return {
      places: hit.places.map((p) => ({ ...p, open: ttOpenNow(p.oh) })),
      broadened: hit.broadened,
      cached: true,
    };
  }

  if (!(await ttBudgetOk())) {
    _ttStats.capped++;
    console.warn(
      `TomTom aylık tavan doldu (${_ttCount}/${PLACES_MONTHLY_CAP}) → OSM'e düşülüyor`,
    );
    return null;
  }

  const words = trFold(q).split(/\s+/).filter((w) => w.length >= 3);
  let anyFullMatch = false;

  // ── TEK YARIÇAP DENEMESİ ────────────────────────────────────────────────
  async function tryRadius(radiusM) {
    const url =
      `https://api.tomtom.com/search/2/poiSearch/${encodeURIComponent(q)}.json` +
      `?key=${encodeURIComponent(TOMTOM_KEY)}&lat=${lat}&lon=${lng}` +
      `&radius=${radiusM}&limit=40&countrySet=TR&language=tr-TR&openingHours=nextSevenDays`;
    const ctrl = new AbortController();
    // 6sn: TomTom ~1sn dönüyor. Başarısızlıkta arkasından TÜM OSM yolu
    // çalıştığı için burada beklenen her saniye kullanıcıya gecikme olarak yansır.
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const _t0 = Date.now();
    _ttStats.attempts++;
    let j;
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      _ttStats.lastStatus = r.status;
      if (!r.ok) {
        _ttStats.httpErr++;
        _ttStats.lastMs = Date.now() - _t0;
        // ⚠️ 401 = anahtar geçersiz (genelde Secrets'ta görünmez boşluk).
        // Ayrı ve bağırarak logla; sessiz OSM düşüşü saatler kaybettirdi.
        console.error(
          r.status === 401
            ? "🔴 TomTom 401 YETKİSİZ — TOMTOM_KEY geçersiz/bozuk (boşluk?). Sağlayıcı DEVRE DIŞI, OSM'e düşülüyor."
            : "TomTom HTTP " + r.status + " " + (await r.text()).slice(0, 200),
        );
        return null;
      }
      j = await r.json();
    } catch (e) {
      _ttStats.netErr++;
      _ttStats.lastMs = Date.now() - _t0;
      console.error("TomTom hata:", e.name === "AbortError" ? "timeout" : e.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
    _ttStats.lastMs = Date.now() - _t0;
    _ttStats.lastRaw = (j.results || []).length;
    ttBudgetSpend();

    return (j.results || [])
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
        // ── ALAKA: İSİM **YA DA** YÜKSEK SKOR ──────────────────────────────
        // ⚠️ Yalnız isme bakmak GERÇEK MEKAN KAYBETTİRİR: bir kokoreççinin adı
        // "Kuzureç" ya da "Bereket Büfe" olabilir; yemek adı isminde geçmez.
        // TomTom'un kendi alaka skoru bunu bilir. ÖLÇÜM (2 Ağu):
        //   Ümraniye "kokoreç" GERÇEK sonuçlar → 0.82–0.93
        //   Eminönü "boza" ÇÖP sonuçlar        → 0.708 / 0.646 / 0.453 / 0.357
        // Aralar AYRIK → eşik 0.80 güvenli marjla ikisini ayırır. Skor yolu
        // yalnız YİYECEK kategorisiyle birlikte geçerli (otel/kuyumcu zaten elendi).
        let matched = false;
        if (words.length) {
          const m = ttNameMatches(name, words);
          if (m.length) {
            matched = true;
            if (m.length === words.length) anyFullMatch = true;
          } else if (isFinite(r.score) && r.score >= TT_SCORE_TRUST) {
            matched = true; // ismi tutmadı ama TomTom yüksek güvenle alakalı diyor
          }
          if (!matched) return null;
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
  }

  // ── YARIÇAP GENİŞLETME ──────────────────────────────────────────────────
  // ⚠️ Kullanıcı isteği (2 Ağu): "diyelim ki Ümraniye'de bulamadı — yakın
  // ilçelere baksaydı, Acıbadem'de kokoreççi var." OSM yolunda bu zaten vardı
  // (runExpanding), TomTom yolunda YOKTU: tek sabit 6 km, sonuç yoksa "bulamadım".
  // Şimdi kademeli genişliyor. Ek ÜCRETLİ çağrı yalnız 0 sonuçta yapılır —
  // yani nadiren, ve tam da en çok işe yarayacağı anda.
  let places = null;
  for (const rad of TT_RADII) {
    places = await tryRadius(rad);
    if (places === null) return null; // ağ/anahtar hatası → OSM'e düş
    if (places.length) break;
  }

  // Tam eşleşme yoksa (ör. "ıslak burger" → sadece "burger" tuttu) bu bir
  // GENİŞLETMEDİR; /nearby bu bayrakla kullanıcıya dürüstçe "tam onu bulamadım,
  // en yakın alternatifler" der. Sessizce doğru sonuç gibi sunma.
  const broadened = words.length > 1 && !anyFullMatch;

  // ⭐ TEŞHİSİN KALBİ: ham sonuç vardı ama süzgeçten 0 çıktıysa sorun VERİDE
  // DEĞİL, BENİM SÜZGECİMDE. Bu ikisini ayırmadan "TomTom bulamadı" sanılıyordu.
  if (!places.length && _ttStats.lastRaw > 0) _ttStats.filtered++;
  else if (!places.length) _ttStats.empty++;
  else _ttStats.ok++;

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

// ── YEME-İÇME OLMAYAN MEKAN ADLARI (20 AĞU — CANLI: "DÜĞÜN SALONU" KARTI) ──
// Kullanıcı "gece yemeği ve bira" istedi, kartlardan biri DÜĞÜN SALONU çıktı.
// Bu yerler OSM'de amenity=restaurant, TomTom'da RESTAURANT/RESTAURANT_AREA
// olarak etiketlenebiliyor (mutfakları var) ama hiçbir yorumla "gidip yemek
// yenecek mekan" DEĞİLLER: rezervasyonla organizasyona açılırlar.
// ⚠️ İSİM TABANLI ve DAR tutuldu: yalnız organizasyon/kurum ibareleri. "Salon"
// tek başına YOK (kuaför değil ama "Salon Restaurant" gibi gerçek isimler var).
// Bu süzgeç YALNIZ yeme-içme kovalarında (food/cafe/dessert) uygulanır.
const NON_DINING_NAME =
  /(d[üu][ğg][üu]n salon|d[üu][ğg][üu]n saray|nikah|k[ıi]na salon|balo salon|davet salon|organizasyon|toplant[ıi] salon|konferans salon|kongre merkez|catering|yemekhane|kantin|ta[şs][ıi]mal[ıi] yemek|cenaze|ta[zc]iye|mezarl[ıi]k)/i;

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
    // ── NİYET METNİ (20 AĞU) ────────────────────────────────────────────────
    // Kullanıcının KENDİ cümlesi. ⚠️ ARAMA TERİMİ DEĞİLDİR: hiçbir zaman TomTom'a
    // ya da Overpass isim regex'ine verilmez (o tuzak 2 Ağu'da yaşandı). Yalnızca
    // "oturmalı mı / içki var mı" gibi KOVA kararlarında sinyal olarak okunur.
    // Sebep: `mekan_ara`nın `arama` alanı genel isteklerde boş kalıyor, bu yüzden
    // "gece yemeği ve bira" gibi net bir niyet arama katmanına hiç ulaşmıyordu.
    const intentText = String((req.body && req.body.intentText) || "")
      .toLowerCase()
      .slice(0, 300);
    const niyetMetni = (query + " " + intentText).trim();
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
    const OTURMALI_RE =
      /şarap|sarap|içki|icki|alkol|bira|kokteyl|kokteil|rakı|raki|meyhane|şaraph|saraph|oturmal|à la carte|a la carte|akşam yeme|aksam yeme|gece yeme|yemeğe çık|yemege cik|romantik|masa(da|ya)?\b|garson|servisli|restoran|restaurant/i;
    // ⚠️ İKİ AYRI SİNYAL, KARIŞTIRMA:
    //   wantsSitdown  = YALNIZ arama terimine bakar. Spesifik bir şey aranırken
    //                   (kokoreç, kumpir...) mutfak/amenity daraltmasını yönetir.
    //                   Buraya sohbet metnini KARIŞTIRMAK regresyon olurdu:
    //                   "bira içerken kokoreç" → amenity restaurant'a kilitlenir,
    //                   kokoreççiler (fast_food) elenir, sonuç boşalırdı.
    //   oturmaliNiyet = arama terimi + kullanıcının cümlesi. YALNIZ genel kova
    //                   seçiminde kullanılır (aşağıda). Canlı kusur buradaydı:
    //                   model genel isteklerde `arama`yı boş bırakınca ("gece
    //                   yemeği ve bira" → arama:"") sinyal ölüyor, fast_food
    //                   kovası açık kalıyor ve kartlara büfe/çiğköfteci düşüyordu.
    const wantsSitdown = OTURMALI_RE.test(query);
    const oturmaliNiyet = OTURMALI_RE.test(niyetMetni);
    // İÇKİ NİYETİ: yemek isteğinin yanında bira/rakı/şarap/kokteyl geçiyorsa
    // kullanıcı "oturup içki de içebileceğimiz yer" istiyordur. Bu durumda yemek
    // kovası SADECE restoran değil, bar/pub'ı da kapsar (canlı istek: "gece
    // yemeği ve bira" → oturmalı restoran/meyhane/bar).
    const alkolNiyeti =
      /\bbira\b|birahane|\bpub\b|kokteyl|kokteil|şarap|sarap|\biçki\b|\bicki\b|alkol|rakı|raki|meyhane/i.test(
        niyetMetni,
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
    // ── SİNEMA NİYETİ (18 AĞU — CANLI BUG: "sinema bulamamışım" + Google Maps) ──
    // ⚠️ KÖK NEDEN VERİDE DEĞİL SORGUDAYDI. `activity` kovası KARMA
    // (park + spor + fitness + bowling + oyun salonu + sinema) ve sinemayı
    // daraltmanın TEK yolu Tier B'deki İSİM süzgeciydi. GERÇEK ÖLÇÜM
    // (Ümraniye 41.0166,29.1244 / 5 km / canlı Overpass): amenity=cinema → 6
    // sinema VAR, isimleri "Paribu Cineverse", "Cinemaximum", "Cinematica" —
    // HİÇBİRİNDE "sinema" kelimesi GEÇMİYOR. Yani /sinema/i süzgeci 0 eşleşme
    // veriyor, akış `broadened=true` ile tüm kovaya genişliyor ve parklar
    // sinemalardan kat kat yoğun olduğu için en yakın 12'nin hepsi PARK
    // oluyordu → model "sinema bulamadım" deyip dış servise kaçıyordu.
    // ÇÖZÜM: sinema isteğini İSİMLE değil TAG ile daralt.
    // ⚠️ YENİ TÜR KODU EKLENMEDİ (ör. "cinema"/"sinema"): live-index.html
    // kendi LOC_TYPES beyaz listesini taşıyor ["food","cafe","dessert","bar",
    // "activity"] ve TANIMADIĞI türü sessizce "food"a düşürür → sinema isteği
    // restorana dönerdi. Bu yüzden çözüm `activity` kovasının İÇİNDE.
    // vizyon: "televizyon" bu kuralı TETİKLEMESİN diye kelime sınırı ŞART.
    const cinemaIntent =
      !meyhaneIntent &&
      /sinema|cinema|vizyon|film izle|filme gid|matine|seans/i.test(query);
    if (cinemaIntent) typeKey = "activity";
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
    // SİNEMA: karma `activity` kovasını tek TAG'e indir (yukarıdaki bloğa bak).
    // Selektör dizesi OVERPASS_FILTERS.activity içindekiyle BİREBİR AYNI →
    // yeni sorgu biçimi icat edilmiyor, mevcut beyaz listenin dışına çıkılmıyor.
    if (cinemaIntent && typeKey === "activity") {
      bucketSelectors = ['["amenity"="cinema"]'];
    }
    // Oturmalı/içkili istekte yemek bucket'ını SADECE restaurant'a daralt (fast_food
    // = büfe/Domino's/dönerci-tezgah → şarap servisi yok, oturmalı değil → ELE).
    // İÇKİ de isteniyorsa bar/pub kovası EKLENİR: "gece yemeği ve bira" isteğinde
    // kullanıcının beklediği küme oturmalı restoran + meyhane + bar'dır.
    const alkolluYemek = typeKey === "food" && oturmaliNiyet && alkolNiyeti;
    if (typeKey === "food" && oturmaliNiyet) {
      bucketSelectors = alkolluYemek
        ? ['["amenity"="restaurant"]', '["amenity"="bar"]', '["amenity"="pub"]']
        : ['["amenity"="restaurant"]'];
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
    // ⚠️⚠️ SÜRE BÜTÇESİ (2 AĞU akşam — CANLIDA ASKIDA KALMA SEBEBİ)
    // Eski hâlde ÜST SINIR YOKTU ve çarpım felaketti:
    //   4 mirror × 30sn = 120sn  ×  (1 + 3 yarıçap genişlemesi) = 480sn
    //   × 3 araç turu (MAX_TOOL_TURN) = 24 DAKİKA → istek hiç dönmüyordu.
    // Bu bomba TomTom'dan ÖNCE de vardı; ilk yarıçap genelde tuttuğu için hiç
    // patlamamıştı. TomTom başarısız olup yedeğe düşülünce ilk kez tetiklendi.
    // ➜ Artık TEK bir mutlak son tarih var: ne kadar mirror/yarıçap denenirse
    //   denensin /nearby'nin Overpass evresi bunu AŞAMAZ. Süre biterse elde ne
    //   varsa onunla devam edilir (boş liste de olabilir — dürüst "bulamadım").
    const OVERPASS_BUDGET_MS = 16000;
    const _ovDeadline = Date.now() + OVERPASS_BUDGET_MS;
    const _ovLeft = () => _ovDeadline - Date.now();

    async function runOverpass(r, sels) {
      const blocks = sels
        .map(
          (s) =>
            `node${s}(around:${r},${lat},${lng});way${s}(around:${r},${lat},${lng});`,
        )
        .join("");
      const q = `[out:json][timeout:25];(${blocks});out center 60;`;
      for (const endpoint of OVERPASS_ENDPOINTS) {
        // Bütçe bittiyse kalan mirror'ları HİÇ deneme.
        if (_ovLeft() <= 1000) {
          console.warn("Overpass süre bütçesi doldu → kalan mirror'lar atlandı");
          return [];
        }
        try {
          const ctrl = new AbortController();
          // Tek istek 30sn değil: kalan bütçe ile 7sn'nin KÜÇÜĞÜ. Tek yavaş
          // mirror tüm isteği yutamasın.
          const timer = setTimeout(
            () => ctrl.abort(),
            Math.max(1000, Math.min(7000, _ovLeft())),
          );
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
        // Yarıçap genişletmesi de bütçeye tabi: her adım yeni bir tam mirror
        // turu demek. Bütçe bitmişse "biraz daha deneyelim" YAPMA — kullanıcı
        // dakikalarca bekleyeceğine dürüst "bulamadım" alsın.
        if (_ovLeft() <= 2000) {
          console.warn("Overpass bütçesi doldu → yarıçap genişletme durduruldu");
          break;
        }
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
    // ⚠️ SİNEMADA İPUCU KURALI ÇALIŞMAZ: çalışırsa Tier B devreye girip kovayı
    // İSİMLE süzer, "Cinemaximum/Cineverse" isimleri tutmaz ve akış parklara
    // GERİ genişler (düzeltilen bug budur). Sinemada daraltma zaten TAG ile
    // yapıldı → rule null kalsın, "Bucket varsayılanı" dalı amenity=cinema'yı
    // yarıçap merdiveniyle (2,5 → 5 → 12 → 25 km) çalıştırsın.
    if ((hintCuisine || hintShop || hintIsim) && !cinemaIntent) {
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
    const ttUygun =
      ["food", "cafe", "dessert"].includes(typeKey) || cinemaIntent;
    if (KM_PLACES === "tomtom" && ttUygun) {
      // Sinemada serbest metin YASAK (bkz. yukarıdaki not) → sabit terim.
      const searchTerm = cinemaIntent
        ? "sinema"
        : (query || String(hintIsim || "").split("|")[0] || "").trim();
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
            // Düğün salonu / catering / yemekhane gibi "gidilemez" yerler:
            // TomTom yolu OSM boru hattını ATLADIĞI için bu süzgeç BURADA da
            // olmak zorunda (yoksa yalnız OSM tarafı korunur).
            if (
              ["food", "cafe", "dessert"].includes(typeKey) &&
              NON_DINING_NAME.test(String(p.name))
            )
              return false;
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

    const seen = Object.create(null); // prototipsiz: "constructor"/"toString" adlı seçenek sessizce elenmesin
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
        // Düğün/nikah salonu, catering, yemekhane, kantin → yemeğe GİDİLEN yer
        // değil; yeme-içme kovalarında kart olamaz (canlı kusur, 20 Ağu).
        if (
          ["food", "cafe", "dessert"].includes(typeKey) &&
          NON_DINING_NAME.test(String(name))
        )
          return null;
        // Spesifik et/kebap/döner/köfte/ızgara isteğinde çiğköfte zincirleri (Komagene
        // vb.) alakasız → ele. Yalnız çiğköfte'nin KENDİSİ istenmedikçe uygulanır.
        if (
          rule &&
          rule.label !== "çiğ köfte" &&
          CIGKOFTE_CHAINS.test(String(name))
        )
          return null;
        // BAR aramasında içki mekanı OLMAYAN yerleri ele (spor/dernek/otel).
        // İçkili yemek isteğinde bar/pub selektörleri de açık → aynı süzgeç şart.
        if (typeKey === "bar" || alkolluYemek) {
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
            "İMLA: Mekan adını listedeki yazımıyla kopyala; ada gelen ek kesmeyle bağlanır (\"Kadıköy'de\", \"Nusr-Et'e\"). Soru eki ayrı yazılır, kesme almaz ve son ünlüye uyar: a/ı → mı, e/i → mi, o/u → mu, ö/ü → mü (\"Burger mi\", \"Yabancı mı\"). İngilizce kelime ve teknik terim (sistem, harita, API, kart çekme) kullanma. " +
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

// ══════════════════════════════════════════════════════════════════════════
// ── PUSH BİLDİRİM (2 AĞU 2026) ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// MİMARİ KARARI — TOPIC, TOKEN KOLEKSİYONU DEĞİL:
// Klasik yol "her cihazın FCM token'ını Firestore'da tut, gönderirken hepsini
// oku, multicast at" olurdu. Bu, 17 Tem'de tüm Firestore'u durduran desenin
// AYNISI ([[firestore-kota-kacagi]]): her bildirimde koleksiyon taraması.
// Bunun yerine FCM TOPIC:
//   • `tum-kullanicilar`  → herkese duyuru / oto bildirim / sponsorlu push
//   • `oda_<KOD>`         → SADECE o odadakilere (hedefli ama tarama YOK)
// Gönderim = tek API çağrısı, **0 Firestore okuması**. Token hiç saklanmıyor.
//
// ⚠️ Cloud Functions KULLANILMIYOR — Blaze planı ister. Bu sunucu yeterli.
// ⚠️ 16 AĞU — UID DEĞİŞTİ (eski: gq8uRlcr4TOwe41qWnKk18DZ0Wt1). Uygulama içi
// "Hesabımı Sil" testinde Auth kaydı silindi → aynı e-posta yeniden girince
// YENİ UID aldı. UID değişirse admin.html ve firestore.rules de güncellenmeli.
// ⭐ İKİ HESAP birden yetkili: biri silinirse/kaybolursa panel diğeriyle
// açılabilsin. [0] = ufukkurucan7@gmail.com, [1] = asytechstudio@gmail.com
const ADMIN_UIDS = [
  "r3vZcg4qouP1Kjo1WHjAkZR7eOL2",
  "Zc0eea7rhQMuKK42WaTpNmS9HRi1",
];
const isAdminUid = (u) => ADMIN_UIDS.includes(u);
const TOPIC_ALL = "tum-kullanicilar";

// FCM topic adı kuralı: [a-zA-Z0-9-_.~%]+ . Oda kodu dışarıdan geldiği için
// beyaz listeyle temizlenir (enjeksiyon/geçersiz topic'e karşı).
function safeTopic(t) {
  return String(t || "").replace(/[^a-zA-Z0-9\-_.~%]/g, "").slice(0, 200);
}

// Bearer token → UID. Hata durumunda null (çağıran 401 döndürür).
async function uidFromReq(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  try {
    const d = await getAuth().verifyIdToken(h.slice(7));
    return d.uid || null;
  } catch (e) {
    return null;
  }
}

/**
 * Tek noktadan gönderim. Bildirim gövdesi BURADA kurulur ki tıklama davranışı
 * (deep link) her yerde aynı olsun.
 * @param {{topic:string,title:string,body:string,room?:string,url?:string}} o
 */
async function sendPush(o) {
  const topic = safeTopic(o.topic);
  if (!topic) throw new Error("Geçersiz topic");
  const data = {};
  // ⭐ TIKLAMA HEDEFİ: `room` varsa uygulama o odayı açar (client tarafında
  // mevcut ?room= akışına bağlanır), yoksa `url`, o da yoksa ana ekran.
  if (o.room) data.room = String(o.room).slice(0, 12);
  if (o.url) data.url = String(o.url).slice(0, 300);
  return getMessaging().send({
    topic,
    notification: {
      title: String(o.title || "").slice(0, 80),
      body: String(o.body || "").slice(0, 200),
    },
    data,
    android: {
      priority: "high",
      notification: {
        // ⚠️ KANAL — Android 8+ (API 26) ses/titreşim/önem KANALIN özelliğidir,
        // bildirimin değil. Bu id client'taki KM_PUSH.CHANNEL_ID ile BİREBİR
        // aynı olmalı; client o kanalı merci_ding sesiyle oluşturuyor. Buraya
        // channelId yazılmazsa Android varsayılan kanalı kullanır ve ÖZEL SES
        // ÇALMAZ (aşağıdaki `sound` alanı yalnız API 26 ALTINDA etkilidir).
        // ⚠️ Sesi değiştirmek gerekirse client'ta ve BURADA id'yi merci_v2 yap;
        // var olan kanalın sesi programatik olarak DEĞİŞTİRİLEMEZ.
        channelId: "merci_v1",
        sound: "merci_ding", // API 26 altı için (uzantısız, res/raw)
        // ⚠️ Bu ad android/app/src/main/res/drawable/ic_stat_notify.xml ile
        // BİREBİR eşleşmeli. Önce "ic_stat_icon" yazmıştım — öyle bir kaynak
        // YOKTU; Android bilinmeyen ikon adında bildirimi ya hiç göstermez ya
        // da beyaz kare basar. Tek renk silüet olması da şart (API 21+ maskeler).
        icon: "ic_stat_notify",
        color: "#7c3aed",
        // ⚠️⚠️ BURADA `clickAction: "FLUTTER_NOTIFICATION_CLICK"` VARDI — CANLI
        // BUG'IN SEBEBİ BUYDU (2 Ağu cihaz testi: "bildirim geliyor ama
        // tıklayınca uygulama açılmıyor").
        // clickAction, bildirime dokununca ATEŞLENECEK INTENT ACTION'ını belirler.
        // "FLUTTER_NOTIFICATION_CLICK" bir FLUTTER sözleşmesidir; Flutter'ın FCM
        // eklentisi manifest'ine o action için intent-filter koyar. Bizim
        // uygulamamız CAPACITOR ve MainActivity'de öyle bir filtre YOK → dokunuş
        // hiçbir aktivitenin karşılamadığı bir intent üretiyor → HİÇBİR ŞEY OLMUYOR.
        // clickAction VERİLMEZSE FCM varsayılana döner: uygulamanın launcher
        // aktivitesini açar ve data payload'ını intent'e koyar; Capacitor eklentisi
        // de notificationActionPerformed olayını tetikler. Doğru davranış budur.
        // ⚠️ Buraya clickAction EKLEME.
      },
    },
    // ⭐ 19 AĞU — iOS BLOĞU EKSİKTİ. iOS 1.0.1 canlıya çıktı ama bu mesajda hiç
    // `apns` yoktu: FCM `notification` payload'ını APNs'e çevirirken `aps.sound`
    // YAZMAZ → bildirim iPhone'a SESSİZ düşer (ses yok, titreşim yok, yalnız
    // listede belirir). Kullanıcı sonucu kaçırır; Android'de ses çaldığı için
    // kusur uzun süre görünmez kalır.
    // `apns-priority: 10` = hemen teslim et. Varsayılan 5 "güç tasarrufu"
    // sınıfıdır: iOS teslimi gruplayıp DAKİKALARCA geciktirebilir — oylama
    // sonucu gibi anlık bir bildirim için yanlış sınıf.
    // ⚠️ sound "default" BİLEREK: Android'deki merci_ding res/raw'da duruyor,
    // iOS paketinde (Runner bundle) KARŞILIĞI YOK. Olmayan bir ses adı yazmak
    // iOS'ta bildirimi yine SESSİZ yapar. Özel ses istenirse önce .caf dosyası
    // bundle'a eklenmeli, sonra burası değişmeli.
    apns: {
      headers: { "apns-priority": "10" },
      payload: { aps: { sound: "default" } },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN İSTATİSTİK — /admin/stats
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️⚠️ KOTA TASARIMI — BU UCUN VAROLUŞ SEBEBİ.
// Panel eskiden sayıları kendi hesaplıyordu: aiUsage 1000 + bans 500 + rooms 400
// + feedback 300 + merci_feedback 300 ... = tüm sekmeler gezildiğinde ~2570
// Firestore OKUMASI. Günde birkaç tur = 10K+ okuma; Spark tavanı 50K/gün ve
// 17 Tem'de o tavan dolunca Firestore KOMPLE durmuştu ([[firestore-kota-kacagi]]).
// ⭐ Burada dokümanlar İNDİRİLMİYOR: Firestore aggregation (count/sum) sunucuda
// çalışıyor, faturalandırma 1000 indeks girişi başına 1 okuma. Tüm gösterge
// tablosu ≈ birkaç okuma. Üstüne 60 sn önbellek → panel arka arkaya açılsa da
// sorgu tekrarlanmaz.
// ⛔ BURAYA ".get()" İLE KOLEKSİYON ÇEKME EKLEME. Sayacak bir şey varsa
//    .count() / AggregateField.sum() kullan.
const STATS_TTL_MS = 60 * 1000;
let _statsCache = { at: 0, data: null };

// Auth kullanıcı sayımı Firestore DEĞİL (kota yakmaz) ama yine de pahalı bir
// listeleme → ayrı ve daha uzun önbellek (5 dk).
const AUTH_TTL_MS = 5 * 60 * 1000;
let _authCache = { at: 0, data: null };

async function sayAuthKullanicilari() {
  if (_authCache.data && Date.now() - _authCache.at < AUTH_TTL_MS)
    return _authCache.data;
  let toplam = 0,
    yeni7 = 0,
    yeni30 = 0,
    sayfa,
    tur = 0;
  const simdi = Date.now();
  const g7 = simdi - 7 * 86400000;
  const g30 = simdi - 30 * 86400000;
  do {
    const r = await getAuth().listUsers(1000, sayfa);
    r.users.forEach((u) => {
      toplam++;
      const t = Date.parse((u.metadata && u.metadata.creationTime) || "");
      if (!Number.isFinite(t)) return;
      if (t >= g7) yeni7++;
      if (t >= g30) yeni30++;
    });
    sayfa = r.pageToken;
    tur++;
    // Güvenlik tavanı: 20 sayfa = 20.000 kullanıcı. Aşarsa sayı "20000+" olur;
    // o boyutta zaten sayaç dokümanına geçmek gerekir.
    if (tur >= 20) break;
  } while (sayfa);
  const d = { toplam, yeni7, yeni30, kesildi: !!sayfa };
  _authCache = { at: Date.now(), data: d };
  return d;
}

// Tek bir sayımı güvenle çalıştır: indeks eksikse/hata varsa null döner ve
// gösterge tablosunun tamamı çökmez (o satır "—" gösterilir).
async function guvenliSayim(etiket, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error("stats/" + etiket + ":", e.code || "", e.message);
    return null;
  }
}

app.get("/admin/stats", rateLimit, async (req, res) => {
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "Oturum doğrulanamadı." });
  if (!isAdminUid(uid)) return res.status(403).json({ error: "Yetkin yok." });

  if (_statsCache.data && Date.now() - _statsCache.at < STATS_TTL_MS)
    return res.json({ ...(_statsCache.data), onbellek: true });

  const bugunBas = new Date();
  bugunBas.setHours(0, 0, 0, 0);
  const bugunMs = bugunBas.getTime();
  const dunMs = bugunMs - 86400000;
  const bugunUTC = new Date().toISOString().slice(0, 10);
  const say = (q) => q.count().get().then((s) => s.data().count);

  try {
    const [
      auth,
      pro,
      odaBugun,
      odaDun,
      odaAcik,
      odaToplam,
      aiBugun,
      aiKisiBugun,
      begeni,
      begenmeme,
      ulasin,
      kararBugun,
    ] = await Promise.all([
      guvenliSayim("auth", () => sayAuthKullanicilari()),
      guvenliSayim("pro", () =>
        say(adminDb.collection("users").where("isPro", "==", true)),
      ),
      guvenliSayim("odaBugun", () =>
        say(adminDb.collection("rooms").where("created", ">=", bugunMs)),
      ),
      guvenliSayim("odaDun", () =>
        say(
          adminDb
            .collection("rooms")
            .where("created", ">=", dunMs)
            .where("created", "<", bugunMs),
        ),
      ),
      guvenliSayim("odaAcik", () =>
        say(adminDb.collection("rooms").where("status", "==", "open")),
      ),
      guvenliSayim("odaToplam", () => say(adminDb.collection("rooms"))),
      // Bugünkü AI MESAJ sayısı: aiUsage/{uid}_{tarih}.count alanlarının TOPLAMI.
      guvenliSayim("aiBugun", () =>
        adminDb
          .collection("aiUsage")
          .where("date", "==", bugunUTC)
          .aggregate({ t: AggregateField.sum("count") })
          .get()
          .then((s) => s.data().t || 0),
      ),
      // Bugün AI kullanan KİŞİ sayısı (doküman başına bir kullanıcı).
      guvenliSayim("aiKisi", () =>
        say(adminDb.collection("aiUsage").where("date", "==", bugunUTC)),
      ),
      guvenliSayim("begeni", () =>
        say(adminDb.collection("merci_feedback").where("vote", "==", "like")),
      ),
      guvenliSayim("begenmeme", () =>
        say(adminDb.collection("merci_feedback").where("vote", "==", "dislike")),
      ),
      guvenliSayim("ulasin", () => say(adminDb.collection("feedback"))),
      // ⚠️ Karar sayısı ARTIK EKSİK: 16 Ağu'dan beri ücretsiz kullanıcıların
      // geçmişi Firestore'a YAZILMIYOR (kota tasarrufu) → bu sayı yalnız PRO
      // kullanıcıları kapsar. Panelde bu not gösteriliyor.
      // collectionGroup sorgusu ayrı indeks ister; yoksa null döner, çökmez.
      guvenliSayim("kararBugun", () =>
        say(
          adminDb
            .collectionGroup("history")
            .where("ts", ">=", bugunMs),
        ),
      ),
    ]);

    const data = {
      zaman: Date.now(),
      kullanici: auth || { toplam: null, yeni7: null, yeni30: null },
      pro,
      oda: {
        bugun: odaBugun,
        dun: odaDun,
        acik: odaAcik,
        toplam: odaToplam,
      },
      ai: { mesajBugun: aiBugun, kisiBugun: aiKisiBugun },
      merci: { begeni, begenmeme },
      ulasin,
      kararBugun,
      // Panelin uyarı basması için: bu sayı yalnız PRO'yu kapsıyor.
      kararNot: "16 Ağu'dan beri yalnız PRO kullanıcıların kararları kaydediliyor",
    };
    _statsCache = { at: Date.now(), data };
    res.json({ ...data, onbellek: false });
  } catch (e) {
    console.error("admin/stats hata:", e.message);
    res.status(500).json({ error: "İstatistik okunamadı." });
  }
});

// ── ADMIN: KULLANICI ARA (destek yazışması için) ─────────────────────────
// E-posta veya UID ile tek kullanıcı. Auth'tan kimlik, Firestore'dan PRO durumu
// ve karar sayısı. ⚠️ Hepsi TEK dokümanlık okuma + 1 aggregation — liste YOK.
app.get("/admin/user", rateLimit, async (req, res) => {
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "Oturum doğrulanamadı." });
  if (!isAdminUid(uid)) return res.status(403).json({ error: "Yetkin yok." });
  const q = String(req.query.q || "").trim();
  if (!q || q.length > 200)
    return res.status(400).json({ error: "Arama boş ya da çok uzun." });
  try {
    let u = null;
    try {
      u = q.includes("@")
        ? await getAuth().getUserByEmail(q)
        : await getAuth().getUser(q);
    } catch (e) {
      return res.status(404).json({ error: "Kullanıcı bulunamadı." });
    }
    const [profil, kararSayisi, ban] = await Promise.all([
      guvenliSayim("user/profil", () =>
        adminDb
          .collection("users")
          .doc(u.uid)
          .get()
          .then((s) => (s.exists ? s.data() : null)),
      ),
      guvenliSayim("user/karar", () =>
        adminDb
          .collection("decisions")
          .doc(u.uid)
          .collection("history")
          .count()
          .get()
          .then((s) => s.data().count),
      ),
      guvenliSayim("user/ban", () =>
        adminDb
          .collection("bans")
          .doc(u.uid)
          .get()
          .then((s) => s.exists),
      ),
    ]);
    res.json({
      uid: u.uid,
      email: u.email || null,
      ad: u.displayName || null,
      olusturma: (u.metadata && u.metadata.creationTime) || null,
      sonGiris: (u.metadata && u.metadata.lastSignInTime) || null,
      saglayici: (u.providerData || []).map((p) => p.providerId),
      devreDisi: !!u.disabled,
      pro: profil ? isProValid(profil) : false,
      proAlan: profil ? profil.isPro === true : false,
      proBitis: profil && profil.proExpiresAt ? profil.proExpiresAt : null,
      kararSayisi,
      banli: ban === true,
    });
  } catch (e) {
    console.error("admin/user hata:", e.message);
    res.status(500).json({ error: "Okunamadı." });
  }
});

// ── ADMIN: PRO HEDİYE ET / GERİ AL ───────────────────────────────────────
// ⚠️ users/{uid}.isPro'yu İSTEMCİ değiştiremez (Firestore kuralı isPro'nun
// değişmesini engelliyor) — bu yüzden buradan, Admin SDK ile yazılıyor.
// ⚠️ RevenueCat aboneliğini ETKİLEMEZ: client isPremium'u iki kaynağın OR'u
// olarak hesaplıyor (RC + Firestore), yani bu yalnız Firestore ayağını açar.
app.post("/admin/gift-pro", rateLimit, async (req, res) => {
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "Oturum doğrulanamadı." });
  if (!isAdminUid(uid)) return res.status(403).json({ error: "Yetkin yok." });
  const hedef = String((req.body && req.body.uid) || "").trim();
  const gun = Number((req.body && req.body.gun) || 0);
  const kapat = (req.body && req.body.kapat) === true;
  if (!hedef || hedef.length > 128)
    return res.status(400).json({ error: "Hedef UID geçersiz." });
  if (!kapat && (!Number.isFinite(gun) || gun < 1 || gun > 3650))
    return res.status(400).json({ error: "Gün 1-3650 arasında olmalı." });
  try {
    if (kapat) {
      await adminDb
        .collection("users")
        .doc(hedef)
        .set({ isPro: false, proExpiresAt: null }, { merge: true });
      return res.json({ ok: true, pro: false });
    }
    const bitis = Date.now() + gun * 86400000;
    await adminDb
      .collection("users")
      .doc(hedef)
      .set(
        { isPro: true, proExpiresAt: bitis, proKaynak: "admin-hediye" },
        { merge: true },
      );
    res.json({ ok: true, pro: true, bitis });
  } catch (e) {
    console.error("admin/gift-pro hata:", e.message);
    res.status(500).json({ error: "Yazılamadı." });
  }
});

// ── UYGULAMA İÇİ DUYURU BANDI ────────────────────────────────────────────
// ⚠️⚠️ KOTA: duyuruyu Firestore'da tutup HER İSTEMCİNİN açılışta okuması
// kullanıcı×açılış kadar okuma demekti (1000 kullanıcı = günde 1000+ okuma,
// hiçbir duyuru yokken bile). Bunun yerine metin SUNUCU BELLEĞİNDE duruyor ve
// GET /announce ile dağıtılıyor → Firestore okuması SIFIR.
// ⚠️ Bedeli kabul edildi: sunucu yeniden başlarsa duyuru düşer. Kalıcı olması
// gerekirse tek dokümanlık bir okumayla açılışta yüklenebilir — şimdilik
// duyurular kısa ömürlü (bakım/uyarı) olduğu için gereksiz.
let _duyuru = { metin: "", tur: "bilgi", bitis: 0 };
app.get("/announce", (req, res) => {
  const d = _duyuru;
  if (!d.metin || (d.bitis && d.bitis < Date.now()))
    return res.json({ var: false });
  res.json({ var: true, metin: d.metin, tur: d.tur, bitis: d.bitis });
});
app.post("/admin/announce", rateLimit, async (req, res) => {
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "Oturum doğrulanamadı." });
  if (!isAdminUid(uid)) return res.status(403).json({ error: "Yetkin yok." });
  const metin = String((req.body && req.body.metin) || "").slice(0, 200);
  const tur = ["bilgi", "uyari", "bakim"].includes((req.body || {}).tur)
    ? req.body.tur
    : "bilgi";
  const saat = Number((req.body && req.body.saat) || 0);
  _duyuru = {
    metin,
    tur,
    bitis: metin && saat > 0 ? Date.now() + saat * 3600000 : 0,
  };
  res.json({ ok: true, duyuru: _duyuru });
});

// Gönderilenlerin kaydı (admin panelde "son gönderilenler"). Tek doküman
// yazımı — koleksiyon taraması YOK.
async function logPush(rec) {
  try {
    await adminDb.collection("pushLog").add({
      ...rec,
      at: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error("pushLog yazılamadı:", e.message);
  }
}

// ── 1) ADMIN: ELLE BİLDİRİM ──────────────────────────────────────────────
app.post("/admin/push", rateLimit, async (req, res) => {
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "Oturum doğrulanamadı." });
  if (!isAdminUid(uid)) return res.status(403).json({ error: "Yetkin yok." });
  const { title, body, url } = req.body || {};
  const topic = safeTopic((req.body && req.body.topic) || TOPIC_ALL);
  if (!title || !body)
    return res.status(400).json({ error: "Başlık ve metin zorunlu." });
  try {
    const id = await sendPush({ topic, title, body, url });
    await logPush({ title, body, url: url || "", topic, by: "admin", ok: true });
    res.json({ ok: true, id, topic });
  } catch (e) {
    console.error("admin/push hata:", e.message);
    await logPush({ title, body, topic, by: "admin", ok: false, err: e.message });
    res.status(500).json({ error: "Gönderilemedi: " + e.message });
  }
});

// ── 2) ODA SONUCU → SADECE O ODADAKİLERE ─────────────────────────────────
// ⚠️ TETİĞİ HOST'UN CLIENT'I ÇEKER. Sunucunun Firestore'u periyodik taraması
// KESİNLİKLE YOK (17 Tem dersi). live-index.html'de sonucu YALNIZ host yazıyor
// (`amHost` → status:"closed"), dolayısıyla tetik tam olarak orada, bir kez.
// Sunucu sadece TEK oda dokümanını okuyup doğrular = 1 okuma.
app.post("/room/notify", rateLimit, async (req, res) => {
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "Oturum doğrulanamadı." });
  const code = String((req.body && req.body.room) || "").trim();
  if (!/^[A-Za-z0-9-]{3,12}$/.test(code))
    return res.status(400).json({ error: "Oda kodu geçersiz." });
  const kind = String((req.body && req.body.kind) || "result");
  try {
    // ⚠️ 16 AĞU — YETKİ GENİŞLETİLDİ, SEBEBİ ÖNEMLİ:
    // Eskiden yalnız `r.hostUid === uid` geçiyordu. Ama odayı host DEĞİL,
    // süre dolunca odada kalan HERHANGİ bir katılımcı da kapatabiliyor
    // (client `deadlineClose`). O durumda sonuç Firestore'a yazılıyor, ama
    // bildirim 403 yiyip düşüyordu → katılımcılar sonuçtan habersiz kalıyordu.
    // ⭐ Yerine gelen koruma DAHA GÜÇLÜ, çünkü artık yetkiye değil DURUMA bakıyor:
    //   1) Oda gerçekten kapanmış ve kazanan yazılmış olmalı (aşağıda),
    //   2) Bildirim oda başına TEK KEZ gider (notifiedAt kilidi),
    //   3) İstek sahibi giriş yapmış olmalı (uidFromReq).
    // Oda kodunu bilen biri zaten odayı kapatabiliyordu (Firestore kuralı
    // `rooms` update'ine girişli herkese izin veriyor), dolayısıyla hostUid
    // kontrolü spam'i engellemiyordu; notifiedAt engelliyor.

    // ⚠️ YALNIZ "result" DESTEKLENİYOR (2 Ağu kararı). "Odaya davet edildin"
    // bildirimi BİLEREK YOK: davet WhatsApp'tan ?room= linkiyle gidiyor, sistem
    // davet edilenin KİMLİĞİNİ bilmiyor → hedeflenecek topic yok. Profil/arkadaş
    // listesi olmadan bu teknik olarak imkânsız, uygulaması olmayana zaten push
    // gönderilemez. Profil özelliği gelirse `user_<UID>` topic'iyle eklenebilir.
    if (kind !== "result")
      return res.status(400).json({ error: "Bilinmeyen bildirim türü." });

    // ⚠️ DOĞRULAMA + KİLİT TEK TRANSACTION'DA olmak zorunda. Ayrı get→update
    // yazılsaydı, odayı kapatan kişi belli olmadığı için (deadlineClose'u
    // odadaki HERKES çağırabilir) iki katılımcı aynı anda tetiklediğinde ikisi
    // de notifiedAt'ı boş görüp AYNI bildirimi iki kez gönderirdi.
    const ref = adminDb.collection("rooms").doc(code);
    const durum = await adminDb.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) return "yok";
      const r = fresh.data() || {};
      // Sonuç gerçekten açıklanmış olmalı — "closed" değilken bildirim YOK.
      if (r.status !== "closed" || !r.winner) return "acilmadi";
      if (r.notifiedAt) return "zaten";
      tx.update(ref, { notifiedAt: Date.now() });
      return "ok";
    });
    if (durum === "yok") return res.status(404).json({ error: "Oda yok." });
    if (durum === "acilmadi")
      return res.status(409).json({ error: "Sonuç henüz açıklanmadı." });
    if (durum === "zaten")
      return res
        .status(409)
        .json({ error: "Bu oda için bildirim zaten gönderildi." });

    // ⚠️ KAZANANI BİLDİRİMDE YAZMA (2 Ağu kullanıcı kararı). Bildirim gölgeliği
    // sonucu ele verirse uygulamayı açmaya gerek kalmıyor: merak sönüyor,
    // kullanıcı gelmiyor, kutlama anı (konfeti + kart) kaçıyor.
    // Merakı canlı tut, sonucu uygulamada göster.
    const title = "Oylama sonuçlandı! 🐙";
    const body = "Kazananı görmek için dokun 👀";
    const id = await sendPush({ topic: "oda_" + code, title, body, room: code });
    await logPush({ title, body, topic: "oda_" + code, by: uid, kind, ok: true });
    res.json({ ok: true, id });
  } catch (e) {
    console.error("room/notify hata:", e.message);
    res.status(500).json({ error: "Gönderilemedi." });
  }
});

// ── 2b) "HERKES OY VERDİ" KAPANIŞI — HOST OLMADAN ────────────────────────
// ⭐ 19 AĞU TESPİTİ (kullanıcı sordu: "herkes oy kullanınca da bildirim gelir
// değil mi?"). GELMİYORDU.
// Odanın dolu olup herkesin oy vermesi durumunda anında kapanmasını sağlayan
// `checkAutoClose` (live-index.html) YALNIZ TEK BİR YERDE çağrılıyor:
// `listenRoomAsHost` dinleyicisinin içinde. Yani **host uygulamayı kapattıysa
// o kontrolü çalıştıran kimse kalmıyor** → son oy verildiği hâlde oda açık
// kalıyor, sonuç ancak `closesAt` dolunca (en kötü 24 saat sonra) çıkıyor.
// Katılımcı bunu client'tan kendi de yapamaz: Firestore kuralı `yalnizKatilimci`
// yalnız `participants` alanına izin veriyor, `sureDolduKapanis` ise closesAt
// dolmadan status yazdırmıyor → süre dolmadan katılımcının odayı kapatması
// KURAL SEVİYESİNDE imkânsız.
// ⭐ Çözüm: tetiği client çeker, kararı ve yazmayı SUNUCU verir (Admin SDK
// kuralları bypass eder). /room/notify ile aynı felsefe — sunucu TEK doküman
// okur, koleksiyon TARAMASI YOK (17 Tem kota dersi).
// ⚠️ KOŞUL client'taki checkAutoClose ile BİREBİR AYNI olmalı: oda DOLU
// (katılan >= maxParticipants) VE katılan herkes oy vermiş. Gevşetilirse host
// varken/yokken farklı davranış olur, kullanıcı tutarsızlık görür.
// ⚠️ BERABERLİKTE KAZANAN SEÇMEZ: client tie'da "tied" yazıp çarkı açıyor;
// burada da aynısı yapılır ki odada duran varsa çarkı görsün. Kimse yoksa
// resolveStuckTiedRooms süre dolduktan sonra devralır.
// Kararı veren saf fonksiyon — express'ten AYRI tutuldu ki test-tie-sweep.js
// gerçek kaynağı çekip çalıştırabilsin (uç noktanın içine gömülseydi mock'lanamazdı).
// Dönen: null → koşul sağlanmadı (oda açık kalır) · {durum, patch} → yazılacak alanlar.
function odaTamamKapanis(data) {
  const parts = (data && data.participants) || {};
  const keys = Object.keys(parts);
  const submitted = keys.filter(
    (k) => parts[k] && parts[k].submitted === true,
  ).length;
  const maxP = (data && data.maxParticipants) || 0;
  // ⚠️ client checkAutoClose ile BİREBİR koşul: oda DOLU + katılan herkes oy verdi.
  if (!(keys.length > 0 && keys.length >= maxP && submitted >= keys.length))
    return null;
  const options = Array.isArray(data.options) ? data.options : [];
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
  if (winners.length > 1) {
    // Beraberlik → client ile aynı: "tied" yaz, çarkı odadakiler çevirsin.
    // Bildirim YOK (kazanan henüz belli değil). Kimse odada değilse
    // resolveStuckTiedRooms süre dolduktan sonra devralır.
    return {
      durum: "beraberlik",
      patch: {
        status: "tied",
        tieItems: winners,
        winner: null,
        winnerPoints: null,
        winnerVoters: null,
        tbSpin: null,
        tbSeed: null,
        closedBy: "server-complete",
        closedAt: Date.now(),
        // ⭐⭐ ZORUNLU — YOKSA BERABERLİK SAATLERCE ASILI KALIR.
        // Bu yol süre DOLMADAN kapatıyor (herkes erken oy verdi), yani odanın
        // özgün `closesAt`'ı hâlâ GELECEKTE. resolveStuckTiedRooms ise
        // `closesAt <= now - 3dk` sorguluyor → oda, kimse odada olmasa bile
        // özgün süre dolana kadar (10 dk'lık odada 8 dk, 24 saatlik odada
        // SAATLER) beklerdi. "Herkes oy verdi → anında sonuç" vaadi çöpe giderdi.
        // Oylama fiilen BİTTİ, dolayısıyla bitiş zamanı ŞİMDİ'dir: bunu yazınca
        // odada duran varsa 3 dk çarkı çevirebilir, kimse yoksa sunucu devralır.
        // ⚠️ Odanın durumu "tied"; `autoCloseExpiredRooms` (status=="open")
        // bunu görmez, `deadlineClose` de status!=="open" diye erken çıkar —
        // closesAt'ı geriye çekmek başka hiçbir yolu tetiklemez.
        closesAt: Date.now(),
      },
    };
  }
  return {
    durum: "kapandi",
    patch: {
      status: "closed",
      winner: winners[0],
      winnerPoints: topScore,
      winnerVoters: submitted,
      tieItems: [],
      closedBy: "server-complete",
      closedAt: Date.now(),
      // Bildirimi biz göndereceğiz → /room/notify tekrar göndermesin.
      notifiedAt: Date.now(),
    },
  };
}

app.post("/room/autoclose", rateLimit, async (req, res) => {
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "Oturum doğrulanamadı." });
  const code = String((req.body && req.body.room) || "").trim();
  if (!/^[A-Za-z0-9-]{3,12}$/.test(code))
    return res.status(400).json({ error: "Oda kodu geçersiz." });
  try {
    const ref = adminDb.collection("rooms").doc(code);
    const durum = await adminDb.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) return "yok";
      const data = fresh.data() || {};
      if (data.status !== "open") return "acik-degil";
      const karar = odaTamamKapanis(data);
      if (!karar) return "tamamlanmadi";
      tx.update(ref, karar.patch);
      return karar.durum;
    });
    if (durum === "yok") return res.status(404).json({ error: "Oda yok." });
    // Push transaction DIŞINDA (transaction yeniden denenebilir).
    if (durum === "kapandi") await bildirOdaSonucu(code, "autoclose");
    res.json({ ok: durum === "kapandi", durum });
  } catch (e) {
    console.error("room/autoclose hata:", e.message);
    res.status(500).json({ error: "Kapatılamadı." });
  }
});

// ── 3) ZAMANLANMIŞ / OTOMATİK BİLDİRİMLER ────────────────────────────────
// Kullanıcı isteği: "bazen akşam ne yiyorsun diye sorarız, cuma günü hafta sonu
// ne yapıyorsun gibi atarız, ileride sponsorlu push göndeririz."
// → Kodda SABİT metin YOK; admin panelden yönetilen `pushSchedule` kayıtları.
//
// ⚠️⚠️ KOTA TASARIMI (17 Tem dersinin doğrudan uygulaması):
// Zamanlayıcı TÜM koleksiyonu TARAMAZ. `nextAt <= now` ile FİLTRELİ sorgu atar
// → vakti gelmemiş kayıtlar sorguya HİÇ girmez, okunmaz. Sırası gelen yoksa
// dönen doküman sayısı 0 → boşta okuma maliyeti ~0. `nextAt` alanı OLMAYAN
// kayıt hiç indekslenmez, yani devre dışı kayıtlar da bedava.
const PUSH_TICK_MS = 60 * 1000;

// Türkiye UTC+3, yaz saati YOK → TR saatini UTC'ye çevirmek sabit -3 saat.
const TR_OFFSET_H = 3;
function nextRunAt(sch, fromMs) {
  const base = new Date(fromMs || Date.now());
  const hh = Math.min(23, Math.max(0, parseInt(sch.hour, 10) || 0));
  const mm = Math.min(59, Math.max(0, parseInt(sch.minute, 10) || 0));
  const d = new Date(base);
  d.setUTCSeconds(0, 0);
  d.setUTCHours(hh - TR_OFFSET_H, mm, 0, 0);
  if (sch.mode === "weekly") {
    const want = Math.min(6, Math.max(0, parseInt(sch.weekday, 10) || 0));
    // TR gününe göre ilerlet (UTC+3'te gün sınırı kayabilir → TR saatiyle bak)
    for (let i = 0; i < 8; i++) {
      const trDay = new Date(d.getTime() + TR_OFFSET_H * 3600e3).getUTCDay();
      if (trDay === want && d.getTime() > base.getTime()) break;
      d.setUTCDate(d.getUTCDate() + 1);
    }
  } else if (d.getTime() <= base.getTime()) {
    d.setUTCDate(d.getUTCDate() + 1); // günlük: bugünkü saat geçtiyse yarın
  }
  return d;
}

async function pushTick() {
  try {
    const now = Timestamp.now();
    const due = await adminDb
      .collection("pushSchedule")
      .where("active", "==", true)
      .where("nextAt", "<=", now)
      .limit(10)
      .get();
    if (due.empty) return; // ⭐ normal durum: 0 doküman okundu
    for (const doc of due.docs) {
      const s = doc.data() || {};
      try {
        await sendPush({
          topic: safeTopic(s.topic || TOPIC_ALL),
          title: s.title,
          body: s.body,
          url: s.url,
        });
        await logPush({
          title: s.title, body: s.body, topic: s.topic || TOPIC_ALL,
          by: "zamanlayici", scheduleId: doc.id, ok: true,
        });
      } catch (e) {
        console.error("Zamanlanmış push gönderilemedi:", doc.id, e.message);
      }
      // "once" → tek seferlik, gönderince kapan. Diğerleri bir sonraki vakte.
      const upd =
        s.mode === "once"
          ? { active: false, nextAt: FieldValue.delete() }
          : { nextAt: Timestamp.fromDate(nextRunAt(s, Date.now() + 60000)) };
      await doc.ref.set(
        { ...upd, lastSentAt: FieldValue.serverTimestamp(), sentCount: FieldValue.increment(1) },
        { merge: true },
      );
    }
    _tickFails = 0; // başarılı tur → sayaç sıfırlansın
  } catch (e) {
    // En olası sebep: `active + nextAt` composite index'i henüz kurulmamış.
    // ⚠️ Dakikada bir aynı hatayı basmak logu boğar ve gerçek sorunları
    // gizler → 3 ardışık hatadan sonra zamanlayıcıyı DURDUR, tek bir net
    // talimat bırak. Index kurulunca yeniden başlatma yeterli.
    _tickFails++;
    console.error(`pushTick hata (${_tickFails}/3):`, e.message);
    if (_tickFails >= 3 && _tickTimer) {
      clearInterval(_tickTimer);
      _tickTimer = null;
      console.error(
        "🔴 Zamanlanmış bildirim döngüsü DURDURULDU. Muhtemel sebep: Firestore " +
          "composite index eksik (pushSchedule: active ASC, nextAt ASC). " +
          "Index'i kurup sunucuyu yeniden başlat.",
      );
    }
  }
}
let _tickFails = 0;
let _tickTimer = setInterval(pushTick, PUSH_TICK_MS);
_tickTimer.unref?.();

// Admin: zamanlanmış kayıt oluştur/güncelle (nextAt'i SUNUCU hesaplar ki
// panelden yanlış/eksik değer gelse bile zamanlayıcı tutarlı kalsın).
app.post("/admin/push/schedule", rateLimit, async (req, res) => {
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "Oturum doğrulanamadı." });
  if (!isAdminUid(uid)) return res.status(403).json({ error: "Yetkin yok." });
  const b = req.body || {};
  if (!b.title || !b.body)
    return res.status(400).json({ error: "Başlık ve metin zorunlu." });
  const mode = ["once", "daily", "weekly"].includes(b.mode) ? b.mode : "daily";
  const rec = {
    title: String(b.title).slice(0, 80),
    body: String(b.body).slice(0, 200),
    url: String(b.url || "").slice(0, 300),
    topic: safeTopic(b.topic || TOPIC_ALL),
    mode,
    hour: Math.min(23, Math.max(0, parseInt(b.hour, 10) || 0)),
    minute: Math.min(59, Math.max(0, parseInt(b.minute, 10) || 0)),
    weekday: Math.min(6, Math.max(0, parseInt(b.weekday, 10) || 0)),
    active: b.active !== false,
  };
  rec.nextAt = Timestamp.fromDate(nextRunAt(rec, Date.now()));
  try {
    const ref = b.id
      ? adminDb.collection("pushSchedule").doc(String(b.id))
      : adminDb.collection("pushSchedule").doc();
    await ref.set(rec, { merge: true });
    res.json({ ok: true, id: ref.id, nextAt: rec.nextAt.toDate().toISOString() });
  } catch (e) {
    console.error("push/schedule hata:", e.message);
    res.status(500).json({ error: "Kaydedilemedi." });
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

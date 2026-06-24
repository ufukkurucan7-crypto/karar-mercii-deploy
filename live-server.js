const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── FIREBASE ADMIN (kullanıcı doğrulama + sunucu taraflı kota) ──
// Modüler API: firebase-admin v13+ (+ pnpm/Node 24 require-ESM) ile namespace
// export (admin.credential) güvenilir değil; subpath import kullanıyoruz.
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp({
  credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const adminDb = getFirestore();

// Günlük Merci mesaj limitleri (kullanıcı başına). Abuse/maliyet tavanı.
const FREE_DAILY_LIMIT = 60; // abuse tavanı (asıl ücretsiz kapı client'ta: 6/gün + reklam). Yüksek tutuldu ki reklam sonrası soru cevapsız kalmasın.
const PRO_DAILY_LIMIT = 300;

// ── RATE LIMITING ──
// IP başına dakikada max 15 istek
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
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

// assetlinks.json - Play Store doğrulaması için
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

// ── KULLANICI DOĞRULAMA + GÜNLÜK KOTA ──
// Her /merci isteğinde Firebase ID token ister, uid çıkarır, isPro'ya göre
// günlük sayacı Firestore'da (transaction ile) artırır; limit aşılırsa 429 döner.
async function authAndQuota(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return res
        .status(401)
        .json({ error: "Merci'ye danışmak için giriş yap." });
    }

    const decoded = await getAuth().verifyIdToken(token);
    const uid = decoded.uid;

    const userSnap = await adminDb.collection("users").doc(uid).get();
    const isPro = userSnap.exists && userSnap.data().isPro === true;
    const limit = isPro ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT;

    const today = new Date().toISOString().slice(0, 10); // UTC günü (YYYY-MM-DD)
    const usageRef = adminDb.collection("aiUsage").doc(`${uid}_${today}`);

    const allowed = await adminDb.runTransaction(async (tx) => {
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

    if (!allowed) {
      return res
        .status(429)
        .json({ error: "Günlük Merci hakkın doldu!", limitReached: true });
    }

    req.uid = uid;
    next();
  } catch (e) {
    console.error("Auth/Quota Error:", e.message);
    return res
      .status(401)
      .json({ error: "Oturum doğrulanamadı, tekrar giriş yap." });
  }
}

app.post("/merci", rateLimit, authAndQuota, async (req, res) => {
  try {
    const { messages, groupCount, history, location, resultContext } = req.body;

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
    const locationContext = location
      ? `\nKullanıcının konumu: ${location}.`
      : `\nKONUM: Kullanıcının konumu sistemde YOK. Kullanıcı yakındaki bir mekanı YA DA "nereye gidelim / gezelim / dışarı çıkalım / takılalım" gibi bir yeri soruyorsa, cevabının EN BAŞINA tam olarak şu işareti koy: [[NEED_LOCATION:TUR]] — TUR şunlardan biri: food, cafe, dessert, bar, activity (emin değilsen activity). İşaretten sonra TEK cümleyle "konumunu açarsan civarındaki gerçek mekanları telefonlarıyla öneririm, ya da şehrini/semtini yaz" de; mekan İSMİ uydurma. Kullanıcı zaten şehir/semt yazdıysa işaret KOYMA, direkt o bölgeye göre öner (bölge o iş için cılızsa daha hareketli bir civar semt öner).`;

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

    const systemPrompt = `Sen Merci — mor, sevimli ama keskin zekâlı bir karar-ahtapotu. İnsanların KARARSIZLIĞINI bitirmek için varsın ve bundan keyif alıyorsun.

GÖREV TANIMI:
- SADECE grup/kişi kararlarıyla ilgili yardım et: nereye gidilsin, ne yenilsin, ne izlensin, ne yapılsın, kime ne hediye alınsın gibi.
- Kararla alakasız sorularda (genel bilgi, matematik, tarih, kod, vs.) ahtapot edasıyla nazikçe geçiştir: "Ben karar kollarımı onun için sallamıyorum 🐙 Ama bir ikilemin varsa anlat, çözeriz!"
- Kullanıcı "bilmiyorum/farketmez/bilemedim" derse veya saçmalarsa çarka yönlendir: "O zaman kaderine bırak — çarkı çevir, ne çıkarsa o! 🎡"
- Grup büyükse ve oylama mantıklıysa: "Bunu kalabalık çözer, oylamaya alalım 📊" de.

KARAKTERİN (uygulamanın yıldızı sensin — sıkıcı bir asistan DEĞİL):
- Kendinden emin, hafif ukala, esprili, sıcak. Net konuş, lafı dolandırma.
- Karar VERMEKTEN korkma — "ikisi de güzel" deyip kaçma; bir tarafı seç ve nedenini tek cümlede söyle.
- Türkçe, doğal, günlük dil. Klişe AI girişleri YOK.
- En fazla 2 emoji. KISA: 2-4 cümle.${groupCount > 0 ? `\n- Grup ${groupCount > 6 ? "6+" : groupCount} kişilik — buna göre öner.` : ""}
${historyContext}${locationContext}${resultPrompt}${winnerEspriPrompt}

MEKAN / KONUM:
- Yakındaki gerçek mekan listesi (isim, mesafe, telefon, yol tarifi) kullanıcı konumunu açınca AYRI gösterilir — sen sohbette mekan ismi/telefonu UYDURMA.
- Bulunduğu semt o iş için cılızsa dürüst ol ve daha iyi bir civar semt öner (örn. "Burada pek mekan yok, biraz öteye İstiklal/Kadıköy tarafına geç" gibi) — abartma, 1 cümle.

SEÇENEK İŞARETİ — ÇOK ÖNEMLİ (uygulamanın özel özelliği, SIK kullan):
Şu durumlarda cevabının EN SONUNA tam olarak şu işareti EKLE: [[SECENEKLER: ad1 | ad2 | ad3]] (2-8 kısa isim, | ile ayır). Bu, kullanıcıya seçenekleri tek tıkla Çark'a/Oylamaya gönderen butonlar çıkarır.
1) 2+ seçilebilir somut seçenekten bahsettiğinde (yemek/film/mekan/aktivite isimleri) — CÜMLE İÇİNDE bile olsa (örn. "pizza ısmarlayıp korku filmi izleyin" → her ikisini de seçenek say).
2) Kullanıcı "sen karar ver / bilmiyorum / fark etmez" deyince YA DA sen "çarka bırakalım / çevir bakalım" deyince — o an aklındaki 2-4 seçeneği işarete koy ki çark butonu gelsin.
ÖRNEKLER: "Pizza mı burger mi, ikisi de süper! [[SECENEKLER: Pizza | Burger]]" — "Kaderine bırak, çevir bakalım! [[SECENEKLER: Korku | Komedi | Aksiyon]]"
SADECE tek bir kesin şey önerdiğinde (tek seçenek) işaret KOYMA.

KISITLARA TEPKİ:
- Kullanıcı kısıt söyleyince ("2 kişiyiz", "yalnızım", "uzak / arabam yok", "bütçe az") baştan soru sormadan DİREKT uygun alternatif öner.

YAKLAŞIM (her seferinde farklı, kalıba girme):
1. Net öneri: en fazla 2-3 seçenek, her birine yarım cümle gerekçe.
2. Doğrudan tek karar ver.
3. Eksik bilgi varsa SADECE 1 netleştirme sor (gerekiyorsa), asla peş peşe soru yağmuru yapma.

ASLA: "Tabii ki!", "Harika bir soru!" gibi yapay girişler — aynı kalıpla başlama — "ben yapay zekayım" deme — 3'ten fazla madde — gereksiz tekrar — aynı soruyu iki kez sorma — mekan ismi/telefon uydurma.`;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: systemPrompt,
      messages: messages,
    });

    let text = "";
    response.content.forEach((block) => {
      if (block.type === "text") text += block.text;
    });

    res.json({ text: text || "Bir şeyler ters gitti, tekrar dene!" });
  } catch (error) {
    console.error("API Error:", error.message);
    res.status(500).json({ error: "Merci şu an müsait değil, tekrar dene!" });
  }
});

// ── GEÇİCİ DOSYA YÜKLEME ARACI ──
const fs = require("fs");
app.get("/dev-upload", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Dosya Yükle</title>
<style>body{font-family:sans-serif;max-width:500px;margin:60px auto;padding:20px}
button{background:#7c3aed;color:#fff;border:none;padding:12px 28px;border-radius:8px;font-size:16px;cursor:pointer}
select,input{width:100%;padding:8px;margin:8px 0 16px;font-size:15px;border:1px solid #ccc;border-radius:6px}
#status{margin-top:20px;font-weight:bold;font-size:15px}</style></head>
<body><h2>📁 HTML Dosyası Yükle</h2>
<label>Dosya adı:</label>
<select id="fname"><option value="index.html">index.html</option><option value="live-index.html">live-index.html</option></select>
<label>Dosyayı seç:</label>
<input type="file" id="f" accept=".html">
<button onclick="upload()">Yükle</button>
<div id="status"></div>
<script>
async function upload(){
  var file=document.getElementById('f').files[0];
  var fname=document.getElementById('fname').value;
  if(!file)return alert('Önce dosya seç');
  document.getElementById('status').textContent='Yükleniyor...';
  var text=await file.text();
  var r=await fetch('/dev-upload?file='+fname,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:text});
  var msg=await r.text();
  document.getElementById('status').textContent=msg;
}
</script></body></html>`);
});
app.post("/dev-upload", express.text({ limit: "50mb", type: "text/plain" }), (req, res) => {
  const allowed = ["index.html", "live-index.html"];
  const fname = allowed.includes(req.query.file) ? req.query.file : "index.html";
  const dest = path.join(__dirname, "public", fname);
  fs.writeFileSync(dest, req.body, "utf8");
  res.send(`✅ ${fname} başarıyla yüklendi! (${(req.body.length / 1024).toFixed(1)} KB)`);
});

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

    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 220,
      system: sys,
      messages: [{ role: "user", content: userMsg }],
    });

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
    console.error("Options Error:", e.message);
    res.status(500).json({ error: "Merci şu an seçenek üretemiyor, tekrar dene!" });
  }
});

// ── YAKINDAKİ MEKANLAR (OpenStreetMap/Overpass — ÜCRETSİZ) + Merci önerisi ──
const LOC_FREE_LIMIT = 3; // free: günde 3 deneme (tadımlık)
const LOC_PRO_LIMIT = 100; // PRO: pratikte sınırsız

const OVERPASS_FILTERS = {
  food: '["amenity"~"restaurant|fast_food"]',
  cafe: '["amenity"~"cafe"]',
  bar: '["amenity"~"bar|pub"]',
  dessert: '["amenity"~"ice_cream"]',
  activity: '["leisure"~"park|sports_centre|fitness_centre"]',
};

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
    try {
      const decoded = await getAuth().verifyIdToken(token);
      uid = decoded.uid;
      const us = await adminDb.collection("users").doc(uid).get();
      isPro = us.exists && us.data().isPro === true;
    } catch (e) {
      return res.status(401).json({ error: "Oturum doğrulanamadı." });
    }

    // Girdi
    const lat = parseFloat(req.body && req.body.lat);
    const lng = parseFloat(req.body && req.body.lng);
    if (!isFinite(lat) || !isFinite(lng))
      return res.status(400).json({ error: "Konum geçersiz." });
    const typeKey = String((req.body && req.body.type) || "food");
    const locName = String((req.body && req.body.locName) || "").slice(0, 60);
    const radius = Math.min(
      Math.max(parseInt(req.body && req.body.radius) || 2500, 300),
      5000,
    );

    // Günlük konum kotası (AI kotasından AYRI)
    const today = new Date().toISOString().slice(0, 10);
    const limit = isPro ? LOC_PRO_LIMIT : LOC_FREE_LIMIT;
    const ref = adminDb.collection("locUsage").doc(`${uid}_${today}`);
    const allowed = await adminDb.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const c = s.exists ? s.data().count || 0 : 0;
      if (c >= limit) return false;
      tx.set(
        ref,
        { uid, date: today, count: c + 1, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return true;
    });
    if (!allowed)
      return res
        .status(429)
        .json({ error: "Günlük konum önerisi hakkın doldu!", limitReached: true });

    // Overpass sorgusu (boş dönerse radius'u büyütüp 1 kez daha dene → "bulamadım" azalır)
    const sel = OVERPASS_FILTERS[typeKey] || OVERPASS_FILTERS.food;
    async function runOverpass(r) {
      const q =
        `[out:json][timeout:20];(node${sel}(around:${r},${lat},${lng});` +
        `way${sel}(around:${r},${lat},${lng}););out center 60;`;
      try {
        const ovr = await fetch("https://overpass-api.de/api/interpreter", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(q),
        });
        const d = await ovr.json();
        return (d && d.elements) || [];
      } catch (e) {
        return [];
      }
    }
    let els = await runOverpass(radius);
    if (!els.length && radius < 5000) {
      els = await runOverpass(5000); // geniş alanda tekrar dene
    }

    const seen = {};
    const places = els
      .map((e) => {
        const plat = e.lat != null ? e.lat : e.center && e.center.lat;
        const plng = e.lon != null ? e.lon : e.center && e.center.lon;
        const name = e.tags && (e.tags["name:tr"] || e.tags.name);
        if (!name || plat == null || plng == null) return null;
        const phone =
          (e.tags &&
            (e.tags["contact:phone"] ||
              e.tags.phone ||
              e.tags["contact:mobile"])) ||
          "";
        return {
          name: String(name).slice(0, 60),
          kind: (e.tags && (e.tags.cuisine || e.tags.amenity || e.tags.leisure)) || "",
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

    // Merci yorumu (ucuz Haiku). Sonuç varsa listeden öner; YOKSA en yakın iyi semti öner.
    let merciComment = "";
    const typeLabel =
      ({ food: "yemek", cafe: "kafe", dessert: "tatlı", bar: "bar/bira", activity: "aktivite" })[
        typeKey
      ] || typeKey;
    try {
      if (places.length) {
        const top = places
          .slice(0, 6)
          .map((p) => `${p.name} (${p.dist}m)`)
          .join(", ");
        const cr = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 160,
          system:
            "Sen Merci, sevimli bir karar-ahtapotu. Sana yakındaki GERÇEK mekanların listesi (isim + mesafe) verilir. " +
            "KISA (1-2 cümle), samimi, Türkçe bir öneri yap: birini öne çıkar, mesafeye değin, oyunbaz ol. " +
            "En fazla 1 emoji. Liste DIŞINDA mekan UYDURMA.",
          messages: [
            { role: "user", content: "Tür: " + typeKey + "\nYakındaki mekanlar: " + top },
          ],
        });
        cr.content.forEach((b) => {
          if (b.type === "text") merciComment += b.text;
        });
      } else {
        // Yakında sonuç YOK → en yakın bilinen canlı semt/ilçeyi öner (genel bilgi)
        const cr = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
          system:
            "Sen Merci, sevimli bir karar-ahtapotu. Kullanıcının yakınında istediği türde mekan ÇIKMADI. " +
            "KISA (1-2 cümle), samimi Türkçe: bulunduğu bölgede az olduğunu söyle ve O TÜR için EN YAKIN bilinen canlı semt/ilçeyi öner (gerçek ve mantıklı, örn. büyük şehirlerde bilinen eğlence/yeme-içme bölgeleri). " +
            "Spesifik mekan ismi UYDURMA; 'şu semte/ilçeye geç, orada bolca var' tarzı yönlendir. En fazla 1 emoji.",
          messages: [
            {
              role: "user",
              content: `Konum: ${locName || "bilinmiyor"}. Tür: ${typeLabel}. Yakında bulunamadı — en yakın iyi semt/ilçe neresi, oraya yönlendir.`,
            },
          ],
        });
        cr.content.forEach((b) => {
          if (b.type === "text") merciComment += b.text;
        });
      }
    } catch (e) {}

    res.json({ places, merciComment: merciComment.trim(), isPro });
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

    await adminDb.collection("users").doc(uid).set(
      {
        isPro,
        proUpdatedAt: FieldValue.serverTimestamp(),
        proSource: "revenuecat",
        proLastEvent: type,
      },
      { merge: true },
    );
    return res.status(200).json({ ok: true, uid, isPro });
  } catch (e) {
    console.error("RC Webhook Error:", e.message);
    return res.status(500).json({ error: "webhook error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Karar Mercii ${PORT} portunda çalışıyor!`);
});

const express = require("express");
const path = require("path");
const fs = require("fs"); // yalnız index.html okumak için (OG meta enjeksiyonu)
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

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

    // Anonim oturumlar AI uçlarını KULLANAMAZ: signInAnonymously sınırsız taze kimlik
    // üretir → her biri için yeni kota = maliyet/abuse. Anonim auth yalnız oda yazımı
    // içindir; AI için Google girişi şart.
    if (decoded.firebase && decoded.firebase.sign_in_provider === "anonymous") {
      return res
        .status(401)
        .json({ error: "Merci'ye danışmak için Google ile giriş yap." });
    }

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

    const systemPrompt = `Sen Merci — mor, sevimli ama keskin zekâlı bir karar-ahtapotu. İnsanların kararsızlığını bitirmek senin işin ve bundan keyif alıyorsun. Uygulamanın yıldızı sensin, sıkıcı bir asistan değil.

TARZIN:
- Kendinden emin, hafif ukala, esprili, sıcak. Net konuş, lafı dolandırma. Karar vermekten korkma — bir tarafı seç ve nedenini tek cümlede söyle.
- Doğal günlük Türkçe. Her zaman samimi tekil "sen" diliyle konuş (geçersen, ne dersin, oraya git) — grup kararı olsa bile. Aynı mesajda sen↔siz karıştırma.
- KISA ve NET: 1-3 cümle, en fazla 2 emoji. Karar-ahtapotusun — "hmmm, ne istediğini bilmeden nasıl karar veririm" gibi KARARSIZ/uzun/geveleyen girişler YASAK. Ya net bir öneri ver ya da TEK kısa soruyla daralt.
- YAZIM DOĞRU olsun: Türkçe dilbilgisi/imla hatasız yaz. Örn "karar vereyim / edeyim / gideyim / bakayım" (verim/edim/gidim/bakim YANLIŞ). "değil mi", "bir şey" ayrı; "yalnızca" doğru. Bozuk/yarım kelime yok.${groupCount > 0 ? `\n- Grup ${groupCount > 6 ? "6+" : groupCount} kişilik — buna göre öner.` : ""}

İYİ CEVAP (kısa, net, doğru Türkçe, karar verir/daraltır):
K: "akşam yemeği ne yesek 4 kişiyiz" → S: "4 kişilik sofraya oturmalı bir yer iyi gider — kebap mı, İtalyan mı? Söyle hemen daraltayım 🍽️ [[SECENEKLER: Kebap | İtalyan | Balık | Burger]]"
KÖTÜ (ASLA): "hmmm, akşam yemeği heyecanı! ama ne istediğini bilmeden nasıl karar verim?" (yazım hatası + kararsız + gereksiz uzun)

NE YAPARSIN:
- Sadece karar konularında yardım et: nereye gidilsin, ne yenilsin/izlensin/yapılsın, kime ne hediye alınsın.
- Alakasız soruda (genel bilgi, matematik, kod) nazikçe geçiştir: "Ben karar kollarımı onun için sallamıyorum 🐙 Ama bir ikilemin varsa anlat, çözeriz!"
- Kullanıcı "bilmiyorum / fark etmez" derse çarka yönlendir: "Kaderine bırak — çevir bakalım! 🎡" Grup büyük ve oylama mantıklıysa: "Bunu kalabalık çözer, oylamaya alalım 📊"
- Kısıt gelince ("2 kişiyiz", "arabam yok", "bütçe az") soru sormadan DİREKT uygun alternatif öner. Eksik bilgi varsa en fazla 1 netleştirme sorusu sor — peş peşe soru yağdırma.
${historyContext}${locationContext}${setLocHint}${resultPrompt}${winnerEspriPrompt}

SEÇENEK BUTONU (SIK kullan): Cevapta 2+ somut seçilebilir seçenek varsa (yemek/film/mekan/aktivite; cümle içinde bile), YA DA kullanıcı "sen karar ver" deyince veya sen çarka yönlendirince — cevabının EN SONUNA [[SECENEKLER: ad1 | ad2 | ad3]] ekle (2-8 kısa isim, | ile ayır). Örn: "Pizza mı burger mi? [[SECENEKLER: Pizza | Burger]]" — "Çevir bakalım! [[SECENEKLER: Korku | Komedi | Aksiyon]]". Tek kesin öneride işaret KOYMA. DİKKAT: SECENEKLER soyut KATEGORİ/tür içindir (Pizza, Korku filmi, Kafe) — GERÇEK MEKAN İSMİ (Domino's, Big Chefs) ASLA yazma; [[NEARBY]] koyduğun mekan cevaplarında SECENEKLER'e mekan/işletme adı KOYMA.

KIRMIZI ÇİZGİLER:
- UYDURMA YASAK: Mekan ismi, telefon, semt/ilçe/cadde adı ya da mesafe ASLA uydurma. Gerçek mekan listesi kullanıcıya ayrı kartlarla gösterilir. Bir yeri nerede/ne kadar uzakta bulacağını sadece [[NEARBY]] işaretinin getirdiği gerçek kartlar söyler; sen metinde spesifik yer/mesafe yazma, "başka semte git" deme. "Burada yok / kültürü gelişmemiş" gibi kesin olumsuz hüküm verme — mevcudiyeti kartlar belirler.
- MEKAN CEVABINDA KATI KISIT: [[NEARBY]] işareti koyduğun her cevapta SADECE TEK kısa cümle yaz (ör. "En yakınları çıkarıyorum 👇"). ŞUNLAR KESİN YASAK: (1) kendi kafandan mekan İSMİ/zincir adı (Domino's, Big Chefs, Komagene, "X Dönercisi"); (2) yan tür/yemek listesi saymak (kokoreç, kebap, çiğköfte, büfe, tatlıcı...); (3) [[NEARBY]] ile AYNI cevaba [[SECENEKLER]] koymak — mekan cevabında SECENEKLER YOK, gerçek yerleri yalnızca kartlar getirir. İsim/tür sıralaması yaparsan YANLIŞ olur (alakasız yer sayarsın). Sadece işaret + tek cümle.
- SPESİFİĞE SADIK KAL: Kullanıcı spesifik istedi mi tam ona uy. "Tavuk döner" → kebap/kokoreç/çiğköfte DEĞİL. "Sushi" → başka mutfak DEĞİL. "Şarap / oturmalı / akşam yemeği" → fast-food, büfe, pizza-zinciri (Domino's) DEĞİL, oturmalı restoran. İstenen türe UYMAYAN bir yeri o türmüş gibi önerme; tam onu bulamıyorsan alternatifleri kartlar zaten "en yakın seçenekler" olarak getirir, sen alakasız türü İSTENEN ŞEYMİŞ gibi sunma. Emin değilsen ÖNERME — dürüst ol.
- İÇ İŞLEYİŞ GİZLİ: sistem, harita, GPS, API, sunucu, arkaplan, entegrasyon, "mekan kartı çekemiyorum", "yükleyemedim" gibi teknik/iç-işleyiş ifadeleri ASLA kullanma. Mekan gelmediğinde bahane uydurma; kısa ve neşeli kal ("Hemen tekrar bakıyorum 👇") ve uygun [[NEARBY:tür]] işaretini koy.
- Yapay AI girişleri yok ("Tabii ki!", "Harika bir soru!", "ben yapay zekayım"). Aynı soruyu iki kez sorma. Konum varsa tekrar şehir/semt/konum isteme.`;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      system: systemPrompt,
      messages: messages,
    });

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

    res.json({
      text: text || "Bir şeyler ters gitti, tekrar dene!",
      setLocation, // yazıyla verilen konumun koordinatı (varsa) → client günceller
    });
  } catch (error) {
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
    try {
      const decoded = await getAuth().verifyIdToken(token);
      uid = decoded.uid;
      if (decoded.firebase && decoded.firebase.sign_in_provider === "anonymous") {
        return res
          .status(401)
          .json({ error: "Konum önerisi için Google ile giriş yap." });
      }
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
    let typeKey = String((req.body && req.body.type) || "food");
    const locName = String((req.body && req.body.locName) || "").slice(0, 60);
    // Kullanıcının ham isteği (ör. "yakında sushi var mı"). Spesifik tür daraltması
    // için kullanılır; yoksa (eski client) davranış eskisi gibi bucket bazlı kalır.
    const query = String((req.body && req.body.query) || "")
      .toLowerCase()
      .slice(0, 80);
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
    const preSnap = await ref.get();
    const usedCount = preSnap.exists ? preSnap.data().count || 0 : 0;
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
    const rule =
      query && ["food", "cafe", "dessert"].includes(typeKey)
        ? CUISINE_RULES.find((c) => c.test.test(query))
        : null;
    let els = [];
    let broadened = false;
    let bucketTried = false;
    // Tier A: cuisine tag daraltması (yeme-içme amenity'leri içinde).
    // Oturmalı/içkili istekte SADECE restaurant (fast_food'lu zincir cuisine=pizza
    // eşleşmesi = Domino's → şarap yok → dışarıda bırak).
    if (rule && rule.cuisine) {
      const cuisineAmenity = wantsSitdown
        ? "restaurant"
        : "restaurant|fast_food|cafe|ice_cream";
      els = await runExpanding([
        `["amenity"~"^(${cuisineAmenity})$"]["cuisine"~"${rule.cuisine}",i]`,
      ]);
    }
    // Tier B: cuisine tag'i yoksa, bucket sonuçlarını mekan İSMİNE göre süz
    if (rule && !els.length) {
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
    if (!els.length && !bucketTried) {
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
    const places = els
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
    let merciComment = "";
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
        merciComment =
          `Tam olarak "${rule.label}" çıkmadı buralarda 🐙 Ama en yakın ${typeLabel} yerleri şunlar: ${near}. Beğenirsen aşağıdan bak 👇`;
      } else if (places.length) {
        const top = places
          .slice(0, 6)
          .map((p) => `${p.name} (${p.dist}m)`)
          .join(", ");
        const cr = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 160,
          system:
            "Sen Merci, sevimli bir karar-ahtapotu. Sana kullanıcıya EN YAKIN GERÇEK mekanların listesi (isim + mesafe) verilir. " +
            "KISA (1-2 cümle), samimi, Türkçe ve TUTARLI tekil 'sen' diliyle (asla 'siz') bir öneri yap: birini öne çıkar, GERÇEK mesafeye değin (uzaksa dürüstçe söyle, örn. '~3 km, taksiyle kısa'), oyunbaz ol. " +
            "Mekanlar mahallende değil komşu semtte olabilir — bu normal, listedeki gerçek mesafeyi kullan. Listedeki isimler/mesafeler DIŞINDA hiçbir mekan/semt/mesafe UYDURMA. En fazla 1 emoji. " +
            "DÜRÜSTLÜK: Sana yalnız mekan ADI + MESAFE verildi; menü/içki/fiyat bilgisi YOK. Mekan kartlarında da SADECE isim + 'yol tarifi' butonu var — menü/içki listesi/fiyat YAZMAZ. Bu yüzden 'kartlarda yazıyor', 'listesinde görürsün', 'menüde var' DEME ve bir mekânda belirli bir şeyin (rakı, spesifik yemek) bulunduğunu GARANTİ ETME ('kesin vardır' YASAK). Gerekiyorsa 'meyhane/balık lokantası genelde bulundurur, emin olmak istersen mekânı arayabilirsin' gibi temkinli konuş.",
          messages: [
            {
              role: "user",
              content:
                (locName ? "Kullanıcı " + locName + " civarında.\n" : "") +
                (wantsDifferent
                  ? "Kullanıcı öncekileri beğenmedi, bunlar FARKLI/yeni yerler — 'işte başka seçenekler' tonuyla sun.\n"
                  : "") +
                "Tür: " + (rule ? rule.label : typeLabel) +
                "\nEn yakın gerçek mekanlar (isim + mesafe): " + top,
            },
          ],
        });
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
      console.error("Nearby Merci comment error:", e.message);
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

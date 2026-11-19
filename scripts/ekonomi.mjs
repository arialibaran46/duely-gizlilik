// Duely ekonomi verisi: TCMB EVDS'den enflasyon ve kredi faizlerini çeker, veri/ekonomi.json yazar.
// GitHub Actions her gün çalıştırır. Anahtar yalnızca EVDS_KEY ortam değişkeninde (GitHub secret);
// uygulamaya ya da yayınlanan dosyaya hiçbir zaman yazılmaz.
//
// Kullanım: EVDS_KEY=... node scripts/ekonomi.mjs            → veri/ekonomi.json
//           EVDS_KEY=... node scripts/ekonomi.mjs --kontrol  → yalnızca seri kodlarını dener, yazmaz

import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'https://evds3.tcmb.gov.tr/igmevdsms-dis';
const KEY = process.env.EVDS_KEY;
const CHECK = process.argv.includes('--kontrol');

// Her gösterge için aday seri kodları: ilk veri dönen kullanılır (TCMB kod değiştirirse yedek devreye girer).
// Kodlar ilk çalıştırmada --kontrol ile doğrulanır; çıktıda hangi kodun kullanıldığı yazar.
const CPI_GROUP = 'bie_tukfiy2025';     // TÜFE (2025=100) veri grubu
const CPI = ['TP.FG.J0'];               // yedek: eski TÜFE (2003=100)
const LOAN_GROUPS = ['bie_kt100h', 'bie_kt100'];
const PPI = ['TP.TUFE1YI.T1'];          // Yİ-ÜFE genel endeksi
const LOANS = [
  { id: 'ihtiyac', label: 'İhtiyaç kredisi', codes: ['TP.KTF10'] },
  { id: 'tasit', label: 'Taşıt kredisi', codes: ['TP.KTF11'] },
  { id: 'konut', label: 'Konut kredisi', codes: ['TP.KTF12'] },
];

const pad = (n) => String(n).padStart(2, '0');
const dmy = (d) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

/** Bir seriyi çeker: [{ date: 'YYYY-MM' | 'YYYY-MM-DD', value }] (boşlar atılır, tarihe göre artan) */
async function series(code, from, extra = '') {
  const url = `${BASE}/series=${code}&startDate=${dmy(from)}&endDate=${dmy(new Date())}&type=json${extra}`;
  const res = await fetch(url, { headers: { key: KEY, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${code}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  const field = code.replaceAll('.', '_');
  const out = [];
  for (const row of json.items ?? []) {
    const k = Object.keys(row).find((x) => x === field || x.startsWith(`${field}-`));
    const v = k ? Number(String(row[k]).replace(',', '.')) : NaN;
    if (!Number.isFinite(v) || row[k] === null || row[k] === '') continue;
    out.push({ date: normalizeDate(row.Tarih), value: v });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** EVDS tarihleri: "2026-10", "10-2026", "14-11-2026" → YYYY-MM ya da YYYY-MM-DD */
function normalizeDate(t) {
  const s = String(t);
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) return `${m[1]}-${pad(m[2])}`;
  if ((m = s.match(/^(\d{1,2})-(\d{4})$/))) return `${m[2]}-${pad(m[1])}`;
  if ((m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/))) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return s;
}

/** Veri grubundaki seriler: [{ code, name }] */
async function serieList(group) {
  const res = await fetch(`${BASE}/serieList/type=json&code=${group}`, { headers: { key: KEY, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${group}: HTTP ${res.status}`);
  const json = await res.json();
  const arr = Array.isArray(json) ? json : (json.items ?? json.data ?? []);
  return arr.map((x) => ({ code: x.SERIE_CODE ?? x.serieCode, name: x.SERIE_NAME ?? x.serieName ?? '' })).filter((x) => x.code);
}

async function firstWorking(codes, from, extra) {
  const errors = [];
  for (const code of codes) {
    try {
      const rows = await series(code, from, extra);
      if (rows.length > 0) return { code, rows };
      errors.push(`${code}: boş`);
    } catch (e) {
      errors.push(String(e.message ?? e));
    }
  }
  throw new Error(errors.join(' | '));
}

const r2 = (n) => Math.round(n * 100) / 100;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/** Aylık endeksten yıllık, aylık ve 12 aylık ortalama değişim (%) */
function indexStats(rows) {
  const v = rows.map((r) => r.value);
  const n = v.length;
  if (n < 25) throw new Error(`endeks için en az 25 ay gerekli, ${n} var`);
  const yearly = (i) => (v[i] / v[i - 12] - 1) * 100;
  const avg12 = (mean(v.slice(n - 12)) / mean(v.slice(n - 24, n - 12)) - 1) * 100;
  return {
    period: rows[n - 1].date,
    yearly: r2(yearly(n - 1)),
    yearlyChange: r2(yearly(n - 1) - yearly(n - 2)),
    monthly: r2((v[n - 1] / v[n - 2] - 1) * 100),
    avg12: r2(avg12),
  };
}

async function main() {
  if (!KEY) {
    // anahtar eklenene kadar iş kırmızıya düşmesin (her gün hata e-postası gelmesin)
    console.log('::warning::EVDS_KEY tanımlı değil (GitHub → Settings → Secrets → Actions); veri güncellenmedi');
    return;
  }
  const now = new Date();
  const monthsAgo = (m) => new Date(now.getFullYear(), now.getMonth() - m, 1);
  const items = [];
  const report = [];

  const monthly = '&frequency=5&aggregationTypes=avg';
  try {
    // TÜİK 2026'da baz yılını 2025=100'e taşıdı: genel endeks yeni veri grubundan adına göre bulunur
    let candidates = [];
    try {
      const list = await serieList(CPI_GROUP);
      report.push(`${CPI_GROUP}: ${list.length} seri; ilk: ${list.slice(0, 4).map((x) => `${x.code} (${x.name})`).join(' | ')}`);
      const general = list.filter((x) => /genel/i.test(x.name));
      candidates = (general.length ? general : list.slice(0, 1)).map((x) => x.code);
    } catch (e) {
      report.push(`TÜFE seri listesi alınamadı: ${e.message}`);
    }
    const cpi = await firstWorking([...candidates, ...CPI], monthsAgo(30), monthly);
    const c = indexStats(cpi.rows);
    report.push(`TÜFE ${cpi.code} → ${c.period} yıllık %${c.yearly}, aylık %${c.monthly}, 12 ay ort. %${c.avg12}`);
    items.push(
      { id: 'tufe_yillik', label: 'TÜFE (yıllık)', value: c.yearly, unit: '%', period: c.period, change: c.yearlyChange, group: 'inflation' },
      { id: 'tufe_aylik', label: 'TÜFE (aylık)', value: c.monthly, unit: '%', period: c.period, group: 'inflation' },
      { id: 'kira_siniri', label: 'Kira artış sınırı', value: c.avg12, unit: '%', period: c.period, group: 'inflation' },
    );
  } catch (e) {
    report.push(`TÜFE alınamadı: ${e.message}`);
  }

  // kredi faizi veri grupları: seri adları kayda yazılır (kodlar buradan doğrulanır)
  for (const g of LOAN_GROUPS) {
    try {
      const list = await serieList(g);
      report.push(`${g}: ${list.slice(0, 12).map((x) => `${x.code} (${x.name})`).join(' | ')}`);
    } catch (e) {
      report.push(`${g} listesi alınamadı: ${e.message}`);
    }
  }

  try {
    const ppi = await firstWorking(PPI, monthsAgo(30), monthly);
    const p = indexStats(ppi.rows);
    report.push(`Yİ-ÜFE ${ppi.code} → ${p.period} yıllık %${p.yearly}`);
    items.push({ id: 'ufe_yillik', label: 'Yİ-ÜFE (yıllık)', value: p.yearly, unit: '%', period: p.period, change: p.yearlyChange, group: 'inflation' });
  } catch (e) {
    report.push(`Yİ-ÜFE alınamadı: ${e.message}`);
  }

  for (const l of LOANS) {
    try {
      const s = await firstWorking(l.codes, new Date(now.getTime() - 120 * 86_400_000));
      const last = s.rows[s.rows.length - 1];
      const prev = s.rows[s.rows.length - 2];
      report.push(`${l.label} ${s.code} → ${last.date} %${last.value}`);
      items.push({
        id: l.id,
        label: l.label,
        value: r2(last.value),
        unit: '%',
        period: last.date,
        change: prev ? r2(last.value - prev.value) : undefined,
        group: 'rates',
      });
    } catch (e) {
      report.push(`${l.label} alınamadı: ${e.message}`);
    }
  }

  console.log(report.join('\n'));
  if (CHECK) return;
  if (items.length === 0) throw new Error('hiçbir gösterge alınamadı');
  // değerler makul aralıkta mı (bozuk veriyi yayınlama)
  for (const i of items) if (!(i.value > -50 && i.value < 500)) throw new Error(`${i.id} şüpheli değer: ${i.value}`);
  mkdirSync('veri', { recursive: true });
  const out = { v: 1, updated: now.toISOString(), source: 'TCMB EVDS', items };
  writeFileSync('veri/ekonomi.json', `${JSON.stringify(out, null, 2)}\n`);
  console.log(`veri/ekonomi.json yazıldı (${items.length} gösterge)`);
}

main().catch((e) => {
  console.error(`HATA: ${e.message ?? e}`);
  process.exit(1);
});

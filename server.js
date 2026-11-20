const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
const QC_API_KEY = (process.env.QC_API_KEY || '').trim();
const QC_SEARCH_URL = 'https://api.quickcommerceapi.com/v1/search';

// Built-in cache of common pincodes + dynamic geocoding cache
const geoCache = new Map([
  ['462016', { lat: 23.2167, lon: 77.4333 }], // Arera Colony, Bhopal
  ['462011', { lat: 23.2332, lon: 77.4343 }], // MP Nagar, Bhopal
  ['452010', { lat: 22.7533, lon: 75.8937 }], // Vijay Nagar, Indore
  ['462042', { lat: 23.1765, lon: 77.4190 }], // Kolar Road, Bhopal
  ['560038', { lat: 12.9784, lon: 77.6408 }], // Indiranagar, Bengaluru
  ['400053', { lat: 19.1364, lon: 72.8296 }]  // Andheri West, Mumbai
]);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'quickcompare-api',
    apiKeyConfigured: Boolean(QC_API_KEY)
  });
});

function parsePackSize(text = '') {
  const m = String(text).match(/(\d+(?:\.\d+)?)\s*(?:x\s*(\d+(?:\.\d+)?)\s*)?(kg|g|gm|gms|l|ltr|ml|pcs|pc|pack|units?)/i);
  if (!m) return { packLabel: text || '1 unit', unitValue: 1, unitType: 'unit' };
  const n1 = parseFloat(m[1]);
  const n2 = m[2] ? parseFloat(m[2]) : 1;
  const rawUnit = m[3].toLowerCase();
  const qty = n1 * n2;
  if (rawUnit === 'kg') return { packLabel: m[0], unitValue: qty * 1000, unitType: 'g' };
  if (rawUnit === 'l' || rawUnit === 'ltr') return { packLabel: m[0], unitValue: qty * 1000, unitType: 'ml' };
  if (rawUnit.startsWith('g')) return { packLabel: m[0], unitValue: qty, unitType: 'g' };
  if (rawUnit === 'ml') return { packLabel: m[0], unitValue: qty, unitType: 'ml' };
  return { packLabel: m[0], unitValue: qty, unitType: 'unit' };
}

// Convert any Indian pincode + area into lat/lon automatically using Nominatim
async function resolveCoords(address = {}) {
  const pin = String(address.pincode || '').trim();
  if (pin && geoCache.has(pin)) return geoCache.get(pin);

  const queries = [
    pin ? `${pin}, India` : '',
    address.area ? `${address.area}, India` : ''
  ].filter(Boolean);

  for (const q of queries) {
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('q', q);
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', '1');
      url.searchParams.set('countrycodes', 'in');

      const resp = await fetch(url, {
        headers: { 'User-Agent': 'QuickCompareApp/2.0 (personal price comparator)' }
      });
      if (resp.ok) {
        const arr = await resp.json();
        if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon) {
          const coords = { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon) };
          if (pin) geoCache.set(pin, coords);
          return coords;
        }
      }
    } catch (_) { /* try fallback */ }
  }

  // Fallback to Bhopal center if geocoding fails
  return { lat: 23.2599, lon: 77.4126 };
}

async function fetchPlatform(localKey, apiPlatformName, query, address) {
  const coords = await resolveCoords(address);
  const url = new URL(QC_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('platform', apiPlatformName);
  url.searchParams.set('lat', String(coords.lat));
  url.searchParams.set('lon', String(coords.lon));
  if (address?.pincode) {
    url.searchParams.set('pincode', String(address.pincode).trim());
  }

  const resp = await fetch(url, {
    headers: { 'X-API-Key': QC_API_KEY }
  });

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${resp.status}`);
  }

  const products = body?.data?.products || [];
  return {
    creditsRemaining: body?.credits_remaining,
    items: products.map((p, idx) => {
      const pack = parsePackSize(p.quantity || p.name || '');
      const price = Math.round(Number(p.offer_price ?? p.price ?? p.mrp ?? 0));
      const mrp = Math.round(Number(p.mrp ?? price)) || price;
      return {
        id: `${localKey}-${p.id || idx}`,
        platform: localKey,
        title: p.name || 'Unnamed Product',
        brand: p.brand || query,
        category: p.brand || apiPlatformName,
        packLabel: p.quantity || pack.packLabel,
        unitValue: pack.unitValue,
        unitType: pack.unitType,
        price,
        mrp,
        inStock: p.available !== false,
        url: p.deeplink || ''
      };
    }).filter((x) => x.price > 0)
  };
}

app.post('/api/search', async (req, res) => {
  if (!QC_API_KEY) {
    return res.status(500).json({
      error: 'QC_API_KEY environment variable is not set on Render.'
    });
  }

  const { query = 'dove', addresses = {} } = req.body || {};
  const cleanQuery = String(query).trim();
  if (!cleanQuery) {
    return res.status(400).json({ error: 'query is required' });
  }

  const [jiomart, blinkit, flipkart] = await Promise.allSettled([
    fetchPlatform('jiomart', 'JioMart', cleanQuery, addresses.jiomart),
    fetchPlatform('blinkit', 'BlinkIt', cleanQuery, addresses.blinkit),
    fetchPlatform('flipkart', 'Minutes', cleanQuery, addresses.flipkart)
  ]);

  const jmItems = jiomart.status === 'fulfilled' ? jiomart.value.items : [];
  const bkItems = blinkit.status === 'fulfilled' ? blinkit.value.items : [];
  const fkItems = flipkart.status === 'fulfilled' ? flipkart.value.items : [];

  const creditsRemaining =
    (flipkart.status === 'fulfilled' && flipkart.value.creditsRemaining) ??
    (blinkit.status === 'fulfilled' && blinkit.value.creditsRemaining) ??
    (jiomart.status === 'fulfilled' && jiomart.value.creditsRemaining) ??
    null;

  res.json({
    query: cleanQuery,
    fetchedAt: new Date().toISOString(),
    creditsRemaining,
    counts: {
      jiomart: jmItems.length,
      blinkit: bkItems.length,
      flipkart: fkItems.length
    },
    errors: {
      jiomart: jiomart.status === 'rejected' ? jiomart.reason?.message : null,
      blinkit: blinkit.status === 'rejected' ? blinkit.reason?.message : null,
      flipkart: flipkart.status === 'rejected' ? flipkart.reason?.message : null
    },
    results: [...jmItems, ...bkItems, ...fkItems]
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QuickCompare API Server listening on port ${PORT}`);
});

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
const PROFILES_DIR = path.join(__dirname, '.profiles');
fs.mkdirSync(PROFILES_DIR, { recursive: true });

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'quickcompare-live' });
});

function parsePackSize(text = '') {
  const m = String(text).match(/(\d+(?:\.\d+)?)\s*(?:x\s*(\d+(?:\.\d+)?)\s*)?(kg|g|gm|gms|l|ltr|ml|pcs|pc|pack|units?)/i);
  if (!m) return { packLabel: '1 unit', unitValue: 1, unitType: 'unit' };
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

function parsePrice(str = '') {
  const m = String(str).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? Math.round(parseFloat(m[1])) : 0;
}

async function withPlatformContext(platform, fn) {
  const userDataDir = path.join(PROFILES_DIR, platform);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.HEADLESS !== 'false',
    viewport: { width: 1280, height: 850 },
    locale: 'en-IN',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    return await fn(page);
  } finally {
    await context.close();
  }
}

async function scrapeJioMart(query, address) {
  return withPlatformContext('jiomart', async (page) => {
    await page.goto(`https://www.jiomart.com/search?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(2500);

    if (address?.pincode) {
      try {
        const pinBtn = page.locator('#btn_pin_code_delivery, [id*="pincode"], button:has-text("Deliver to")').first();
        if (await pinBtn.isVisible({ timeout: 2000 })) {
          await pinBtn.click();
          const pinInput = page.locator('input[placeholder*="Pincode" i], input[name*="pin" i], input[maxlength="6"]').first();
          await pinInput.fill(String(address.pincode));
          await page.keyboard.press('Enter');
          await page.waitForTimeout(2000);
        }
      } catch (_) {}
    }

    const rawItems = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.plp-card-container, [class*="plp-card"], li.ais-InfiniteHits-item'));
      return cards.slice(0, 20).map((card, i) => {
        const title = card.querySelector('.plp-card-details-name, [class*="details-name"], a[title]')?.textContent?.trim() || '';
        const priceText = card.querySelector('.plp-card-details-price .jm-heading-xxs, [class*="price"] span')?.textContent?.trim() || '';
        const mrpText = card.querySelector('.line-through, del, [class*="mrp"]')?.textContent?.trim() || '';
        const link = card.querySelector('a')?.href || '';
        return { id: `jm-live-${i}`, title, priceText, mrpText, url: link };
      }).filter((x) => x.title && x.priceText);
    });

    return rawItems.map((item) => {
      const price = parsePrice(item.priceText);
      const mrp = parsePrice(item.mrpText) || price;
      const pack = parsePackSize(item.title);
      return {
        id: item.id,
        platform: 'jiomart',
        title: item.title,
        brand: query,
        category: 'JioMart',
        packLabel: pack.packLabel,
        unitValue: pack.unitValue,
        unitType: pack.unitType,
        price,
        mrp,
        inStock: true,
        url: item.url
      };
    });
  });
}

async function scrapeBlinkit(query, address) {
  return withPlatformContext('blinkit', async (page) => {
    await page.goto('https://blinkit.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    if (address?.area || address?.pincode) {
      try {
        const locTrigger = page.locator('input[placeholder*="delivery location" i], [class*="LocationBar"]').first();
        if (await locTrigger.isVisible({ timeout: 2500 })) {
          await locTrigger.click();
          const locInput = page.locator('input[placeholder*="search delivery location" i], input[name="select-locality"]').first();
          await locInput.fill(`${address.area || ''} ${address.pincode || ''}`.trim());
          await page.waitForTimeout(1500);
          await page.locator('[class*="LocationSearchList"] div, [class*="location-item"]').first().click();
          await page.waitForTimeout(1500);
        }
      } catch (_) {}
    }

    await page.goto(`https://blinkit.com/s/?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(3000);

    const rawItems = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-test-id="plp-product"], a[href*="/prn/"], [class*="Product__UpdatedPlpProductContainer"]'));
      return cards.slice(0, 20).map((card, i) => {
        const texts = Array.from(card.querySelectorAll('div, span')).map((el) => el.textContent.trim()).filter(Boolean);
        const title = card.querySelector('[class*="ProductTitle"], [class*="line-clamp"]')?.textContent?.trim() || texts[0] || '';
        const priceMatches = (card.textContent || '').match(/₹\s*\d+/g) || [];
        return {
          id: `bk-live-${i}`,
          title,
          priceText: priceMatches[0] || '',
          mrpText: priceMatches[1] || '',
          fullText: card.textContent || '',
          url: card.href || 'https://blinkit.com/'
        };
      }).filter((x) => x.title && x.priceText);
    });

    return rawItems.map((item) => {
      const price = parsePrice(item.priceText);
      const mrp = parsePrice(item.mrpText) || price;
      const pack = parsePackSize(item.fullText);
      return {
        id: item.id,
        platform: 'blinkit',
        title: item.title,
        brand: query,
        category: 'Blinkit',
        packLabel: pack.packLabel,
        unitValue: pack.unitValue,
        unitType: pack.unitType,
        price,
        mrp,
        inStock: !/out of stock/i.test(item.fullText),
        url: item.url
      };
    });
  });
}

async function scrapeFlipkartMinutes(query, address) {
  return withPlatformContext('flipkart', async (page) => {
    await page.goto(`https://www.flipkart.com/search?q=${encodeURIComponent(query)}&marketplace=HYPERLOCAL`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(2500);

    if (address?.pincode) {
      try {
        const pinInput = page.locator('input[placeholder*="pincode" i], input[name="pincode"]').first();
        if (await pinInput.isVisible({ timeout: 2000 })) {
          await pinInput.fill(String(address.pincode));
          await page.keyboard.press('Enter');
          await page.waitForTimeout(2000);
        }
      } catch (_) {}
    }

    const rawItems = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-id], [class*="slAVV4"], [class*="tUxRFH"]'));
      return cards.slice(0, 20).map((card, i) => {
        const title = card.querySelector('a[title], [class*="wjcEIp"], [class*="KzDlHZ"]')?.textContent?.trim() || '';
        const priceText = card.querySelector('[class*="Nx9bqj"]')?.textContent?.trim() || '';
        const mrpText = card.querySelector('[class*="yRaY8j"]')?.textContent?.trim() || '';
        const link = card.querySelector('a')?.href || '';
        return { id: `fk-live-${i}`, title, priceText, mrpText, url: link };
      }).filter((x) => x.title && x.priceText);
    });

    return rawItems.map((item) => {
      const price = parsePrice(item.priceText);
      const mrp = parsePrice(item.mrpText) || price;
      const pack = parsePackSize(item.title);
      return {
        id: item.id,
        platform: 'flipkart',
        title: item.title,
        brand: query,
        category: 'Flipkart Minutes',
        packLabel: pack.packLabel,
        unitValue: pack.unitValue,
        unitType: pack.unitType,
        price,
        mrp,
        inStock: true,
        url: item.url
      };
    });
  });
}

app.post('/api/search', async (req, res) => {
  const { query = 'dove', addresses = {} } = req.body || {};
  const cleanQuery = String(query).trim();
  if (!cleanQuery) {
    return res.status(400).json({ error: 'query is required' });
  }

  const [jiomart, blinkit, flipkart] = await Promise.allSettled([
    scrapeJioMart(cleanQuery, addresses.jiomart),
    scrapeBlinkit(cleanQuery, addresses.blinkit),
    scrapeFlipkartMinutes(cleanQuery, addresses.flipkart)
  ]);

  const results = [
    ...(jiomart.status === 'fulfilled' ? jiomart.value : []),
    ...(blinkit.status === 'fulfilled' ? blinkit.value : []),
    ...(flipkart.status === 'fulfilled' ? flipkart.value : [])
  ];

  res.json({
    query: cleanQuery,
    fetchedAt: new Date().toISOString(),
    counts: {
      jiomart: jiomart.status === 'fulfilled' ? jiomart.value.length : 0,
      blinkit: blinkit.status === 'fulfilled' ? blinkit.value.length : 0,
      flipkart: flipkart.status === 'fulfilled' ? flipkart.value.length : 0
    },
    errors: {
      jiomart: jiomart.status === 'rejected' ? jiomart.reason?.message : null,
      blinkit: blinkit.status === 'rejected' ? blinkit.reason?.message : null,
      flipkart: flipkart.status === 'rejected' ? flipkart.reason?.message : null
    },
    results
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QuickCompare Cloud Server listening on port ${PORT}`);
});

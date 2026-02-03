require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

/* ------------------------------------------------------
   CORS CONFIGURATION FOR VERCEL
------------------------------------------------------ */
app.use(cors({
  origin: [
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'https://marome-investments-finance.vercel.app',
    /\.vercel\.app$/, // Allow all Vercel preview deployments
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

/* ------------------------------------------------------
   CONFIG / KEYS
------------------------------------------------------ */
const EODHD_KEY = process.env.EODHD_API_KEY;
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY;
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const FMP_KEY = process.env.FMP_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 5000;

/* ------------------------------------------------------
   CACHES
------------------------------------------------------ */
const MOVERS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes (was 2)
const GENERIC_TTL = 5 * 60 * 1000; // 5 minutes (was 1)
const HEATMAP_TTL = 15 * 60 * 1000; // 15 minutes (was 5)
const CALENDAR_TTL = 6 * 60 * 60 * 1000; // 6 hours
const CORRELATION_TTL = 60 * 60 * 1000; // 1 hour

let moversCache = null;
let moversCacheTimestamp = 0;
let indicesCache = null;
let indicesCacheTime = 0;
let forexCache = null;
let forexCacheTime = 0;
let heatmapCache = null;
let heatmapCacheTime = 0;
let cryptoCache = null;
let cryptoCacheTime = 0;
let commoditiesCache = null;
let commoditiesCacheTime = 0;
let cryptoHeatmapCache = null;
let cryptoHeatmapCacheTime = 0;
let calendarCache = null;
let calendarCacheTime = 0;
let newsCache = null;
let newsCacheTime = 0;
let correlationCache = {};
let correlationCacheTime = 0;

/* ------------------------------------------------------
   SYMBOLS
------------------------------------------------------ */

const FOREX_PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/ZAR",
  "EUR/ZAR",
  "GBP/ZAR",
  "AUD/USD",
  "USD/CHF"
];

const YAHOO_COMMODITY_SYMBOLS = {
  "Gold": "GC=F",
  "Silver": "SI=F",
  "Platinum": "PL=F",
  "Crude Oil": "CL=F"
};

const INDEX_SYMBOLS = {
  "S&P 500": "^GSPC",
  "NASDAQ 100": "^NDX",
  "Dow Jones": "^DJI",
  "JSE Top 40": "^J200.JO"
};

const YAHOO_FOREX_SYMBOLS = {
  "EUR/USD": "EURUSD=X",
  "GBP/USD": "GBPUSD=X",
  "USD/JPY": "USDJPY=X",
  "USD/ZAR": "USDZAR=X",
  "EUR/ZAR": "EURZAR=X",
  "GBP/ZAR": "GBPZAR=X",
  "AUD/USD": "AUDUSD=X",
  "USD/CHF": "USDCHF=X"
};

const YAHOO_HEATMAP_SYMBOLS = {
  "EUR/USD": "EURUSD=X",
  "GBP/USD": "GBPUSD=X",
  "USD/JPY": "USDJPY=X",
  "USD/ZAR": "USDZAR=X",
  "EUR/ZAR": "EURZAR=X",
  "GBP/ZAR": "GBPZAR=X",
  "AUD/USD": "AUDUSD=X",
  "USD/CHF": "USDCHF=X",
  Gold: "GC=F",        // ✅ Changed from ETF (GLD) to futures
  Silver: "SI=F",      // ✅ Changed from ETF (SLV) to futures
  Platinum: "PL=F",    // ✅ Changed from ETF (PPLT) to futures
  "Crude Oil": "CL=F"  // ✅ Changed from ETF (USO) to futures
};

// ✅ Correlation Matrix Assets
const CORRELATION_ASSETS = {
  "USD Index": "DX-Y.NYB",
  "Gold": "GC=F",
  "Silver": "SI=F",
  "Crude Oil": "CL=F",
  "Platinum": "PL=F",
  "EUR/USD": "EURUSD=X",
  "Bitcoin": "BTC-USD",
  "S&P 500": "^GSPC",
  "JSE Top 40": "^J200.JO"
};

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";

/* ------------------------------------------------------
   HELPERS
------------------------------------------------------ */
const http = axios.create({
  timeout: 10000,
  headers: { "User-Agent": "MaromeBot/1.0" }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const formatMover = (name, symbol, pct, type) => ({
  name,
  symbol,
  performance: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
  rawChange: pct,
  type,
  trend: pct >= 0 ? "positive" : "negative"
});

// ✅ Pearson Correlation Calculation
function calculateCorrelation(arr1, arr2) {
  const n = arr1.length;
  if (n !== arr2.length || n === 0) return 0;

  const mean1 = arr1.reduce((a, b) => a + b, 0) / n;
  const mean2 = arr2.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let sum1 = 0;
  let sum2 = 0;

  for (let i = 0; i < n; i++) {
    const diff1 = arr1[i] - mean1;
    const diff2 = arr2[i] - mean2;
    numerator += diff1 * diff2;
    sum1 += diff1 * diff1;
    sum2 += diff2 * diff2;
  }

  const denominator = Math.sqrt(sum1 * sum2);
  return denominator === 0 ? 0 : numerator / denominator;
}

/* ------------------------------------------------------
   NEWS
------------------------------------------------------ */
app.get("/api/news", async (req, res) => {
  try {
    if (newsCache && Date.now() - newsCacheTime < 5 * 60 * 1000) {
      console.log("✅ Using cached news data");
      return res.json(newsCache);
    }

    console.log("📰 Fetching news from Finnhub...");
    
    const r = await http.get(
      `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`
    );

    if (!r.data || !Array.isArray(r.data)) {
      console.error("❌ Invalid news response from Finnhub");
      return res.status(500).json({ error: "Failed to fetch news" });
    }

    console.log(`✅ Loaded ${r.data.length} news articles`);

    newsCache = r.data;
    newsCacheTime = Date.now();

    res.json(r.data);
  } catch (err) {
    console.error("❌ /api/news error:", err.message);
    
    if (err.response) {
      console.error("📍 Finnhub Response status:", err.response.status);
      console.error("📍 Finnhub Response data:", err.response.data);
    }
    
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

/* ------------------------------------------------------
   INDICES
------------------------------------------------------ */
app.get("/api/indices", async (req, res) => {
  try {
    if (indicesCache && Date.now() - indicesCacheTime < GENERIC_TTL)
      return res.json(indicesCache);

    const results = [];

    for (const [name, symbol] of Object.entries(INDEX_SYMBOLS)) {
      try {
        const r = await http.get(`${YAHOO_CHART}/${symbol}?interval=1d&range=5d`);
        const data = r.data.chart?.result?.[0];
        if (!data) continue;

        const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");
        if (closes.length < 2) continue;

        const pct = ((closes.at(-1) - closes.at(-2)) / closes.at(-2)) * 100;

        results.push({
          name,
          symbol,
          change: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          latest: closes.at(-1).toFixed(2),
          rawChange: pct
        });
      } catch (err) {
        console.warn(`⚠️ Index error ${symbol}:`, err.message);
      }

      await sleep(120);
    }

    indicesCache = results;
    indicesCacheTime = Date.now();
    res.json(results);

  } catch (err) {
    console.error("❌ /api/indices error:", err.message);
    res.status(500).json({ error: "Failed to fetch indices" });
  }
});

/* ------------------------------------------------------
   FOREX
------------------------------------------------------ */
app.get("/api/forex", async (req, res) => {
  try {
    if (forexCache && Date.now() - forexCacheTime < GENERIC_TTL)
      return res.json(forexCache);

    const results = [];

    for (const [pair, symbol] of Object.entries(YAHOO_FOREX_SYMBOLS)) {
      try {
        const r = await http.get(`${YAHOO_CHART}/${symbol}?interval=1d&range=5d`);
        const data = r.data.chart?.result?.[0];
        if (!data) continue;

        const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");
        if (closes.length < 2) continue;

        const pct = ((closes.at(-1) - closes.at(-2)) / closes.at(-2)) * 100;

        results.push({
          pair,
          name: pair,
          change: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          trend: pct >= 0 ? "positive" : "negative",
          price: closes.at(-1),
          rawChange: pct
        });

      } catch (err) {
        console.warn(`⚠️ Yahoo FX error for ${symbol}:`, err.message);
      }

      await sleep(100);
    }

    forexCache = results;
    forexCacheTime = Date.now();
    res.json(results);

  } catch (err) {
    console.error("❌ /api/forex error:", err.message);
    res.status(500).json({ error: "Failed to fetch forex" });
  }
});

/* ------------------------------------------------------
   FOREX STRENGTH
------------------------------------------------------ */
app.get("/api/forex-strength", async (req, res) => {
  try {
    const r = await http.get(`http://localhost:${PORT}/api/forex`).catch(() => null);
    const data = r?.data || [];

    const pairCount = { USD: 0, EUR: 0, GBP: 0, JPY: 0, AUD: 0, CHF: 0, ZAR: 0 };
    const strength = { USD: 0, EUR: 0, GBP: 0, JPY: 0, AUD: 0, CHF: 0, ZAR: 0 };

    data.forEach(item => {
      const pct = parseFloat(item.change);
      const [base, quote] = item.pair.split("/");

      pairCount[base]++;
      pairCount[quote]++;

      if (pct > 0) {
        strength[base] += pct;
        strength[quote] -= pct;
      } else if (pct < 0) {
        strength[base] += pct;
        strength[quote] -= pct;
      }
    });

    const avgStrength = {};
    Object.keys(strength).forEach(currency => {
      if (pairCount[currency] > 0) {
        avgStrength[currency] = strength[currency] / pairCount[currency];
      } else {
        avgStrength[currency] = 0;
      }
    });

    const result = {};
    Object.keys(avgStrength).forEach(currency => {
      const avg = avgStrength[currency];
      result[currency] = 
        avg >= 0.3 ? "Strong" :
        avg <= -0.3 ? "Weak" :
        "Neutral";
    });

    res.json(result);

  } catch (err) {
    console.error("❌ /api/forex-strength error:", err.message);
    res.status(500).json({ error: "Failed to compute strength" });
  }
});

/* ------------------------------------------------------
   COMMODITIES - Yahoo Finance with Extended History ✅
------------------------------------------------------ */
app.get("/api/commodities", async (req, res) => {
  try {
    if (commoditiesCache && Date.now() - commoditiesCacheTime < GENERIC_TTL)
      return res.json(commoditiesCache);

    const results = [];

    for (const [name, symbol] of Object.entries(YAHOO_COMMODITY_SYMBOLS)) {
      try {
        // Fetch 10 days of data to ensure we have valid comparison points
        const url = `${YAHOO_CHART}/${symbol}?interval=1d&range=10d`;
        const r = await http.get(url);
        const data = r.data.chart?.result?.[0];

        if (!data) {
          console.warn(`⚠️ No data for ${name} (${symbol})`);
          continue;
        }

        const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");

        if (closes.length < 2) {
          console.warn(`⚠️ Insufficient data for ${name}: only ${closes.length} data points`);
          continue;
        }

        const currentPrice = closes.at(-1);
        const previousPrice = closes.at(-2);

        if (isNaN(currentPrice) || isNaN(previousPrice) || previousPrice === 0) {
          console.warn(`⚠️ Invalid prices for ${name}: current=${currentPrice}, previous=${previousPrice}`);
          continue;
        }

        const pct = ((currentPrice - previousPrice) / previousPrice) * 100;

        if (isNaN(pct)) {
          console.warn(`⚠️ Calculated NaN for ${name}`);
          continue;
        }

        results.push({
          name,
          symbol: name,
          change: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          trend: pct >= 0 ? "positive" : "negative",
          price: currentPrice.toFixed(2),
          rawChange: pct
        });

        console.log(`✅ ${name}: $${currentPrice.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`);

      } catch (err) {
        console.warn(`⚠️ ${name} fetch error:`, err.message);
      }

      await sleep(400);
    }

    results.sort((a, b) => Math.abs(b.rawChange) - Math.abs(a.rawChange));

    commoditiesCache = results;
    commoditiesCacheTime = Date.now();
    res.json(results);

    console.log(`✅ Loaded ${results.length} commodities (Yahoo Finance)`);

  } catch (err) {
    console.error("❌ /api/commodities error:", err.message);
    res.status(500).json({ error: "Failed to fetch commodities" });
  }
});

/* ------------------------------------------------------
   CRYPTO
------------------------------------------------------ */
app.get("/api/crypto", async (req, res) => {
  try {
    if (cryptoCache && Date.now() - cryptoCacheTime < GENERIC_TTL)
      return res.json(cryptoCache);

    const cryptoSymbols = {
      BTC: "BTC-USD",
      ETH: "ETH-USD",
      XRP: "XRP-USD",
      SOL: "SOL-USD",
      ADA: "ADA-USD",
      DOGE: "DOGE-USD",
      AVAX: "AVAX-USD",
      BNB: "BNB-USD",
      LTC: "LTC-USD"
    };

    const results = [];

    for (const [name, symbol] of Object.entries(cryptoSymbols)) {
      try {
        const url = `${YAHOO_CHART}/${symbol}?interval=1d&range=5d`;
        const r = await http.get(url);
        const data = r.data.chart?.result?.[0];
        if (!data) continue;

        const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");
        if (closes.length < 2) continue;

        const currentPrice = closes.at(-1);
        const previousPrice = closes.at(-2);
        const pct = ((currentPrice - previousPrice) / previousPrice) * 100;

        results.push({
          name,
          symbol,
          price: currentPrice.toFixed(2),
          change: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          trend: pct >= 0 ? "positive" : "negative",
          rawChange: pct
        });

      } catch (err) {
        console.warn(`⚠️ Crypto fetch error for ${symbol}:`, err.message);
      }

      await sleep(150);
    }

    cryptoCache = results;
    cryptoCacheTime = Date.now();
    res.json(results);

  } catch (err) {
    console.error("❌ /api/crypto error:", err.message);
    res.status(500).json({ error: "Failed to fetch crypto" });
  }
});

/* ------------------------------------------------------
   CORRELATION MATRIX ✅ NEW FEATURE
------------------------------------------------------ */
app.get("/api/correlation-matrix", async (req, res) => {
  try {
    const period = req.query.period || '30'; // 7, 30, 90, or 365 days
    const cacheKey = `correlation_${period}`;

    // Check cache
    if (correlationCache[cacheKey] && 
        Date.now() - correlationCacheTime < CORRELATION_TTL) {
      console.log(`✅ Using cached correlation matrix (${period} days)`);
      return res.json(correlationCache[cacheKey]);
    }

    console.log(`📊 Calculating correlation matrix (${period} days)...`);

    // Step 1: Fetch historical data for all assets
    const priceData = {};

    for (const [name, symbol] of Object.entries(CORRELATION_ASSETS)) {
      try {
        const url = `${YAHOO_CHART}/${symbol}?interval=1d&range=${period}d`;
        const r = await http.get(url);
        const data = r.data.chart?.result?.[0];

        if (!data) {
          console.warn(`⚠️ No data for ${name} (${symbol})`);
          continue;
        }

        const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");

        if (closes.length < 5) {
          console.warn(`⚠️ Insufficient data for ${name}: ${closes.length} days`);
          continue;
        }

        priceData[name] = closes;
        console.log(`✅ Fetched ${closes.length} days for ${name}`);

      } catch (err) {
        console.warn(`⚠️ Error fetching ${name}:`, err.message);
      }

      await sleep(100);
    }

    // Step 2: Calculate correlation matrix
    const assets = Object.keys(priceData);
    const matrix = {};

    for (const asset1 of assets) {
      matrix[asset1] = {};

      for (const asset2 of assets) {
        if (asset1 === asset2) {
          matrix[asset1][asset2] = 1.0;
        } else {
          const minLength = Math.min(priceData[asset1].length, priceData[asset2].length);
          const data1 = priceData[asset1].slice(-minLength);
          const data2 = priceData[asset2].slice(-minLength);

          const correlation = calculateCorrelation(data1, data2);
          matrix[asset1][asset2] = parseFloat(correlation.toFixed(2));
        }
      }
    }

    // Step 3: Build response
    const response = {
      period: parseInt(period),
      assets: assets,
      matrix: matrix,
      timestamp: new Date().toISOString()
    };

    // Cache it
    correlationCache[cacheKey] = response;
    correlationCacheTime = Date.now();

    console.log(`✅ Correlation matrix calculated for ${assets.length} assets`);

    res.json(response);

  } catch (err) {
    console.error("❌ /api/correlation-matrix error:", err.message);
    res.status(500).json({ error: "Failed to calculate correlation matrix" });
  }
});

/* ------------------------------------------------------
   CRYPTO MOVERS
------------------------------------------------------ */
async function fetchEodCryptoMovers() {
  const cryptoSymbols = {
    BTC: "BTC-USD",
    ETH: "ETH-USD",
    XRP: "XRP-USD",
    SOL: "SOL-USD",
    ADA: "ADA-USD"
  };

  const items = [];

  for (const [name, symbol] of Object.entries(cryptoSymbols)) {
    try {
      const r = await http.get(`${YAHOO_CHART}/${symbol}?interval=1d&range=5d`);
      const data = r.data.chart?.result?.[0];
      if (!data) continue;

      const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");
      if (closes.length < 2) continue;

      const currentPrice = closes.at(-1);
      const previousPrice = closes.at(-2);
      const pct = ((currentPrice - previousPrice) / previousPrice) * 100;

      items.push(formatMover(name, symbol, pct, "Crypto"));

    } catch (err) {
      console.warn("⚠️ Crypto mover error:", symbol, err.message);
    }

    await sleep(150);
  }

  return items;
}

/* ------------------------------------------------------
   COMMODITY MOVERS
------------------------------------------------------ */
async function fetchCommodityMovers() {
  const items = [];

  for (const [name, symbol] of Object.entries(YAHOO_COMMODITY_SYMBOLS)) {
    try {
      const url = `${YAHOO_CHART}/${symbol}?interval=1d&range=5d`;
      const r = await http.get(url);
      const data = r.data.chart?.result?.[0];

      if (!data) continue;

      const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");
      if (closes.length < 2) continue;

      const currentPrice = closes.at(-1);
      const previousPrice = closes.at(-2);

      if (isNaN(currentPrice) || isNaN(previousPrice) || previousPrice === 0) continue;

      const pct = ((currentPrice - previousPrice) / previousPrice) * 100;

      if (isNaN(pct)) continue;

      items.push(formatMover(name, name, pct, "Commodity"));

    } catch (err) {
      console.warn("⚠️ Commodity mover error:", name, err.message);
    }

    await sleep(200);
  }

  return items;
}

/* ------------------------------------------------------
   STOCK MOVERS
------------------------------------------------------ */
async function fetchEodTopStocks(limit = 6) {
  if (!EODHD_KEY) return { items: [] };

  const fetchSide = async (side) => {
    try {
      const r = await http.get(
        `https://eodhd.com/api/top?api_token=${EODHD_KEY}&screener=${side}&limit=${limit}&fmt=json`
      );

      if (!Array.isArray(r.data)) return { items: [] };

      const items = r.data.map(it =>
        formatMover(
          it.name || it.code,
          it.code,
          parseFloat(it.change_percent ?? 0),
          "Stock"
        )
      );

      return { items };

    } catch {
      return { items: [] };
    }
  };

  const g = await fetchSide("most_gainer_stocks");
  const l = await fetchSide("most_loser_stocks");

  return { items: [...g.items, ...l.items] };
}

/* ------------------------------------------------------
   FOREX MOVERS
------------------------------------------------------ */
async function fetchForexMovers() {
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${FOREX_PAIRS.join(",")}&apikey=${TWELVEDATA_KEY}`;
    const r = await http.get(url);

    return FOREX_PAIRS.map(pair => {
      const d = r.data[pair];
      if (!d?.percent_change) return null;
      return formatMover(pair, pair, parseFloat(d.percent_change), "Forex");
    }).filter(Boolean);

  } catch {
    return [];
  }
}

/* ------------------------------------------------------
   ALL MOVERS
------------------------------------------------------ */
app.get("/api/all-movers", async (req, res) => {
  try {
    if (moversCache && Date.now() - moversCacheTimestamp < MOVERS_CACHE_TTL)
      return res.json(moversCache);

    const [stocksRes, cryptoRes, fxRes, comRes] = await Promise.allSettled([
      fetchEodTopStocks(6),
      fetchEodCryptoMovers(),
      fetchForexMovers(),
      fetchCommodityMovers()
    ]);

    let combined = [];

    if (stocksRes.value?.items) combined.push(...stocksRes.value.items);
    if (cryptoRes.value) combined.push(...cryptoRes.value);
    if (fxRes.value) combined.push(...fxRes.value);
    if (comRes.value) combined.push(...comRes.value);

    for (const [name, symbol] of Object.entries(INDEX_SYMBOLS)) {
      try {
        const r = await http.get(`${YAHOO_CHART}/${symbol}?interval=1d&range=5d`);
        const data = r.data.chart?.result?.[0];
        if (!data) continue;

        const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");
        if (closes.length < 2) continue;

        const pct = ((closes.at(-1) - closes.at(-2)) / closes.at(-2)) * 100;

        combined.push(formatMover(name, symbol, pct, "Index"));

      } catch {}

      await sleep(120);
    }

    const map = new Map();

    combined.forEach(item => {
      if (
        !map.has(item.symbol) ||
        Math.abs(item.rawChange) > Math.abs(map.get(item.symbol).rawChange)
      ) {
        map.set(item.symbol, item);
      }
    });

    const sorted = [...map.values()]
      .sort((a, b) => Math.abs(b.rawChange) - Math.abs(a.rawChange))
      .slice(0, 10);

    moversCache = sorted;
    moversCacheTimestamp = Date.now();

    res.json(sorted);

  } catch (err) {
    console.error("❌ /api/all-movers error:", err.message);
    res.status(500).json({ error: "Failed to fetch movers" });
  }
});

/* ------------------------------------------------------
   FOREX HEATMAP
------------------------------------------------------ */
app.get("/api/forex-heatmap", async (req, res) => {
  try {
    if (heatmapCache && Date.now() - heatmapCacheTime < HEATMAP_TTL)
      return res.json(heatmapCache);

    const results = {};

    for (const [label, symbol] of Object.entries(YAHOO_HEATMAP_SYMBOLS)) {

      const timeframes = {
        "1h": { interval: "5m", range: "1d" },
        "4h": { interval: "15m", range: "5d" },
        "1d": { interval: "1d", range: "5d" },
        "1w": { interval: "1d", range: "1mo" }
      };

      const tfResults = {};

      for (const [tf, params] of Object.entries(timeframes)) {
        let pct = null;

        try {
          const url = `${YAHOO_CHART}/${symbol}?interval=${params.interval}&range=${params.range}`;
          const r = await http.get(url);
          const data = r.data.chart?.result?.[0];

          if (data && data.indicators?.quote?.[0]?.close) {
            const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");

            if (closes.length >= 2) {
              let compareIndex = -2;

              if (tf === "1h" && closes.length >= 13) compareIndex = -13;
              if (tf === "4h" && closes.length >= 17) compareIndex = -17;
              if (tf === "1w" && closes.length >= 8) compareIndex = -8;

              if (Math.abs(compareIndex) <= closes.length) {
                const current = closes.at(-1);
                const previous = closes.at(compareIndex);
                pct = ((current - previous) / previous) * 100;
              }
            }
          }

          // ✅ Fallback for 1h: if no data with 5m, try 15m interval
          if (pct === null && tf === "1h") {
            const fallbackUrl = `${YAHOO_CHART}/${symbol}?interval=15m&range=5d`;
            const fallbackR = await http.get(fallbackUrl);
            const fallbackData = fallbackR.data.chart?.result?.[0];

            if (fallbackData && fallbackData.indicators?.quote?.[0]?.close) {
              const fallbackCloses = fallbackData.indicators.quote[0].close.filter(n => typeof n === "number");
              
              // For 1h with 15m intervals, we need 4 data points (4 x 15min = 60min)
              if (fallbackCloses.length >= 5) {
                const current = fallbackCloses.at(-1);
                const previous = fallbackCloses.at(-5); // 1 hour ago (4 intervals)
                pct = ((current - previous) / previous) * 100;
              }
            }
          }

        } catch (err) {
          console.warn(`⚠️ Heatmap error ${symbol} (${tf}):`, err.message);
        }

        tfResults[tf] = pct;
        await sleep(100);
      }

      results[label] = tfResults;
      console.log(`✅ Heatmap loaded for ${label}:`, tfResults);
    }

    heatmapCache = results;
    heatmapCacheTime = Date.now();
    res.json(results);

  } catch (err) {
    console.error("❌ /api/forex-heatmap error:", err.message);
    res.status(500).json({ error: "Failed to load heatmap" });
  }
});

/* ------------------------------------------------------
   CRYPTO HEATMAP
------------------------------------------------------ */
app.get("/api/crypto-heatmap", async (req, res) => {
  try {
    if (cryptoHeatmapCache && Date.now() - cryptoHeatmapCacheTime < HEATMAP_TTL)
      return res.json(cryptoHeatmapCache);

    const cryptoSymbols = {
      BTC: "BTC-USD",
      ETH: "ETH-USD",
      XRP: "XRP-USD",
      SOL: "SOL-USD",
      ADA: "ADA-USD",
      DOGE: "DOGE-USD",
      AVAX: "AVAX-USD",
      BNB: "BNB-USD",
      LTC: "LTC-USD"
    };

    const results = {};

    for (const [name, symbol] of Object.entries(cryptoSymbols)) {

      const timeframes = {
        "1h": { interval: "5m", range: "1d" },
        "4h": { interval: "15m", range: "5d" },
        "1d": { interval: "1d", range: "5d" },
        "1w": { interval: "1d", range: "1mo" }
      };

      const tfResults = {};

      for (const [tf, params] of Object.entries(timeframes)) {
        let pct = null;

        try {
          const url = `${YAHOO_CHART}/${symbol}?interval=${params.interval}&range=${params.range}`;
          const r = await http.get(url);
          const data = r.data.chart?.result?.[0];

          if (data && data.indicators?.quote?.[0]?.close) {
            const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");

            if (closes.length >= 2) {
              let compareIndex = -2;

              if (tf === "1h" && closes.length >= 13) compareIndex = -13;
              if (tf === "4h" && closes.length >= 17) compareIndex = -17;
              if (tf === "1w" && closes.length >= 8) compareIndex = -8;

              if (Math.abs(compareIndex) <= closes.length) {
                const current = closes.at(-1);
                const previous = closes.at(compareIndex);
                pct = ((current - previous) / previous) * 100;
              }
            }
          }

        } catch (err) {
          console.warn(`⚠️ Crypto heatmap error ${symbol} (${tf}):`, err.message);
        }

        tfResults[tf] = pct;
        await sleep(100);
      }

      results[name] = tfResults;
      console.log(`✅ Crypto heatmap loaded for ${name}:`, tfResults);
    }

    cryptoHeatmapCache = results;
    cryptoHeatmapCacheTime = Date.now();
    res.json(results);

  } catch (err) {
    console.error("❌ /api/crypto-heatmap error:", err.message);
    res.status(500).json({ error: "Failed to load crypto heatmap" });
  }
});

/* ------------------------------------------------------
   ECONOMIC CALENDAR
------------------------------------------------------ */
app.get("/api/economic-calendar", async (req, res) => {
  try {
    if (calendarCache && Date.now() - calendarCacheTime < CALENDAR_TTL) {
      console.log("✅ Using cached calendar data");
      return res.json(calendarCache);
    }

    const today = new Date();
    const nextMonth = new Date(today);
    nextMonth.setDate(today.getDate() + 30);
    
    const fromDate = today.toISOString().split('T')[0];
    const toDate = nextMonth.toISOString().split('T')[0];
    
    const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${fromDate}&to=${toDate}&apikey=${FMP_KEY}`;
    
    console.log("📅 Fetching economic calendar from FMP...");
    console.log(`📆 Date range: ${fromDate} to ${toDate}`);
    
    const r = await http.get(url);
    
    if (!Array.isArray(r.data) || r.data.length === 0) {
      console.log("⚠️ No events found from FMP");
      return res.json([]);
    }
    
    console.log(`📊 Received ${r.data.length} events from FMP`);
    
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    
    const events = r.data
      .filter(event => {
        if (!event.event || !event.country || !event.date) return false;
        const eventDate = new Date(event.date);
        return eventDate >= todayMidnight;
      })
      .map(event => {
        const dateTime = new Date(event.date);
        const dateOnly = dateTime.toISOString().split('T')[0];
        const hours = String(dateTime.getHours()).padStart(2, '0');
        const minutes = String(dateTime.getMinutes()).padStart(2, '0');
        const timeOnly = `${hours}:${minutes}`;
        
        let importance = "Medium";
        const impact = (event.impact || "").toLowerCase();
        
        if (impact === "high") {
          importance = "High";
        } else if (impact === "medium") {
          importance = "Medium";
        } else if (impact === "low") {
          importance = "Low";
        } else {
          const eventName = (event.event || "").toLowerCase();
          const highKeywords = ['gdp', 'interest rate', 'nfp', 'non-farm', 'payroll',
                               'cpi', 'unemployment', 'inflation', 'fed', 'fomc',
                               'central bank', 'rate decision', 'ppi', 'retail sales'];
          const mediumKeywords = ['pmi', 'trade balance', 'consumer confidence',
                                 'manufacturing', 'industrial production', 'sentiment'];
          
          if (highKeywords.some(k => eventName.includes(k))) {
            importance = "High";
          } else if (mediumKeywords.some(k => eventName.includes(k))) {
            importance = "Medium";
          } else {
            importance = "Low";
          }
        }
        
        return {
          date: dateOnly,
          time: timeOnly,
          country: event.country,
          event: event.event,
          actual: event.actual !== null && event.actual !== undefined ? event.actual : null,
          forecast: event.estimate !== null && event.estimate !== undefined ? event.estimate : null,
          previous: event.previous !== null && event.previous !== undefined ? event.previous : null,
          importance: importance,
          currency: event.currency || event.country,
          rawDateTime: dateTime
        };
      })
      .filter(event => {
        const majorCountries = ['US', 'GB', 'UK', 'EU', 'JP', 'CN', 'CA', 'AU', 'NZ', 'CH', 'ZA',
                               'DE', 'FR', 'IT', 'ES', 'BR', 'MX', 'IN',
                               'United States', 'United Kingdom', 'Euro Area', 'Germany',
                               'France', 'Japan', 'China', 'Canada', 'Australia', 'South Africa'];
        
        const countryUpper = event.country.toUpperCase();
        return majorCountries.some(c => 
          countryUpper.includes(c.toUpperCase()) || 
          c.toUpperCase().includes(countryUpper)
        );
      })
      .sort((a, b) => a.rawDateTime - b.rawDateTime)
      .slice(0, 100);
    
    console.log(`✅ Loaded ${events.length} economic events (filtered)`);
    
    if (events.length > 0) {
      console.log(`📅 First event: ${events[0].date} ${events[0].time} - ${events[0].event} (${events[0].country})`);
      console.log(`📅 Last event: ${events[events.length - 1].date} - ${events[events.length - 1].event}`);
      
      const eventsByDate = {};
      events.forEach(e => {
        eventsByDate[e.date] = (eventsByDate[e.date] || 0) + 1;
      });
      
      const dateList = Object.keys(eventsByDate).slice(0, 10).map(d => `${d}: ${eventsByDate[d]}`);
      console.log(`📊 Events distribution: [${dateList.join(', ')}]`);
    } else {
      console.log("⚠️ No events found after filtering");
    }
    
    calendarCache = events;
    calendarCacheTime = Date.now();
    
    res.json(events);
    
  } catch (err) {
    console.error("❌ FMP calendar error:", err.message);
    
    if (err.response) {
      console.error("📍 FMP Response status:", err.response.status);
      console.error("📍 FMP Response data:", err.response.data);
    }
    
    res.status(500).json({ 
      error: "Failed to fetch economic calendar",
      details: err.message 
    });
  }
});

/* ------------------------------------------------------
   JSE STOCKS
------------------------------------------------------ */
app.get("/api/jse-stocks", async (req, res) => {
  try {
    const JSE_SYMBOLS = {
      "Naspers": "NPN.JO",
      "Prosus": "PRX.JO",
      "Anglo American": "AGL.JO",
      "BHP Group": "BHP.JO",
      "Standard Bank": "SBK.JO",
      "FirstRand": "FSR.JO",
      "MTN Group": "MTN.JO",
      "Sasol": "SOL.JO",
      "Shoprite": "SHP.JO",
      "Capitec Bank": "CPI.JO",
      "Sanlam": "SLM.JO",
      "Nedbank": "NED.JO",
      "Vodacom": "VOD.JO",
      "Impala Platinum": "IMP.JO",
      "Gold Fields": "GFI.JO"
    };

    const results = [];

    for (const [name, symbol] of Object.entries(JSE_SYMBOLS)) {
      try {
        const url = `${YAHOO_CHART}/${symbol}?interval=1d&range=5d`;
        const r = await http.get(url);
        const data = r.data.chart?.result?.[0];

        if (!data) {
          console.warn(`⚠️ No data for ${symbol}`);
          continue;
        }

        const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");

        if (closes.length < 2) {
          console.warn(`⚠️ Insufficient data for ${symbol}`);
          continue;
        }

        const currentPrice = closes.at(-1);
        const previousPrice = closes.at(-2);

        if (isNaN(currentPrice) || isNaN(previousPrice) || previousPrice === 0) {
          console.warn(`⚠️ Invalid prices for ${symbol}`);
          continue;
        }

        const pct = ((currentPrice - previousPrice) / previousPrice) * 100;

        if (isNaN(pct)) {
          console.warn(`⚠️ Calculated NaN for ${symbol}`);
          continue;
        }

        results.push({
          name,
          symbol,
          price: `R ${currentPrice.toFixed(2)}`,
          change: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          trend: pct >= 0 ? "positive" : "negative",
          rawChange: pct,
          currency: "ZAR"
        });

        console.log(`✅ JSE: ${name} - R${currentPrice.toFixed(2)} (${pct.toFixed(2)}%)`);

      } catch (err) {
        console.warn(`⚠️ JSE stock error ${symbol}:`, err.message);
      }

      await sleep(150);
    }

    results.sort((a, b) => Math.abs(b.rawChange) - Math.abs(a.rawChange));

    console.log(`✅ Loaded ${results.length} JSE stocks`);
    
    res.json(results);

  } catch (err) {
    console.error("❌ /api/jse-stocks error:", err.message);
    res.status(500).json({ error: "Failed to fetch JSE stocks" });
  }
});

/* ------------------------------------------------------
   US STOCKS
------------------------------------------------------ */
app.get("/api/us-stocks", async (req, res) => {
  try {
    if (!EODHD_KEY) {
      return res.status(500).json({ error: "EODHD API key not configured" });
    }

    const US_SYMBOLS = {
      "Apple": "AAPL.US",
      "Microsoft": "MSFT.US",
      "Amazon": "AMZN.US",
      "Google": "GOOGL.US",
      "Tesla": "TSLA.US",
      "NVIDIA": "NVDA.US",
      "Meta": "META.US",
      "JPMorgan": "JPM.US",
      "Visa": "V.US",
      "Coca-Cola": "KO.US",
      "Johnson & Johnson": "JNJ.US",
      "Walmart": "WMT.US",
      "Mastercard": "MA.US",
      "Pfizer": "PFE.US",
      "Netflix": "NFLX.US"
    };

    const results = [];

    for (const [name, symbol] of Object.entries(US_SYMBOLS)) {
      try {
        const r = await http.get(
          `https://eodhd.com/api/real-time/${symbol}?api_token=${EODHD_KEY}&fmt=json`
        );

        if (!r.data) {
          console.warn(`⚠️ No data for ${symbol}`);
          continue;
        }

        const close = parseFloat(r.data.close);
        const previousClose = parseFloat(r.data.previousClose);

        if (isNaN(close) || isNaN(previousClose) || previousClose === 0) {
          console.warn(`⚠️ Invalid data for ${symbol}: close=${close}, prev=${previousClose}`);
          continue;
        }

        const currentPrice = close;
        const previousPrice = previousClose;
        const pct = ((currentPrice - previousPrice) / previousPrice) * 100;

        if (isNaN(pct)) {
          console.warn(`⚠️ Calculated NaN for ${symbol}`);
          continue;
        }

        results.push({
          name,
          symbol,
          price: `$${currentPrice.toFixed(2)}`,
          change: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          trend: pct >= 0 ? "positive" : "negative",
          rawChange: pct,
          currency: "USD"
        });

        console.log(`✅ US: ${name} - ${pct.toFixed(2)}%`);

      } catch (err) {
        console.warn(`⚠️ US stock error ${symbol}:`, err.message);
      }

      await sleep(100);
    }

    results.sort((a, b) => Math.abs(b.rawChange) - Math.abs(a.rawChange));

    console.log(`✅ Loaded ${results.length} US stocks`);
    
    res.json(results);

  } catch (err) {
    console.error("❌ /api/us-stocks error:", err.message);
    res.status(500).json({ error: "Failed to fetch US stocks" });
  }
});

/* ------------------------------------------------------
   SA MARKETS
------------------------------------------------------ */
app.get("/api/sa-markets", async (req, res) => {
  try {
    const indicesResp = await http.get(`http://localhost:${PORT}/api/indices`).catch(() => ({ data: [] }));
    const allIndices = indicesResp.data || [];
    
    const jseIndices = allIndices.filter(idx => 
      idx.name.includes("JSE") || idx.symbol.includes(".JO")
    );

    const forexResp = await http.get(`http://localhost:${PORT}/api/forex`).catch(() => ({ data: [] }));
    const allForex = forexResp.data || [];
    
    const zarForex = allForex.filter(fx => 
      fx.pair.includes("ZAR")
    );

    const commoditiesResp = await http.get(`http://localhost:${PORT}/api/commodities`).catch(() => ({ data: [] }));
    const allCommodities = commoditiesResp.data || [];

    const usdZarPair = zarForex.find(fx => fx.pair === "USD/ZAR");
    const usdZarRate = usdZarPair ? usdZarPair.price : 18.75;

    const commoditiesInZAR = allCommodities.map(comm => {
      const priceUSD = parseFloat(comm.price);
      const priceZAR = priceUSD * usdZarRate;
      
      return {
        name: comm.name,
        priceZAR: `R ${priceZAR.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`,
        change: comm.change,
        rawChange: comm.rawChange
      };
    });

    const nextEvent = {
      name: "SARB Interest Rate Decision",
      date: "March 27, 2026"
    };

    res.json({
      indices: jseIndices,
      forex: zarForex,
      commodities: commoditiesInZAR,
      nextEvent: nextEvent
    });

  } catch (err) {
    console.error("❌ /api/sa-markets error:", err.message);
    res.status(500).json({ error: "Failed to fetch SA markets data" });
  }
});

/* ------------------------------------------------------
   TEST EODHD SPOT GOLD ✅ TEMPORARY TEST
------------------------------------------------------ */
app.get("/api/test-eodhd-gold", async (req, res) => {
  try {
    console.log("🧪 Testing EODHD spot gold...");
    
    const symbols = [
      "XAUUSD.FOREX",  // Gold spot
      "XAGUSD.FOREX",  // Silver spot
      "XPTUSD.FOREX",  // Platinum spot
      "WTIUSD.FOREX"   // WTI Oil spot (if exists)
    ];

    const results = {};

    for (const symbol of symbols) {
      try {
        // Try real-time endpoint
        const url = `https://eodhd.com/api/real-time/${symbol}?api_token=${EODHD_KEY}&fmt=json`;
        console.log(`📍 Testing: ${url}`);
        
        const r = await http.get(url);
        
        console.log(`✅ ${symbol} response:`, r.data);
        
        results[symbol] = {
          status: "success",
          data: r.data
        };

      } catch (err) {
        console.error(`❌ ${symbol} error:`, err.message);
        
        results[symbol] = {
          status: "error",
          message: err.message,
          response: err.response?.data
        };
      }

      await sleep(500);
    }

    res.json(results);

  } catch (err) {
    console.error("❌ Test error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------
   MAROME AI CHAT ENDPOINT
------------------------------------------------------ */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history, context } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    // Build conversation context
    const systemPrompt = `You are Marome, a helpful and knowledgeable financial advisor assistant for Marome Investments web application. You provide clear, accurate information about finance, investments, stock markets, forex, cryptocurrencies, and general financial planning.

AVAILABLE PAGES IN THIS APPLICATION:
- **Home Page** (index.html): Dashboard with global top movers, market overview, and latest financial news
- **Stock Markets** (stocks.html): S&P 500, NASDAQ 100, Dow Jones, JSE Top 40 indices and major stocks
- **SA Markets** (sa-markets.html): South African markets - JSE stocks, ZAR currency pairs, and local economic data
- **Forex & Commodities** (forex.html): Currency pairs (EUR/USD, GBP/USD, USD/ZAR, etc.) and commodities (Gold, Silver, Oil, Platinum)
- **Cryptocurrency** (crypto.html): Bitcoin, Ethereum, XRP, Solana, ADA, Dogecoin, Litecoin and other cryptos
- **Market Analysis** (analysis.html): Forex & crypto heatmaps, correlation matrix, and technical analysis tools
- **Economic Calendar** (calendar.html): Upcoming economic events, central bank meetings, and important financial announcements

When users ask where to find specific data or features, guide them to the appropriate page. Be concise but informative. Always be professional and helpful.`;
    
    let conversationText = systemPrompt + '\n\n';
    
    // Add current page context if available
    if (context && context.currentPage) {
      conversationText += `USER IS CURRENTLY ON: ${context.pageTitle} (${context.currentPage})\n\n`;
    }
    
    // Add conversation history
    if (history && Array.isArray(history)) {
      history.forEach(msg => {
        conversationText += `${msg.role === 'user' ? 'User' : 'Marome'}: ${msg.content}\n\n`;
      });
    }
    
    conversationText += `User: ${message}\n\nMarome:`;

    // Call Gemini API
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: conversationText
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 500,
          topP: 0.8,
          topK: 40
        }
      }
    );

    const aiResponse = geminiResponse.data.candidates[0].content.parts[0].text;

    res.json({ response: aiResponse });
  } catch (error) {
    console.error('Gemini API Error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to get AI response',
      details: error.response?.data?.error?.message || error.message
    });
  }
});

/* ------------------------------------------------------
   START SERVER
------------------------------------------------------ */
app.listen(PORT, () => {
  console.log(`🚀 Marome Backend running on port ${PORT}`);
  console.log(`📊 Correlation Matrix API: http://localhost:${PORT}/api/correlation-matrix?period=30`);
  console.log(`🧪 EODHD Test: http://localhost:${PORT}/api/test-eodhd-gold`);
  console.log(`💬 Marome Chat AI: http://localhost:${PORT}/api/chat`);
});
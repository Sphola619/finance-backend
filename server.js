require("dotenv").config();
const express = require("express");
const httpServer = require("http");
const cors = require("cors");
const axios = require("axios");
const WebSocket = require("ws");

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
const IRESS_JWT_TOKEN = process.env.IRESS_JWT_TOKEN;
const PORT = process.env.PORT || 5000;

/* ------------------------------------------------------
   CACHES
------------------------------------------------------ */
const MOVERS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const GENERIC_TTL = 5 * 60 * 1000; // 5 minutes
const HEATMAP_TTL = 15 * 60 * 1000; // 15 minutes
const CALENDAR_TTL = 6 * 60 * 60 * 1000; // 6 hours
const CORRELATION_TTL = 60 * 60 * 1000; // 1 hour
const JSE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes (matches iress update frequency)
const ECONOMIC_INDICATORS_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

let moversCache = null;
let moversCacheTimestamp = 0;
let indicesCache = null;
let indicesCacheTime = 0;

// WebSocket cache for EODHD real-time indices
const wsIndicesData = {
  "GSPC.INDX": null,
  "NDX.INDX": null,
  "DJI.INDX": null
};

// WebSocket cache for EODHD real-time US stocks
const wsStocksData = {
  "AAPL.US": null,
  "MSFT.US": null,
  "AMZN.US": null,
  "GOOGL.US": null,
  "TSLA.US": null,
  "NVDA.US": null,
  "META.US": null,
  "JPM.US": null,
  "V.US": null,
  "KO.US": null,
  "JNJ.US": null,
  "WMT.US": null,
  "MA.US": null,
  "PFE.US": null,
  "NFLX.US": null
};

// WebSocket cache for EODHD real-time forex
const wsForexData = {
  "EURUSD": null,
  "GBPUSD": null,
  "USDJPY": null,
  "USDZAR": null,
  "EURZAR": null,
  "GBPZAR": null,
  "AUDUSD": null,
  "USDCHF": null
};
const forexPrevClose = {};
const forexRestChangePercent = {};
const forexRestClose = {};
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
let jseCache = null;
let jseCacheTime = 0;
let economicIndicatorsCache = null;
let economicIndicatorsCacheTime = 0;

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
  "S&P 500": "GSPC.INDX",
  "NASDAQ 100": "NDX.INDX",
  "Dow Jones": "DJI.INDX",
  "JSE Top 40": "^J200.JO"  // Yahoo Finance
};

const EODHD_FOREX_SYMBOLS = {
  "EUR/USD": "EURUSD.FOREX",
  "GBP/USD": "GBPUSD.FOREX",
  "USD/JPY": "USDJPY.FOREX",
  "USD/ZAR": "USDZAR.FOREX",
  "EUR/ZAR": "EURZAR.FOREX",
  "GBP/ZAR": "GBPZAR.FOREX",
  "AUD/USD": "AUDUSD.FOREX",
  "USD/CHF": "USDCHF.FOREX"
};

const FOREX_SYMBOL_TO_PAIR = Object.entries(EODHD_FOREX_SYMBOLS).reduce((acc, [pair, symbol]) => {
  acc[symbol.replace(".FOREX", "")] = pair;
  return acc;
}, {});

async function refreshForexPrevClose() {
  for (const symbol of Object.values(EODHD_FOREX_SYMBOLS)) {
    try {
      const wsSymbol = symbol.replace(".FOREX", "");
      const url = `https://eodhd.com/api/real-time/${symbol}?api_token=${EODHD_KEY}&fmt=json`;
      const r = await http.get(url);
      const previousClose = parseFloat(r.data?.previousClose);
      const changePercent = parseFloat(r.data?.change_p);
      const close = parseFloat(r.data?.close);
      if (!isNaN(previousClose)) {
        forexPrevClose[wsSymbol] = previousClose;
      }
      if (!isNaN(changePercent)) {
        forexRestChangePercent[wsSymbol] = changePercent;
      }
      if (!isNaN(close)) {
        forexRestClose[wsSymbol] = close;
      }
    } catch (err) {
      console.warn(`⚠️ Prev close fetch error for ${symbol}:`, err.message);
    }

    await sleep(100);
  }
}

const YAHOO_HEATMAP_SYMBOLS = {
  "EUR/USD": "EURUSD=X",
  "GBP/USD": "GBPUSD=X",
  "USD/JPY": "USDJPY=X",
  "USD/ZAR": "USDZAR=X",
  "EUR/ZAR": "EURZAR=X",
  "GBP/ZAR": "GBPZAR=X",
  "AUD/USD": "AUDUSD=X",
  "USD/CHF": "USDCHF=X",
  Gold: "GC=F",        //  Changed from ETF (GLD) to futures
  Silver: "SI=F",      //  Changed from ETF (SLV) to futures
  Platinum: "PL=F",    //  Changed from ETF (PPLT) to futures
  "Crude Oil": "CL=F"  //  Changed from ETF (USO) to futures
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
   NEWS - General Financial Market News
------------------------------------------------------ */
app.get("/api/news", async (req, res) => {
  try {
    if (newsCache && Date.now() - newsCacheTime < 5 * 60 * 1000) {
      console.log("✅ Using cached news data");
      return res.json(newsCache);
    }

    console.log("📰 Fetching news from EODHD...");
    
    const r = await http.get(
      `https://eodhd.com/api/news?api_token=${EODHD_KEY}&limit=50&offset=0&fmt=json`
    );

    if (!r.data || !Array.isArray(r.data)) {
      console.error("❌ Invalid news response from EODHD");
      return res.status(500).json({ error: "Failed to fetch news" });
    }

    // Transform EODHD format to match Finnhub format for frontend compatibility
    const transformedNews = r.data.map(article => {
      // Extract publisher from URL if source not provided
      let publisher = article.source || "EODHD";
      if (!article.source && article.link) {
        try {
          const url = new URL(article.link);
          publisher = url.hostname.replace('www.', '');
        } catch (e) {
          publisher = "EODHD";
        }
      }
      
      return {
        headline: article.title,
        summary: article.content || article.title,
        source: publisher,
        url: article.link,
        datetime: new Date(article.date).getTime() / 1000 // Convert to Unix timestamp
      };
    });

    console.log(`✅ Loaded ${transformedNews.length} news articles from EODHD`);

    newsCache = transformedNews;
    newsCacheTime = Date.now();

    res.json(transformedNews);
  } catch (err) {
    console.error("❌ /api/news error:", err.message);
    
    if (err.response) {
      console.error("📍 EODHD Response status:", err.response.status);
      console.error("📍 EODHD Response data:", err.response.data);
    }
    
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

/* ------------------------------------------------------
   STOCK-SPECIFIC NEWS
------------------------------------------------------ */
let stockNewsCache = null;
let stockNewsCacheTime = 0;

app.get("/api/stock-news", async (req, res) => {
  try {
    if (stockNewsCache && Date.now() - stockNewsCacheTime < 5 * 60 * 1000) {
      console.log("✅ Using cached stock news data");
      return res.json(stockNewsCache);
    }

    console.log("📰 Fetching stock-specific news from EODHD...");
    
    // Fetch general financial news (includes stock-related news)
    const r = await http.get(
      `https://eodhd.com/api/news?api_token=${EODHD_KEY}&limit=50&offset=0&fmt=json`
    );

    if (!r.data || !Array.isArray(r.data)) {
      console.error("❌ Invalid stock news response from EODHD");
      return res.status(500).json({ error: "Failed to fetch stock news" });
    }

    // Transform EODHD format to match frontend format
    const transformedNews = r.data.map(article => {
      // Extract publisher from URL if source not provided
      let publisher = article.source || "EODHD";
      if (!article.source && article.link) {
        try {
          const url = new URL(article.link);
          publisher = url.hostname.replace('www.', '');
        } catch (e) {
          publisher = "EODHD";
        }
      }
      
      return {
        headline: article.title,
        summary: article.content || article.title,
        source: publisher,
        url: article.link,
        datetime: new Date(article.date).getTime() / 1000, // Convert to Unix timestamp
        symbols: article.symbols || [] // Include related stock symbols
      };
    });

    console.log(`✅ Loaded ${transformedNews.length} stock news articles from EODHD`);

    stockNewsCache = transformedNews;
    stockNewsCacheTime = Date.now();

    res.json(transformedNews);
  } catch (err) {
    console.error("❌ /api/stock-news error:", err.message);
    
    if (err.response) {
      console.error("📍 EODHD Response status:", err.response.status);
      console.error("📍 EODHD Response data:", err.response.data);
    }
    
    res.status(500).json({ error: "Failed to fetch stock news" });
  }
});

/* ------------------------------------------------------
   INDICES - EODHD for US indices, Yahoo for JSE
------------------------------------------------------ */
app.get("/api/indices", async (req, res) => {
  try {
    // No caching - always return fresh WebSocket data for US indices
    const results = [];

    for (const [name, symbol] of Object.entries(INDEX_SYMBOLS)) {
      try {
        // Yahoo Finance for JSE Top 40
        if (name === "JSE Top 40") {
          const r = await http.get(`${YAHOO_CHART}/${symbol}?interval=1d&range=5d`);
          const data = r.data.chart?.result?.[0];
          
          if (!data || !data.meta || !data.indicators?.quote?.[0]) {
            console.warn(`⚠️ No Yahoo data for ${name}`);
            continue;
          }

          const closes = data.indicators.quote[0].close.filter(c => c !== null);
          if (closes.length < 2) {
            console.warn(`⚠️ Insufficient data for ${name}`);
            continue;
          }

          const currentPrice = closes[closes.length - 1];
          const previousClose = closes[closes.length - 2];
          const changePercent = ((currentPrice - previousClose) / previousClose) * 100;

          results.push({
            name,
            symbol,
            change: `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`,
            latest: currentPrice.toFixed(2),
            rawChange: changePercent
          });

          console.log(`✅ ${name} (Yahoo): ${currentPrice.toFixed(2)} (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%)`);
        } else {
          // Use EODHD REST API for US indices
          const url = `https://eodhd.com/api/real-time/${symbol}?api_token=${EODHD_KEY}&fmt=json`;
          const r = await http.get(url);
          const data = r.data;

          if (!data || !data.close || !data.previousClose) {
            console.warn(`⚠️ No EODHD data for ${name}`);
            continue;
          }

          const currentPrice = parseFloat(data.close);
          const previousClose = parseFloat(data.previousClose);
          const changePercent = parseFloat(data.change_p);

          if (isNaN(currentPrice) || isNaN(changePercent)) {
            console.warn(`⚠️ Invalid data for ${name}`);
            continue;
          }

          results.push({
            name,
            symbol,
            change: `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`,
            latest: currentPrice.toFixed(2),
            rawChange: changePercent
          });

          console.log(`✅ ${name} (EODHD): ${currentPrice.toFixed(2)} (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%)`);
        }

      } catch (err) {
        console.warn(`⚠️ Index error ${name}:`, err.message);
      }

      await sleep(200);
    }

    res.json(results);

    console.log(`✅ Loaded ${results.length} indices (EODHD + Yahoo)`);

  } catch (err) {
    console.error("❌ /api/indices error:", err.message);
    res.status(500).json({ error: "Failed to fetch indices" });
  }
});

/* ------------------------------------------------------
   FOREX - EODHD WebSocket + REST API fallback
------------------------------------------------------ */
app.get("/api/forex", async (req, res) => {
  try {
    // No caching - always return fresh WebSocket data
    const results = [];

    for (const [pair, symbol] of Object.entries(EODHD_FOREX_SYMBOLS)) {
      try {
        // Try WebSocket data first (real-time)
        const wsSymbol = symbol.replace('.FOREX', ''); // Convert EURUSD.FOREX to EURUSD
        const wsData = wsForexData[wsSymbol];
        
        if (wsData && wsData.price && wsData.changePercent !== undefined) {
          // WebSocket data is fresh (within 60 seconds)
          if (Date.now() - wsData.timestamp < 60 * 1000) {
            results.push({
              pair,
              name: pair,
              change: `${wsData.changePercent >= 0 ? "+" : ""}${wsData.changePercent.toFixed(2)}%`,
              trend: wsData.changePercent >= 0 ? "positive" : "negative",
              price: wsData.price,
              rawChange: wsData.changePercent
            });

            console.log(`✅ ${pair} (WebSocket): ${wsData.price.toFixed(4)} (${wsData.changePercent >= 0 ? "+" : ""}${wsData.changePercent.toFixed(2)}%)`);
            continue;
          }
        }

        // Fallback to REST API
        const url = `https://eodhd.com/api/real-time/${symbol}?api_token=${EODHD_KEY}&fmt=json`;
        const r = await http.get(url);
        const data = r.data;

        if (!data || !data.close || !data.previousClose) {
          console.warn(`⚠️ No EODHD data for ${pair}`);
          continue;
        }

        const currentPrice = parseFloat(data.close);
        const previousClose = parseFloat(data.previousClose);
        const changePercent = parseFloat(data.change_p);

        if (isNaN(currentPrice) || isNaN(changePercent)) {
          console.warn(`⚠️ Invalid data for ${pair}`);
          continue;
        }

        // Store previous close for WebSocket accuracy
        const wsSymbolRest = symbol.replace(".FOREX", "");
        if (!isNaN(previousClose)) {
          forexPrevClose[wsSymbolRest] = previousClose;
        }

        results.push({
          pair,
          name: pair,
          change: `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`,
          trend: changePercent >= 0 ? "positive" : "negative",
          price: currentPrice,
          rawChange: changePercent
        });

        console.log(`✅ ${pair} (EODHD): ${currentPrice.toFixed(4)} (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%)`);

      } catch (err) {
        console.warn(`⚠️ EODHD FX error for ${symbol}:`, err.message);
      }

      await sleep(100);
    }

    res.json(results);

    console.log(`✅ Loaded ${results.length} forex pairs (WebSocket + EODHD)`);

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
/* ------------------------------------------------------
   COMMODITIES - Yahoo Only (Consistent Pricing) ✅
------------------------------------------------------ */
app.get("/api/commodities", async (req, res) => {
  try {
    // Cache for 5 minutes
    const COMMODITIES_CACHE_TTL = 5 * 60 * 1000;
    
    if (commoditiesCache && Date.now() - commoditiesCacheTime < COMMODITIES_CACHE_TTL)
      return res.json(commoditiesCache);

    const results = [];

    const COMMODITY_SYMBOLS = {
      "Gold": "GC=F",
      "Silver": "SI=F",
      "Platinum": "PL=F",
      "Crude Oil": "CL=F"
    };

    for (const [name, symbol] of Object.entries(COMMODITY_SYMBOLS)) {
      try {
        const yahooUrl = `${YAHOO_CHART}/${symbol}?interval=1d&range=5d`;
        const yahooResp = await http.get(yahooUrl);
        const yahooData = yahooResp.data.chart?.result?.[0];

        if (!yahooData || !yahooData.indicators?.quote?.[0]?.close) {
          console.warn(`⚠️ No Yahoo data for ${name}`);
          continue;
        }

        const closes = yahooData.indicators.quote[0].close.filter(n => typeof n === "number");

        if (closes.length < 2) {
          console.warn(`⚠️ Insufficient data for ${name}: only ${closes.length} prices`);
          continue;
        }

        // Get current price (most recent) and yesterday's close (previous)
        const currentPrice = closes.at(-1);
        const yesterdayClose = closes.at(-2);

        if (isNaN(currentPrice) || isNaN(yesterdayClose) || yesterdayClose === 0) {
          console.warn(`⚠️ Invalid prices for ${name}`);
          continue;
        }

        // Calculate percentage change
        const difference = currentPrice - yesterdayClose;
        const changePercent = (difference / yesterdayClose) * 100;

        if (isNaN(changePercent)) {
          console.warn(`⚠️ Calculated NaN for ${name}`);
          continue;
        }

        results.push({
          name,
          symbol: name,
          change: `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`,
          trend: changePercent >= 0 ? "positive" : "negative",
          price: currentPrice.toFixed(2),
          rawChange: changePercent
        });

        console.log(`✅ ${name}: $${currentPrice.toFixed(2)} vs $${yesterdayClose.toFixed(2)} = ${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`);

      } catch (err) {
        console.warn(`⚠️ ${name} fetch error:`, err.message);
      }

      await sleep(200);
    }

    results.sort((a, b) => Math.abs(b.rawChange) - Math.abs(a.rawChange));

    commoditiesCache = results;
    commoditiesCacheTime = Date.now();
    res.json(results);

    console.log(`✅ Loaded ${results.length} commodities (Yahoo, cached 5min)`);

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
   CORRELATION MATRIX 
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
      "Nvidia": "NVDA.US",
      "Visa": "V.US",
      "JPMorgan Chase": "JPM.US",
      "Mastercard": "MA.US",
      "Bank of America": "BAC.US",
      "UnitedHealth Group": "UNH.US",
      "Johnson & Johnson": "JNJ.US",
      "Eli Lilly": "LLY.US",
      "Merck & Co": "MRK.US",
      "Pfizer": "PFE.US",
      "Procter & Gamble": "PG.US",
      "Coca-Cola": "KO.US",
      "PepsiCo": "PEP.US",
      "Walmart": "WMT.US",
      "Costco": "COST.US",
      "Home Depot": "HD.US",
      "McDonald's": "MCD.US",
      "Amazon": "AMZN.US",
      "Tesla": "TSLA.US",
      "Exxon Mobil": "XOM.US",
      "Chevron": "CVX.US",
      "ConocoPhillips": "COP.US",
      "Comcast": "CMCSA.US",
      "Walt Disney": "DIS.US",
      "Meta Platforms": "META.US",
      "Alphabet (Google)": "GOOGL.US",
      "AT&T": "T.US",
      "Verizon": "VZ.US",
      "Berkshire Hathaway": "BRK.B.US",
      "Abbott Laboratories": "ABT.US",
      "Honeywell Intl": "HON.US",
      "Union Pacific": "UNP.US",
      "3M Company": "MMM.US",
      "NextEra Energy": "NEE.US",
      "Duke Energy": "DUK.US",
      "American Tower": "AMT.US",
      "Crown Castle": "CCI.US",
      "Newmont Corporation": "NEM.US"
    };

    const results = [];

    for (const [name, symbol] of Object.entries(US_SYMBOLS)) {
      try {
        // Try WebSocket data first (real-time)
        const wsData = wsStocksData[symbol];
        
        if (wsData && wsData.price && wsData.changePercent !== undefined) {
          // WebSocket data is fresh (within 60 seconds)
          if (Date.now() - wsData.timestamp < 60 * 1000) {
            results.push({
              name,
              symbol,
              price: `$${wsData.price.toFixed(2)}`,
              change: `${wsData.changePercent >= 0 ? "+" : ""}${wsData.changePercent.toFixed(2)}%`,
              trend: wsData.changePercent >= 0 ? "positive" : "negative",
              rawChange: wsData.changePercent,
              currency: "USD"
            });

            console.log(`✅ US ${name} (WebSocket): ${wsData.price.toFixed(2)} (${wsData.changePercent >= 0 ? "+" : ""}${wsData.changePercent.toFixed(2)}%)`);
            continue;
          }
        }

        // Fallback to REST API
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

        console.log(`✅ US ${name}: ${currentPrice.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`);

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



// ------------------------------------------------------
// SA MARKET NEWS - BusinessTech RSS Feed
// ------------------------------------------------------
const xml2js = require('xml2js');

app.get("/api/sa-news", async (req, res) => {
  try {
    // Use cached news if available (5 min cache)
    if (newsCache && Date.now() - newsCacheTime < 5 * 60 * 1000) {
      return res.json(newsCache);
    }

    // Fetch and parse BusinessTech RSS feed
    const rssUrl = "https://businesstech.co.za/news/feed/";
    const r = await axios.get(rssUrl);
    const xml = r.data;
    const parser = new xml2js.Parser({ explicitArray: false });
    const feed = await parser.parseStringPromise(xml);
    const items = feed.rss && feed.rss.channel && feed.rss.channel.item ? feed.rss.channel.item : [];

    // Transform RSS items to match frontend expectations
    const transformedNews = (Array.isArray(items) ? items : [items]).map(item => {
      // Defensive checks for missing fields
      const headline = item.title || "Untitled";
      const summary = item.description || headline;
      const url = item.link || "https://businesstech.co.za/news/";
      const source = "BusinessTech";
      let datetime;
      if (item.pubDate) {
        const parsedDate = new Date(item.pubDate);
        datetime = isNaN(parsedDate.getTime()) ? Math.floor(Date.now() / 1000) : Math.floor(parsedDate.getTime() / 1000);
      } else {
        datetime = Math.floor(Date.now() / 1000);
      }
      // Log if any field is missing or malformed
      if (!item.title || !item.link || !item.pubDate) {
        console.warn("⚠️ RSS item missing fields:", { headline, url, pubDate: item.pubDate });
      }
      return {
        headline,
        summary,
        source,
        url,
        datetime,
        symbols: []
      };
    });

    // Save to cache
    newsCache = transformedNews;
    newsCacheTime = Date.now();

    res.json(transformedNews);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch SA news", details: err.message });
  }
});

function isSouthAfricanNews(article) {
  // Expanded keywords, JSE tickers, and local news domains
  const keywords = [
    // General
    'south africa', 'south african', 'johannesburg', 'cape town', 'durban', 'pretoria', 'gauteng', 'kwazulu-natal', 'eastern cape', 'western cape', 'limpopo', 'mpumalanga', 'free state', 'north west', 'northern cape',
    // Economy & finance
    'rand', 'zar', 'sarb', 'reserve bank', 'minister of finance', 'treasury', 'budget speech', 'eskom', 'load shedding', 'transnet', 'pravin gordhan', 'tito mboweni', 'enoch godongwana', 'anc', 'parliament', 'cabinet',
    // Major companies
    'jse', 'naspers', 'capitec', 'absa', 'standard bank', 'old mutual', 'sanlam', 'shoprite', 'woolworths', 'pick n pay', 'anglo', 'anglogold', 'anglo american', 'sibanye', 'impala', 'mtbps', 'eoh', 'dis-chem', 'astral', 'remgro', 'psg', 'sun international', 'mtn', 'vodacom', 'telkom', 'sasol', 'bidvest', 'bidcorp', 'fnb', 'nedbank', 'firstrand', 'investec', 'growthpoint', 'redefine', 'multichoice', 'african rainbow', 'motus', 'truworths', 'mr price', 'clicks', 'spar', 'tiger brands', 'brait', 'famous brands', 'liberty', 'coronation', 'fortress', 'attacq', 'exxaro', 'northam', 'gold fields', 'harmony', 'arm', 'drdgold', 'pan african', 'sephaku', 'adcorp', 'curro', 'spur', 'distell', 'astral foods', 'pioneer foods', 'omnias', 'hulamin', 'bell equipment', 'mustek', 'altron', 'datatec', 'adapt it', 'argent', 'barloworld', 'bell', 'cashbuild', 'city lodge', 'clientele', 'combined motor', 'csg', 'digicore', 'elb', 'emira', 'eoh', 'eqstra', 'erb', 'finbond', 'grindrod', 'hudaco', 'huhtamaki', 'invicta', 'kumba', 'lewis', 'litha', 'mara', 'metair', 'murray & roberts', 'octodec', 'omnias', 'pinnacle', 'primeserv', 'raubex', 'rebosis', 'resilient', 'santam', 'sephaku', 'sibanye', 'stefanutti', 'stor-age', 'super group', 'texton', 'tongaat', 'vukile', 'zeder',
    // Sectors
    'mining', 'platinum', 'gold', 'palladium', 'chrome', 'coal', 'iron ore', 'retail', 'banking', 'insurance', 'property', 'telecom', 'energy', 'transport', 'logistics', 'construction', 'manufacturing',
    // JSE indices
    'j200', 'j203', 'j210', 'j580', 'j330', 'j430', 'j250', 'j257', 'j254', 'j673', 'j677', 'j790', 'j400', 'j430', 'j450', 'j590', 'j803', 'j805', 'j820', 'j827', 'j830', 'j835', 'j840', 'j853', 'j857', 'j858', 'j860', 'j863', 'j867', 'j868', 'j870', 'j875', 'j880', 'j890', 'j900', 'j910', 'j915', 'j920', 'j925', 'j930', 'j935', 'j940', 'j945', 'j950', 'j955', 'j960', 'j965', 'j970', 'j975', 'j980', 'j985', 'j990', 'j995', 'j998', 'j999'
  ];
  // Common JSE tickers (add more as needed)
  const jseTickers = [
    'AGL.JO', 'AMS.JO', 'ANG.JO', 'APN.JO', 'BID.JO', 'BVT.JO', 'CFR.JO', 'CLS.JO', 'DSY.JO', 'EXX.JO', 'FSR.JO', 'GFI.JO', 'GLN.JO', 'IMP.JO', 'INL.JO', 'INP.JO', 'MNP.JO', 'MTN.JO', 'NED.JO', 'NPN.JO', 'NRP.JO', 'OMU.JO', 'PRX.JO', 'REM.JO', 'SBK.JO', 'SLM.JO', 'SOL.JO', 'SSW.JO', 'VOD.JO', 'WHL.JO', 'JSE.JO', 'SHP.JO', 'TKG.JO', 'CPI.JO', 'DSY.JO', 'FSR.JO', 'GRT.JO', 'NED.JO', 'RDF.JO', 'SNT.JO', 'TBS.JO', 'TRU.JO', 'MND.JO', 'MNP.JO', 'BVT.JO', 'BID.JO', 'BTI.JO', 'ANG.JO', 'SOL.JO', 'MTN.JO', 'NPN.JO', 'ABG.JO', 'SBK.JO', 'FSR.JO', 'CPI.JO', 'DSY.JO', 'SLM.JO', 'OMU.JO', 'REM.JO', 'APN.JO', 'PRX.JO', 'VOD.JO', 'WHL.JO', 'SHP.JO', 'TKG.JO', 'GFI.JO', 'IMP.JO', 'AMS.JO', 'SSW.JO', 'EXX.JO', 'GLN.JO', 'ANG.JO', 'ARM.JO', 'DRD.JO', 'PAN.JO', 'HAR.JO', 'RBP.JO', 'THA.JO', 'S32.JO', 'KIO.JO', 'BHG.JO', 'MCG.JO', 'MTH.JO', 'RCL.JO', 'AVI.JO', 'PPC.JO', 'SNT.JO', 'TBS.JO', 'TRU.JO', 'MND.JO', 'MNP.JO', 'BVT.JO', 'BID.JO', 'BTI.JO'
  ];
  // Local news domains
  const saDomains = [
    'fin24', 'moneyweb', 'businesslive', 'businessday', 'sundaytimes', 'news24', 'iol.co.za', 'sowetanlive', 'citizen.co.za', 'enca.com', 'ecr.co.za', '702.co.za', 'ewn.co.za', 'businesstech', 'dailymaverick', 'mailandguardian', 'sabcnews', 'sabc.co.za', 'sagoodnews', 'sagoodnews.co.za', 'sagoodnews.com', 'sagoodnews.org', 'sagoodnews.net', 'sagoodnews.info', 'sagoodnews.biz', 'sagoodnews.tv', 'sagoodnews.fm', 'sagoodnews.mobi', 'sagoodnews.app', 'sagoodnews.africa', 'sagoodnews.ltd', 'sagoodnews.group', 'sagoodnews.agency', 'sagoodnews.media', 'sagoodnews.press', 'sagoodnews.news', 'sagoodnews.today', 'sagoodnews.world', 'sagoodnews.global', 'sagoodnews.africa', 'sagoodnews.co.za', 'sagoodnews.com', 'sagoodnews.org', 'sagoodnews.net', 'sagoodnews.info', 'sagoodnews.biz', 'sagoodnews.tv', 'sagoodnews.fm', 'sagoodnews.mobi', 'sagoodnews.app', 'sagoodnews.africa', 'sagoodnews.ltd', 'sagoodnews.group', 'sagoodnews.agency', 'sagoodnews.media', 'sagoodnews.press', 'sagoodnews.news', 'sagoodnews.today', 'sagoodnews.world', 'sagoodnews.global', 'businesstech.co.za', 'mybroadband.co.za', 'sagoodnews.co.za', 'sagoodnews.com', 'sagoodnews.org', 'sagoodnews.net', 'sagoodnews.info', 'sagoodnews.biz', 'sagoodnews.tv', 'sagoodnews.fm', 'sagoodnews.mobi', 'sagoodnews.app', 'sagoodnews.africa', 'sagoodnews.ltd', 'sagoodnews.group', 'sagoodnews.agency', 'sagoodnews.media', 'sagoodnews.press', 'sagoodnews.news', 'sagoodnews.today', 'sagoodnews.world', 'sagoodnews.global'
  ];
  const text = `${article.headline} ${article.summary}`.toLowerCase();
  const hasKeyword = keywords.some(k => text.includes(k));
  const hasJseSymbol = Array.isArray(article.symbols) && (
    article.symbols.some(s => s.endsWith('.JO')) ||
    article.symbols.some(s => jseTickers.includes(s))
  );
  let hasSADomain = false;
  if (article.source) {
    const src = article.source.toLowerCase();
    hasSADomain = saDomains.some(domain => src.includes(domain));
  }
  if (article.url) {
    try {
      const url = new URL(article.url);
      hasSADomain = hasSADomain || saDomains.some(domain => url.hostname.toLowerCase().includes(domain));
    } catch {}
  }
  return hasKeyword || hasJseSymbol || hasSADomain;
}


/* ------------------------------------------------------
   JSE STOCKS FROM IRESS.CO.ZA
------------------------------------------------------ */
app.get("/api/jse-stocks", async (req, res) => {
  try {
    // Check cache first (15-minute cache matches iress update frequency)
    const now = Date.now();
    if (jseCache && (now - jseCacheTime < JSE_CACHE_TTL)) {
      console.log("✅ Returning cached JSE data");
      return res.json(jseCache);
    }

    if (!IRESS_JWT_TOKEN) {
      return res.status(500).json({ 
        error: "iress.co.za JWT token not configured" 
      });
    }

    console.log("🔄 Fetching fresh JSE data from iress.co.za...");

    // Fetch from iress.co.za API (token in URL)
    const response = await axios.get(
      `https://df.marketdata.feeds.iress.com/feed/2838/?token=${IRESS_JWT_TOKEN}`
    );

    // Extract and process the snapshot data
    const jseData = response.data;
    
    if (!jseData || !jseData.Snapshot) {
      throw new Error("Invalid response format from iress.co.za");
    }

    // Process and enrich the data
    const processedData = {
      timestamp: new Date().toISOString(),
      count: jseData.Snapshot.length,
      stocks: jseData.Snapshot.map(stock => ({
        name: stock.SecurityName,
        ticker: stock.Ticker,
        exchange: stock.Exchange,
        price: stock.LastPrice,
        previousClose: stock.YesterdayClose,
        open: stock.Open,
        bid: stock.Bid,
        ask: stock.Ask,
        change: stock.LastPrice - stock.YesterdayClose,
        changePercent: stock.YesterdayClose > 0 
          ? ((stock.LastPrice - stock.YesterdayClose) / stock.YesterdayClose * 100).toFixed(2)
          : 0
      }))
    };

    // Cache the processed data
    jseCache = processedData;
    jseCacheTime = now;

    console.log(`✅ JSE data cached: ${processedData.count} securities`);
    res.json(processedData);

  } catch (error) {
    console.error("❌ JSE API Error:", error.message);
    
    // If we have cached data, return it even if stale
    if (jseCache) {
      console.log("⚠️ Returning stale cached JSE data due to API error");
      return res.json({ ...jseCache, stale: true });
    }

    res.status(500).json({ 
      error: "Failed to fetch JSE data",
      message: error.message 
    });
  }
});

/* ------------------------------------------------------
   ECONOMIC INDICATORS ENDPOINT
------------------------------------------------------ */
app.get("/api/economic-indicators", async (req, res) => {
  const now = Date.now();

  // Check cache (30-day TTL)
  if (economicIndicatorsCache && (now - economicIndicatorsCacheTime < ECONOMIC_INDICATORS_TTL)) {
    console.log("✅ Returning cached economic indicators");
    return res.json(economicIndicatorsCache);
  }

  try {
    console.log("📊 Fetching economic indicators from EODHD...");

    // Country codes and currency mapping
    const countries = [
      { currency: 'USD', code: 'USA', name: 'United States' },
      { currency: 'EUR', code: 'DEU', name: 'Germany' }, // Using Germany as Eurozone proxy
      { currency: 'GBP', code: 'GBR', name: 'United Kingdom' },
      { currency: 'JPY', code: 'JPN', name: 'Japan' },
      { currency: 'AUD', code: 'AUS', name: 'Australia' },
      { currency: 'CAD', code: 'CAN', name: 'Canada' },
      { currency: 'CHF', code: 'CHE', name: 'Switzerland' },
      { currency: 'NZD', code: 'NZL', name: 'New Zealand' },
      { currency: 'ZAR', code: 'ZAF', name: 'South Africa' }
    ];

    // Manual override for most current data (update monthly after releases)
    const manualOverrides = {
      USD: { 
        inflation: { value: 2.7, date: '2026-01-13' }, // Latest US CPI (Jan 13, 2026 release)
        unemployment: { value: 4.0, date: '2026-01-31' },
        gdp: { value: 2.8, date: '2025-Q4' }
      },
      EUR: {
        inflation: { value: 2.4, date: '2026-01-31' },
        unemployment: { value: 6.4, date: '2025-12-31' },
        gdp: { value: 0.9, date: '2025-Q4' }
      },
      GBP: {
        inflation: { value: 2.5, date: '2025-12-31' },
        unemployment: { value: 4.2, date: '2025-12-31' },
        gdp: { value: 1.1, date: '2025-Q4' }
      },
      JPY: {
        inflation: { value: 3.6, date: '2025-12-31' },
        unemployment: { value: 2.4, date: '2025-12-31' },
        gdp: { value: 1.2, date: '2025-Q4' }
      },
      AUD: {
        inflation: { value: 3.2, date: '2025-12-31' },
        unemployment: { value: 4.0, date: '2025-12-31' },
        gdp: { value: 1.8, date: '2025-Q4' }
      },
      CAD: {
        inflation: { value: 1.8, date: '2025-12-31' },
        unemployment: { value: 6.7, date: '2025-12-31' },
        gdp: { value: 1.3, date: '2025-Q4' }
      },
      CHF: {
        inflation: { value: 0.7, date: '2025-12-31' },
        unemployment: { value: 2.3, date: '2025-12-31' },
        gdp: { value: 1.4, date: '2025-Q4' }
      },
      NZD: {
        inflation: { value: 2.2, date: '2025-12-31' },
        unemployment: { value: 4.8, date: '2025-12-31' },
        gdp: { value: 0.5, date: '2025-Q4' }
      },
      ZAR: {
        inflation: { value: 3.8, date: '2026-01-31' },
        unemployment: { value: 32.1, date: '2025-Q3' },
        gdp: { value: 1.2, date: '2025-Q4' }
      }
    };

    const indicatorsData = {};

    // Use manual overrides as primary source (EODHD macro data is 1-2 years behind)
    for (const country of countries) {
      if (manualOverrides[country.currency]) {
        indicatorsData[country.currency] = manualOverrides[country.currency];
        console.log(`✅ Using manual data for ${country.currency}:`, 
          `Inflation: ${indicatorsData[country.currency].inflation.value}% (${indicatorsData[country.currency].inflation.date})`,
          `Unemployment: ${indicatorsData[country.currency].unemployment.value}%`,
          `GDP: ${indicatorsData[country.currency].gdp.value}%`
        );
      } else {
        indicatorsData[country.currency] = {
          inflation: { value: null, date: null },
          unemployment: { value: null, date: null },
          gdp: { value: null, date: null }
        };
      }
    }

    /* 
    // EODHD API is too slow (1-2 years behind) - disabled
    // Keeping this code commented in case they update their data pipeline in the future
    // Fetch data from EODHD for each country
    for (const country of countries) {
      try {
        // Fetch macro indicators from EODHD using their macro-indicator endpoint
        const [inflationRes, unemploymentRes, gdpRes] = await Promise.all([
          axios.get(`https://eodhd.com/api/macro-indicator/${country.code}`, {
            params: {
              api_token: EODHD_KEY,
              indicator: 'inflation_consumer_prices_annual',
              fmt: 'json'
            },
            timeout: 10000
          }).catch(e => null),
          axios.get(`https://eodhd.com/api/macro-indicator/${country.code}`, {
            params: {
              api_token: EODHD_KEY,
              indicator: 'unemployment_rate',
              fmt: 'json'
            },
            timeout: 10000
          }).catch(e => null),
          axios.get(`https://eodhd.com/api/macro-indicator/${country.code}`, {
            params: {
              api_token: EODHD_KEY,
              indicator: 'gdp_growth_annual',
              fmt: 'json'
            },
            timeout: 10000
          }).catch(e => null)
        ]);

        // Extract latest values from each response
        const getLatestFromResponse = (response) => {
          if (response && response.data && Array.isArray(response.data) && response.data.length > 0) {
            // The data comes as an array with the most recent at the end
            for (let i = response.data.length - 1; i >= 0; i--) {
              if (response.data[i].Value !== null && response.data[i].Value !== undefined) {
                return {
                  value: parseFloat(response.data[i].Value),
                  date: response.data[i].Date
                };
              }
            }
          }
          return null;
        };

        const inflationData = getLatestFromResponse(inflationRes);
        const unemploymentData = getLatestFromResponse(unemploymentRes);
        const gdpData = getLatestFromResponse(gdpRes);

        // Use EODHD data if available, otherwise fallback to manual overrides
        indicatorsData[country.currency] = {
          inflation: inflationData || (manualOverrides[country.currency]?.inflation) || { value: null, date: null },
          unemployment: unemploymentData || (manualOverrides[country.currency]?.unemployment) || { value: null, date: null },
          gdp: gdpData || (manualOverrides[country.currency]?.gdp) || { value: null, date: null }
        };

        console.log(`✅ Fetched ${country.currency} from EODHD:`,
          `Inflation: ${indicatorsData[country.currency].inflation.value}% (${inflationData ? 'API' : 'fallback'})`,
          `Unemployment: ${indicatorsData[country.currency].unemployment.value}% (${unemploymentData ? 'API' : 'fallback'})`,
          `GDP: ${indicatorsData[country.currency].gdp.value}% (${gdpData ? 'API' : 'fallback'})`
        );

      } catch (error) {
        console.error(`❌ Error fetching ${country.currency} indicators from EODHD:`, error.message);
        // Fallback to manual overrides
        indicatorsData[country.currency] = manualOverrides[country.currency] || {
          inflation: { value: null, date: null },
          unemployment: { value: null, date: null },
          gdp: { value: null, date: null }
        };
      }
    }
    */

    const result = {
      timestamp: new Date().toISOString(),
      indicators: indicatorsData
    };

    // Cache the data
    economicIndicatorsCache = result;
    economicIndicatorsCacheTime = now;

    console.log("✅ Economic indicators cached for 30 days");
    res.json(result);

  } catch (error) {
    console.error("❌ Economic Indicators Error:", error.message);
    
    // Return cached data if available
    if (economicIndicatorsCache) {
      console.log("⚠️ Returning stale cached economic indicators");
      return res.json({ ...economicIndicatorsCache, stale: true });
    }

    res.status(500).json({ 
      error: "Failed to fetch economic indicators",
      message: error.message 
    });
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
const server = httpServer.createServer(app);

server.listen(PORT, () => {
  console.log(`🚀 Marome Backend running on port ${PORT}`);
  console.log(`📊 Correlation Matrix API: http://localhost:${PORT}/api/correlation-matrix?period=30`);
  console.log(`🧪 EODHD Test: http://localhost:${PORT}/api/test-eodhd-gold`);
  console.log(`💬 Marome Chat AI: http://localhost:${PORT}/api/chat`);
  console.log(`📡 Initializing EODHD WebSockets...`);
  initEODHDWebSocket();
  initForexWebSocket();
});

/* ------------------------------------------------------
   FRONTEND WEBSOCKET SERVER (PUSH UPDATES)
------------------------------------------------------ */
const wsServer = new WebSocket.Server({ server });

wsServer.on("connection", (socket) => {
  console.log("🔌 Frontend WebSocket client connected");

  socket.on("close", () => {
    console.log("🔌 Frontend WebSocket client disconnected");
  });
});

console.log(`🔌 Frontend WebSocket server running on ws://localhost:${PORT}`);

function broadcastForexUpdate(payload) {
  const message = JSON.stringify({ type: "forex", ...payload });
  wsServer.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastUSStockUpdate(payload) {
  const message = JSON.stringify({ type: "us-stock", ...payload });
  wsServer.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

/* ------------------------------------------------------
   EODHD WEBSOCKET FOR REAL-TIME US INDICES & STOCKS
------------------------------------------------------ */
function initEODHDWebSocket() {
  const wsUrl = `wss://ws.eodhistoricaldata.com/ws/us?api_token=${EODHD_KEY}`;
  let ws = null;
  let reconnectInterval = 5000;
  let pingInterval = null;

  function connect() {
    console.log("📡 Connecting to EODHD WebSocket...");
    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      console.log("✅ EODHD WebSocket connected");
      
      // Subscribe to US indices and stocks
      const subscribeMsg = {
        action: "subscribe",
        symbols: "GSPC.INDX,NDX.INDX,DJI.INDX,AAPL.US,MSFT.US,AMZN.US,GOOGL.US,TSLA.US,NVDA.US,META.US,JPM.US,V.US,KO.US,JNJ.US,WMT.US,MA.US,PFE.US,NFLX.US"
      };
      ws.send(JSON.stringify(subscribeMsg));
      console.log("📊 Subscribed to: 3 indices + 15 US stocks");

      // Send ping every 30 seconds to keep connection alive
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 30000);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // Ignore non-price messages (auth confirmations, heartbeats, etc.)
        if (!msg.s || msg.p == null) return;
        
        const payload = {
          symbol: msg.s,
          price: msg.p,
          change: msg.c,
          changePercent: msg.cp,
          timestamp: Date.now()
        };
        
        // Store real-time data for indices
        if (wsIndicesData.hasOwnProperty(msg.s)) {
          wsIndicesData[msg.s] = payload;
          console.log(`📈 INDEX ${msg.s}: ${msg.p} (${msg.cp >= 0 ? "+" : ""}${msg.cp}%)`);
        }
        
        // Store real-time data for US stocks
        if (wsStocksData.hasOwnProperty(msg.s)) {
          wsStocksData[msg.s] = payload;
          console.log(`📈 STOCK ${msg.s}: ${msg.p} (${msg.cp >= 0 ? "+" : ""}${msg.cp}%)`);
          broadcastUSStockUpdate({
            symbol: msg.s,
            price: msg.p,
            changePercent: msg.cp,
            timestamp: Date.now()
          });
        }
      } catch (err) {
        console.error("❌ WebSocket message parse error:", err.message);
      }
    });

    ws.on("error", (err) => {
      console.error("❌ EODHD WebSocket error:", err.message);
    });

    ws.on("close", () => {
      console.log("⚠️ EODHD WebSocket closed, reconnecting...");
      clearInterval(pingInterval);
      setTimeout(connect, reconnectInterval);
    });

    ws.on("pong", () => {
      // Connection is alive
    });
  }

  connect();
}

/* ------------------------------------------------------
   FOREX WEBSOCKET FOR REAL-TIME CURRENCY PAIRS
------------------------------------------------------ */
function initForexWebSocket() {
  const wsUrl = `wss://ws.eodhistoricaldata.com/ws/forex?api_token=${EODHD_KEY}`;
  let ws = null;
  let reconnectInterval = 5000;
  let pingInterval = null;
  let prevCloseInterval = null;

  function connect() {
    console.log("📡 Connecting to EODHD Forex WebSocket...");
    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      console.log("✅ EODHD Forex WebSocket connected");
      
      // Subscribe to 8 forex pairs (WebSocket uses plain format without .FOREX suffix)
      const subscribeMsg = {
        action: "subscribe",
        symbols: "EURUSD,GBPUSD,USDJPY,USDZAR,EURZAR,GBPZAR,AUDUSD,USDCHF"
      };
      ws.send(JSON.stringify(subscribeMsg));
      console.log("💱 Subscribed to: 8 forex pairs");

      // Prime previousClose values and refresh periodically
      refreshForexPrevClose();
      prevCloseInterval = setInterval(() => {
        refreshForexPrevClose();
      }, 5 * 60 * 1000);

      // Send ping every 30 seconds to keep connection alive
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 30000);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // Forex uses different fields: a=ask, b=bid, dc=change%, dd=change
        if (!msg.s || (msg.a == null && msg.b == null)) return;
        
        // Use mid price (average of bid and ask)
        const price = msg.a && msg.b ? (msg.a + msg.b) / 2 : (msg.a || msg.b);
        const wsSymbol = msg.s;
        const prevClose = forexPrevClose[wsSymbol];
        const change = Number.isFinite(prevClose) ? (price - prevClose) : (parseFloat(msg.dd) || 0);
        const isZarCross = wsSymbol.endsWith("ZAR");
        const restPercent = forexRestChangePercent[wsSymbol];
        const changePercent = isZarCross && Number.isFinite(restPercent)
          ? restPercent
          : (Number.isFinite(prevClose) && prevClose !== 0
              ? (change / prevClose) * 100
              : (parseFloat(msg.dc) || 0));
        
        const payload = {
          symbol: msg.s + ".FOREX", // Add .FOREX suffix to match REST API format
          price: price,
          change: change,
          changePercent: changePercent,
          timestamp: Date.now()
        };
        
        // Store real-time data for forex pairs
        if (wsForexData.hasOwnProperty(msg.s)) {
          wsForexData[msg.s] = payload;
          console.log(`💱 FOREX ${msg.s}: ${price.toFixed(4)} (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%)`);
          broadcastForexUpdate({
            symbol: msg.s,
            pair: FOREX_SYMBOL_TO_PAIR[msg.s],
            price: price,
            change: change,
            changePercent: changePercent,
            timestamp: Date.now()
          });
        }
      } catch (err) {
        console.error("❌ Forex WebSocket message parse error:", err.message);
      }
    });

    ws.on("error", (err) => {
      console.error("❌ EODHD Forex WebSocket error:", err.message);
    });

    ws.on("close", () => {
      console.log("⚠️ EODHD Forex WebSocket closed, reconnecting...");
      clearInterval(pingInterval);
      clearInterval(prevCloseInterval);
      setTimeout(connect, reconnectInterval);
    });

    ws.on("pong", () => {
      // Connection is alive
    });
  }

  connect();
}
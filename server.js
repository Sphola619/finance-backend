require("dotenv").config();
const express = require("express");
const httpServer = require("http");
const cors = require("cors");
const axios = require("axios");
const WebSocket = require("ws");
const path = require("path");

// WebSocket cache for EODHD real-time commodities (spot metals)
const wsCommodityData = {
  XAUUSD: null,
  XAGUSD: null,
  XPTUSD: null
};

const wsCryptoData = {
  "BTC-USD": null,
  "ETH-USD": null,
  "XRP-USD": null,
  "SOL-USD": null,
  "ADA-USD": null,
  "DOGE-USD": null,
  "AVAX-USD": null,
  "BNB-USD": null,
  "LTC-USD": null
};

// Flag to indicate if WS is active for commodities
let commoditiesWsActive = false;

// Broadcast commodity update to all WS clients (top-level, not inside any function)
function broadcastCommodityUpdate(payload) {
  const message = JSON.stringify({ type: "commodity", ...payload });
  wsServer.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

const app = express();



/* ------------------------------------------------------
   CORS CONFIGURATION FOR DEVELOPMENT
------------------------------------------------------ */
app.use(cors({
  origin: true, // Allow all origins in development
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control']
}));

app.use(express.json());

// Serve static files from Frontend directory
app.use(express.static(path.join(__dirname, '../Frontend')));

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
  "WMT.US": null
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
  "USDCHF": null,
  "XAUUSD": null, // Gold spot
  "XAGUSD": null, // Silver spot
  "XPTUSD": null  // Platinum spot
};

const forexPrevClose = {};
const forexRestChangePercent = {};
const forexRestClose = {};
const cryptoPrevClose = {};
const cryptoRestChangePercent = {};
let forexCache = null;
let forexCacheTime = 0;
let heatmapCache = null;
let heatmapCacheTime = 0;
let cryptoCache = null;
let cryptoCacheTime = 0;
const cryptoPrevPrice = {};
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
  "USD/CHF",
  "XAU/USD", // Gold spot
  "XAG/USD", // Silver spot
  "XPT/USD"  // Platinum spot
];

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
  "USD/CHF": "USDCHF.FOREX",
  "XAU/USD": "XAUUSD.FOREX", // Gold spot
  "XAG/USD": "XAGUSD.FOREX", // Silver spot
  "XPT/USD": "XPTUSD.FOREX"  // Platinum spot
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
      const r = await api.get(url);
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

async function refreshCryptoPrevClose() {
  const cryptoSymbols = {
    "BTC-USD": "BTC-USD.CC",
    "ETH-USD": "ETH-USD.CC",
    "XRP-USD": "XRP-USD.CC",
    "SOL-USD": "SOL-USD.CC",
    "ADA-USD": "ADA-USD.CC",
    "DOGE-USD": "DOGE-USD.CC",
    "AVAX-USD": "AVAX-USD.CC",
    "BNB-USD": "BNB-USD.CC",
    "LTC-USD": "LTC-USD.CC"
  };

  for (const [wsSymbol, apiSymbol] of Object.entries(cryptoSymbols)) {
    try {
      const url = `https://eodhd.com/api/real-time/${apiSymbol}?api_token=${EODHD_KEY}&fmt=json`;
      const r = await api.get(url);
      const previousClose = parseFloat(r.data?.previousClose);
      const changePercent = parseFloat(r.data?.change_p);
      const close = parseFloat(r.data?.close);
      if (!isNaN(previousClose)) {
        cryptoPrevClose[wsSymbol] = previousClose;
      }
      if (!isNaN(changePercent)) {
        cryptoRestChangePercent[wsSymbol] = changePercent;
      }
    } catch (err) {
      console.warn(`⚠️ Crypto prev close fetch error for ${apiSymbol}:`, err.message);
    }

    await sleep(100);
  }
}

const YAHOO_COMMODITY_SYMBOLS = {
  "Gold": "GC=F",
  "Silver": "SI=F", 
  "Platinum": "PL=F",
  "Crude Oil": "CL=F"
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
const api = axios.create({
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
    
    const r = await api.get(
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
    const r = await api.get(
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
          const r = await api.get(`${YAHOO_CHART}/${symbol}?interval=1d&range=5d`);
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
          const r = await api.get(url);
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

    // 🚀 OPTIMIZATION: Process all pairs in parallel instead of sequential
    const pairPromises = Object.entries(EODHD_FOREX_SYMBOLS).map(async ([pair, symbol]) => {
      try {
        // Try WebSocket data first (real-time)
        const wsSymbol = symbol.replace('.FOREX', ''); // Convert EURUSD.FOREX to EURUSD
        const wsData = wsForexData[wsSymbol];

        if (wsData && wsData.price && wsData.changePercent !== undefined) {
          // WebSocket data is fresh (within 60 seconds)
          if (Date.now() - wsData.timestamp < 60 * 1000) {
            return {
              pair,
              name: pair,
              change: `${wsData.changePercent >= 0 ? "+" : ""}${wsData.changePercent.toFixed(2)}%`,
              trend: wsData.changePercent >= 0 ? "positive" : "negative",
              price: wsData.price,
              rawChange: wsData.changePercent,
              source: "WebSocket"
            };
          }
        }

        // Fallback to REST API
        const url = `https://eodhd.com/api/real-time/${symbol}?api_token=${EODHD_KEY}&fmt=json`;
        const r = await api.get(url, { timeout: 5000 });
        const data = r.data;

        if (!data || !data.close || !data.previousClose) {
          console.warn(`⚠️ No EODHD data for ${pair}`);
          return null;
        }

        const currentPrice = parseFloat(data.close);
        const previousClose = parseFloat(data.previousClose);
        const changePercent = parseFloat(data.change_p);

        if (isNaN(currentPrice) || isNaN(changePercent)) {
          console.warn(`⚠️ Invalid data for ${pair}`);
          return null;
        }

        // Store previous close for WebSocket accuracy
        const wsSymbolRest = symbol.replace(".FOREX", "");
        if (!isNaN(previousClose)) {
          forexPrevClose[wsSymbolRest] = previousClose;
        }

        return {
          pair,
          name: pair,
          change: `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`,
          trend: changePercent >= 0 ? "positive" : "negative",
          price: currentPrice,
          rawChange: changePercent,
          source: "EODHD"
        };

      } catch (err) {
        console.warn(`⚠️ EODHD FX error for ${symbol}:`, err.message);
        return null;
      }
    });

    // Wait for all pairs to complete
    const pairResults = await Promise.all(pairPromises);

    // Filter out null results and add to results array
    pairResults.forEach(result => {
      if (result) {
        results.push(result);
        console.log(`✅ ${result.pair} (${result.source}): ${result.price.toFixed(4)} (${result.change})`);
      }
    });

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
    const r = await api.get(`http://localhost:${PORT}/api/forex`).catch(() => null);
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
        avg >= 0.3 ? "Strong 🔥" :
        avg <= -0.3 ? "Weak 🔻" :
        "Neutral －";
    });

    res.json(result);

  } catch (err) {
    console.error("❌ /api/forex-strength error:", err.message);
    res.status(500).json({ error: "Failed to compute strength" });
  }
});

/* ------------------------------------------------------
   COMMODITY SENTIMENT (YAHOO FUTURES + STORY)
------------------------------------------------------ */
app.get("/api/commodity-sentiment", async (req, res) => {
  try {
    const YAHOO_COMMODITIES = {
      Gold: "GC=F",
      Silver: "SI=F",
      Platinum: "PL=F",
      "Crude Oil": "CL=F"
    };

    let total = 0;
    let count = 0;

    const up = [];
    const down = [];

    for (const [name, symbol] of Object.entries(YAHOO_COMMODITIES)) {
      try {
        const r = await api.get(
          `${YAHOO_CHART}/${symbol}?interval=1d&range=5d`
        );

        const data = r.data.chart?.result?.[0];
        if (!data?.indicators?.quote?.[0]?.close) continue;

        const closes = data.indicators.quote[0].close.filter(
          n => typeof n === "number"
        );

        if (closes.length < 2) continue;

        const current = closes.at(-1);
        const previous = closes.at(-2);
        const pct = ((current - previous) / previous) * 100;

        if (!isNaN(pct)) {
          total += pct;
          count++;

          if (pct > 0) up.push(name);
          else if (pct < 0) down.push(name);
        }

      } catch (err) {
        console.warn(`⚠️ Sentiment fetch failed for ${name}:`, err.message);
      }

      await sleep(150);
    }

    if (!count) {
      return res.json({
        Sentiment: "Neutral －",
        Score: 0,
        Count: 0,
        Story: "Commodity markets are quiet today with insufficient data to determine direction."
      });
    }

    const avg = total / count;

    const Sentiment =
      avg >= 0.3 ? "Bullish 🔥" :
      avg <= -0.3 ? "Bearish 🔻" :
      "Neutral －";

    // 📝 Build story
    let story = "";

    if (Sentiment === "Neutral －") {
      story = `Commodity sentiment is neutral today. Markets are mixed, with ${
        up.length ? up.join(", ") : "no commodities"
      } trading higher while ${
        down.length ? down.join(", ") : "others"
      } remain under pressure, reflecting indecision across the commodities complex.`;
    }

    if (Sentiment === "Bullish 🔥") {
      story = `Commodity markets are leaning bullish today, led by strength in ${
        up.join(", ")
      }, suggesting improving risk appetite across key raw materials.`;
    }

    if (Sentiment === "Bearish 🔻") {
      story = `Commodity sentiment is bearish today as ${
        down.join(", ")
      } decline, pointing to weakening demand or profit-taking across commodity markets.`;
    }

    res.json({
      Sentiment,
      Score: Number(avg.toFixed(2)),
      Count: count,
      Up: up,
      Down: down,
      Story: story
    });

  } catch (err) {
    console.error("❌ /api/commodity-sentiment error:", err.message);
    res.status(500).json({ error: "Failed to compute commodity sentiment" });
  }
});

/* ------------------------------------------------------
   COMMODITIES
------------------------------------------------------ */
app.get("/api/commodities", async (req, res) => {
  try {
    // Check WebSocket data first (real-time, within 60 seconds)
    const results = [];
    for (const [symbol, data] of Object.entries(wsCommodityData)) {
      if (data && Date.now() - data.timestamp < 60 * 1000) {
        // Map symbols to proper names
        const nameMap = {
          "XAUUSD": "Gold",
          "XAGUSD": "Silver", 
          "XPTUSD": "Platinum"
        };
        const name = nameMap[symbol] || symbol.replace("USD", "").replace("X", "");
        
        results.push({
          name,
          symbol,
          price: data.price.toFixed(2),
          change: `${data.changePercent >= 0 ? "+" : ""}${data.changePercent.toFixed(2)}%`,
          trend: data.changePercent >= 0 ? "positive" : "negative",
          rawChange: data.changePercent
        });
        console.log(`✅ ${symbol} (WebSocket): ${data.price.toFixed(2)} (${data.changePercent >= 0 ? "+" : ""}${data.changePercent.toFixed(2)}%)`);
      }
    }

    // If we have WebSocket data, return it immediately
    if (results.length > 0) {
      return res.json(results);
    }

    // Fallback to cached Yahoo data
    if (commoditiesCache && Date.now() - commoditiesCacheTime < GENERIC_TTL) {
      return res.json(commoditiesCache);
    }

    // Last resort: fetch fresh Yahoo data
    const YAHOO_COMMODITIES = {
      "Gold": "GC=F",
      "Silver": "SI=F",
      "Platinum": "PL=F",
      "Crude Oil": "CL=F"
    };

    const yahooResults = [];

    for (const [name, symbol] of Object.entries(YAHOO_COMMODITIES)) {
      try {
        const url = `${YAHOO_CHART}/${symbol}?interval=1d&range=5d`;
        const r = await api.get(url);
        const data = r.data.chart?.result?.[0];
        if (!data) continue;

        const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");
        if (closes.length < 2) continue;

        const currentPrice = closes.at(-1);
        const previousPrice = closes.at(-2);
        const pct = ((currentPrice - previousPrice) / previousPrice) * 100;

        yahooResults.push({
          name,
          symbol,
          price: currentPrice.toFixed(2),
          change: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
          trend: pct >= 0 ? "positive" : "negative",
          rawChange: pct
        });

      } catch (err) {
        console.warn(`⚠️ Commodity fetch error for ${symbol}:`, err.message);
      }

      await sleep(150);
    }

    // Cache Yahoo results for fallback
    commoditiesCache = yahooResults;
    commoditiesCacheTime = Date.now();
    res.json(yahooResults);

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
    // ✅ FIX #1: Serve WebSocket data as initial snapshot
    const results = [];

    // Check WebSocket data first (real-time, within 60 seconds)
    for (const [symbol, data] of Object.entries(wsCryptoData)) {
      if (data && Date.now() - data.timestamp < 60 * 1000) {
        const name = symbol.split("-")[0];
        results.push({
          name,
          symbol,
          price: data.price.toFixed(2),
          change: `${data.changePercent >= 0 ? "+" : ""}${data.changePercent.toFixed(2)}%`,
          trend: data.changePercent >= 0 ? "positive" : "negative",
          rawChange: data.changePercent
        });
        console.log(`✅ ${name} (WebSocket): ${data.price.toFixed(2)} (${data.changePercent >= 0 ? "+" : ""}${data.changePercent.toFixed(2)}%)`);
      }
    }

    // If we have WebSocket data, return it immediately
    if (results.length > 0) {
      return res.json(results);
    }

    // Fallback to cached Yahoo data if no WebSocket data available
    if (cryptoCache && Date.now() - cryptoCacheTime < GENERIC_TTL) {
      return res.json(cryptoCache);
    }

    // Last resort: fetch fresh Yahoo data
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

    const yahooResults = [];

    for (const [name, symbol] of Object.entries(cryptoSymbols)) {
      try {
        const url = `${YAHOO_CHART}/${symbol}?interval=1d&range=5d`;
        const r = await api.get(url);
        const data = r.data.chart?.result?.[0];
        if (!data) continue;

        const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");
        if (closes.length < 2) continue;

        const currentPrice = closes.at(-1);
        const previousPrice = closes.at(-2);
        const pct = ((currentPrice - previousPrice) / previousPrice) * 100;

        yahooResults.push({
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

    // Cache Yahoo results for fallback
    cryptoCache = yahooResults;
    cryptoCacheTime = Date.now();
    res.json(yahooResults);

  } catch (err) {
    console.error("❌ /api/crypto error:", err.message);
    res.status(500).json({ error: "Failed to fetch crypto" });
  }
});

/* ------------------------------------------------------
   CRYPTO WEBSOCKET (REAL-TIME)
------------------------------------------------------ */
function initCryptoWebSocket() {
  const wsUrl = `wss://ws.eodhistoricaldata.com/ws/crypto?api_token=${EODHD_KEY}`;
  let ws = null;

  function connect() {
    console.log("📡 Connecting to EODHD Crypto WebSocket...");
    ws = new WebSocket(wsUrl);

    // Initialize previous close data on first connect
    if (Object.keys(cryptoPrevClose).length === 0) {
      refreshCryptoPrevClose();
    }

    ws.on("open", () => {
      console.log("✅ Crypto WebSocket connected");

      // Refresh previous close data periodically
      refreshCryptoPrevClose();
      setInterval(() => {
        refreshCryptoPrevClose();
      }, 5 * 60 * 1000); // Every 5 minutes

      ws.send(JSON.stringify({
        action: "subscribe",
        symbols: "BTC-USD,ETH-USD,XRP-USD,SOL-USD,ADA-USD,DOGE-USD,AVAX-USD,BNB-USD,LTC-USD"
      }));
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!msg.s || msg.p == null) return;

        const symbol = msg.s;
        const price = Number(msg.p);

        const prevClose = cryptoPrevClose[symbol];
        const change = Number.isFinite(prevClose) ? (price - prevClose) : 0;
        const restPercent = cryptoRestChangePercent[symbol];
        const changePercent = Number.isFinite(prevClose) && prevClose !== 0
          ? (change / prevClose) * 100
          : (restPercent || 0);

        // Store current price for next tick
        cryptoPrevPrice[symbol] = price;

        const payload = {
          symbol,
          price,
          changePercent,
          timestamp: Date.now()
        };

        if (wsCryptoData.hasOwnProperty(symbol)) {
          wsCryptoData[symbol] = payload;
          broadcastCryptoUpdate(payload);

          console.log(
            `₿ CRYPTO ${symbol}: ${price} (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%)`
          );
        }

      } catch (err) {
        console.error("❌ Crypto WS parse error:", err.message);
      }
    });


    ws.on("close", () => {
      console.log("⚠️ Crypto WebSocket closed, reconnecting...");
      setTimeout(connect, 5000);
    });

    ws.on("error", (err) => {
      console.error("❌ Crypto WebSocket error:", err.message);
    });
  }

  connect();
}


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
        const r = await api.get(url);
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
  const items = [];

  // ✅ Use WebSocket data first (real-time, within 60 seconds)
  for (const [symbol, data] of Object.entries(wsCryptoData)) {
    if (data && Date.now() - data.timestamp < 60 * 1000) {
      const name = symbol.split("-")[0];
      items.push(formatMover(name, symbol, data.changePercent, "Crypto"));
      console.log(`✅ Crypto mover (WS): ${name} ${data.changePercent >= 0 ? "+" : ""}${data.changePercent.toFixed(2)}%`);
    }
  }

  // If we have enough WebSocket data, return early
  if (items.length >= 3) {
    return items.slice(0, 5); // Return top 5
  }

  // Fallback to Yahoo data for any missing symbols
  const yahooSymbols = {
    BTC: "BTC-USD",
    ETH: "ETH-USD",
    XRP: "XRP-USD",
    SOL: "SOL-USD",
    ADA: "ADA-USD"
  };

  for (const [name, symbol] of Object.entries(yahooSymbols)) {
    // Skip if we already have this from WebSocket
    if (items.some(item => item.symbol === symbol)) continue;

    try {
      const r = await api.get(`${YAHOO_CHART}/${symbol}?interval=1d&range=5d`, { timeout: 5000 });
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
  }

  return items.slice(0, 5);
}

/* ------------------------------------------------------
   COMMODITY MOVERS
------------------------------------------------------ */
async function fetchCommodityMovers() {
  const items = [];

  // Map WebSocket symbols to proper names
  const commodityNameMap = {
    "XAUUSD": "Gold",
    "XAGUSD": "Silver",
    "XPTUSD": "Platinum"
  };

  // ✅ Use WebSocket data first (real-time, within 60 seconds)
  for (const [symbol, data] of Object.entries(wsCommodityData)) {
    if (data && Date.now() - data.timestamp < 60 * 1000) {
      const name = commodityNameMap[symbol] || symbol.replace("USD", "").replace("X", ""); // Use proper name or fallback
      items.push(formatMover(name, symbol, data.changePercent, "Commodity"));
      console.log(`✅ Commodity mover (WS): ${name} ${data.changePercent >= 0 ? "+" : ""}${data.changePercent.toFixed(2)}%`);
    }
  }

  // If we have enough WebSocket data, return early
  if (items.length >= 2) {
    return items.slice(0, 4); // Return top 4
  }

  // Fallback to Yahoo data for any missing symbols
  for (const [name, symbol] of Object.entries(YAHOO_COMMODITY_SYMBOLS)) {
    // Skip if we already have this from WebSocket
    if (items.some(item => item.name === name)) continue;

    try {
      const url = `${YAHOO_CHART}/${symbol}?interval=1d&range=5d`;
      const r = await api.get(url, { timeout: 5000 });
      const data = r.data.chart?.result?.[0];

      if (!data) continue;

      const closes = data.indicators.quote[0].close.filter(n => typeof n === "number");
      if (closes.length < 2) continue;

      const currentPrice = closes.at(-1);
      const previousPrice = closes.at(-2);
      const pct = ((currentPrice - previousPrice) / previousPrice) * 100;

      items.push(formatMover(name, symbol, pct, "Commodity"));

    } catch (err) {
      console.warn("⚠️ Commodity mover error:", symbol, err.message);
    }
  }

  return items.slice(0, 4);
}

/* ------------------------------------------------------
   STOCK MOVERS
------------------------------------------------------ */
async function fetchEodTopStocks(limit = 6) {
  if (!EODHD_KEY) return { items: [] };

  const fetchSide = async (side) => {
    try {
      const r = await api.get(
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
  const items = [];

  // ✅ Use WebSocket data first (real-time, within 60 seconds)
  for (const [symbol, data] of Object.entries(wsForexData)) {
    if (data && Date.now() - data.timestamp < 60 * 1000) {
      const pair = FOREX_SYMBOL_TO_PAIR[symbol] || symbol;
      items.push(formatMover(pair, data.symbol, data.changePercent, "Forex"));
      console.log(`✅ Forex mover (WS): ${pair} ${data.changePercent >= 0 ? "+" : ""}${data.changePercent.toFixed(2)}%`);
    }
  }

  // If we have enough WebSocket data, return early
  if (items.length >= 3) {
    return items.slice(0, 5); // Return top 5
  }

  // Fallback to TwelveData API for any missing pairs
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${FOREX_PAIRS.join(",")}&apikey=${TWELVEDATA_KEY}`;
    const r = await api.get(url, { timeout: 5000 });

    FOREX_PAIRS.forEach(pair => {
      // Skip if we already have this from WebSocket
      if (items.some(item => item.name === pair)) return;

      const d = r.data[pair];
      if (d?.percent_change) {
        items.push(formatMover(pair, pair, parseFloat(d.percent_change), "Forex"));
      }
    });

  } catch (err) {
    console.warn("⚠️ Forex movers API error:", err.message);
  }

  return items.slice(0, 5);
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
        const r = await api.get(`${YAHOO_CHART}/${symbol}?interval=1d&range=5d`);
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

    const results = {}; // Initialize results object

    // Forex heatmap symbols - consistent with crypto heatmap approach
    const forexSymbols = {
      "EUR/USD": "EURUSD=X",
      "GBP/USD": "GBPUSD=X",
      "USD/JPY": "USDJPY=X",
      "USD/CHF": "USDCHF=X",
      "USD/ZAR": "USDZAR=X",
      "EUR/ZAR": "EURZAR=X",
      "GBP/ZAR": "GBPZAR=X",
      "AUD/USD": "AUDUSD=X",
      "Gold": "GC=F",
      "Silver": "SI=F",
      "Platinum": "PL=F",
      "Crude Oil (WTI)": "CL=F"
    };


    // 🚀 SIMPLIFIED: Process one symbol at a time to avoid Yahoo Finance issues
    const symbolEntries = Object.entries(forexSymbols);

    for (const [label, symbol] of symbolEntries) {
      const timeframes = {
        "1h": { interval: "5m", range: "1d" },
        "4h": { interval: "15m", range: "5d" },
        "1d": { interval: "1d", range: "5d" },
        "1w": { interval: "1d", range: "1mo" }
      };

      const tfResults = {};

      // 🚀 OPTIMIZATION: Process all timeframes for one symbol in parallel (like crypto heatmap)
      const timeframePromises = Object.entries(timeframes).map(async ([tf, params]) => {
        let pct = null;

        try {
          const url = `${YAHOO_CHART}/${symbol}?interval=${params.interval}&range=${params.range}`;
          const r = await api.get(url, { timeout: 10000 }); // 10s timeout
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
          console.warn(`⚠️ Heatmap error ${symbol} (${tf}):`, err.message);
        }

        return { tf, pct };
      });

      // Wait for all timeframes to complete for this symbol
      const timeframeResults = await Promise.all(timeframePromises);
      timeframeResults.forEach(({ tf, pct }) => {
        tfResults[tf] = pct;
      });

      results[label] = tfResults;
      console.log(`✅ Heatmap loaded for ${label}:`, tfResults);

      // Delay between symbols
      await sleep(500);
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

    // 🚀 OPTIMIZATION: Process all symbols in parallel instead of sequential
    const symbolPromises = Object.entries(cryptoSymbols).map(async ([name, symbol]) => {
      const timeframes = {
        "1h": { interval: "5m", range: "1d" },
        "4h": { interval: "15m", range: "5d" },
        "1d": { interval: "1d", range: "5d" },
        "1w": { interval: "1d", range: "1mo" }
      };

      const tfResults = {};

      // 🚀 OPTIMIZATION: Process all timeframes for one symbol in parallel
      const timeframePromises = Object.entries(timeframes).map(async ([tf, params]) => {
        let pct = null;

        try {
          const url = `${YAHOO_CHART}/${symbol}?interval=${params.interval}&range=${params.range}`;
          const r = await api.get(url, { timeout: 5000 }); // ⏰ Add 5s timeout
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

        return { tf, pct };
      });

      // Wait for all timeframes to complete for this symbol
      const timeframeResults = await Promise.all(timeframePromises);
      timeframeResults.forEach(({ tf, pct }) => {
        tfResults[tf] = pct;
      });

      console.log(`✅ Crypto heatmap loaded for ${name}:`, tfResults);
      return { name, tfResults };
    });

    // Wait for all symbols to complete
    const symbolResults = await Promise.all(symbolPromises);
    symbolResults.forEach(({ name, tfResults }) => {
      results[name] = tfResults;
    });

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
    
    const r = await api.get(url);
    
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
        const r = await api.get(
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
    const indicesResp = await api.get(`http://localhost:${PORT}/api/indices`).catch(() => ({ data: [] }));
    const allIndices = indicesResp.data || [];
    
    const jseIndices = allIndices.filter(idx => 
      idx.name.includes("JSE") || idx.symbol.includes(".JO")
    );

    const forexResp = await api.get(`http://localhost:${PORT}/api/forex`).catch(() => ({ data: [] }));
    const allForex = forexResp.data || [];
    
    const zarForex = allForex.filter(fx => 
      fx.pair.includes("ZAR")
    );

    const commoditiesResp = await api.get(`http://localhost:${PORT}/api/commodities`).catch(() => ({ data: [] }));
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

// Separate cache for SA news
let saNewsCache = null;
let saNewsCacheTime = 0;

app.get("/api/sa-news", async (req, res) => {
  try {
    // Use cached SA news if available (5 min cache)
    if (saNewsCache && Date.now() - saNewsCacheTime < 5 * 60 * 1000) {
      return res.json(saNewsCache);
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

    // Save to SA news cache
    saNewsCache = transformedNews;
    saNewsCacheTime = Date.now();

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
   ECONOMIC INDICATORS ENDPOINT (EVENT-DRIVEN VERSION)
------------------------------------------------------ */
app.get("/api/economic-indicators", async (req, res) => {
  const now = Date.now();

  try {
    console.log("📊 Fetching economic indicators from EODHD economic-events API...");

    const today = new Date().toISOString().split("T")[0];

    // Map currency to EODHD economic-events country codes
    const countryMap = {
      USD: "US",
      EUR: "EU",
      GBP: "GB",
      JPY: "JP",
      AUD: "AU",
      CAD: "CA",
      CHF: "CH",
      NZD: "NZ",
      ZAR: "ZA"
    };

    const currencies = Object.keys(countryMap);

    const indicatorsData = {};

    // ==============================
    // HELPER: CPI YoY CALCULATOR
    // ==============================
    const calculateCPIYoY = (events) => {
      if (!events || !Array.isArray(events)) return null;

      const released = events
        .filter(e => e.actual !== null)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      if (released.length < 13) return null;

      const latest = released[0];
      const latestDate = new Date(latest.date);

      const previousYearEvent = released.find(e => {
        const d = new Date(e.date);
        return (
          d.getMonth() === latestDate.getMonth() &&
          d.getFullYear() === latestDate.getFullYear() - 1
        );
      });

      if (!previousYearEvent) return null;

      const yoy =
        ((latest.actual - previousYearEvent.actual) /
          previousYearEvent.actual) * 100;

      return {
        value: parseFloat(yoy.toFixed(2)),
        date: latest.date.split(" ")[0]
      };
    };

    // ==============================
    // HELPER: GET LATEST RELEASED VALUE
    // ==============================
    const getLatestEventValue = (events) => {
      if (!events || !Array.isArray(events)) return null;

      const released = events
        .filter(e => e.actual !== null)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      if (!released.length) return null;

      return {
        value: parseFloat(released[0].actual),
        date: released[0].date.split(" ")[0]
      };
    };

    // ==============================
    // HELPER: FETCH EUR INFLATION FROM EUROSTAT
    // ==============================
    const fetchEurostatInflation = async () => {
      try {
        const response = await axios.get(
          'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_manr',
          {
            params: {
              format: 'JSON',
              geo: 'EA20',
              coicop: 'CP00',
              unit: 'RCH_A'
            },
            timeout: 10000
          }
        );

        const data = response.data;
        if (!data || !data.value || !data.dimension?.time?.category?.index) {
          console.error('❌ Eurostat: Invalid data structure');
          return null;
        }

        // Get the time dimension mapping (JSON-stat format)
        const timeIndex = data.dimension.time.category.index;
        const timeLabels = data.dimension.time.category.label;
        const values = data.value;

        // Get all time periods sorted chronologically (newest first)
        const sortedTimes = Object.keys(timeIndex).sort().reverse();
        
        console.log(`📊 Eurostat latest 3 periods: ${sortedTimes.slice(0, 3).join(', ')}`);
        
        // Find the latest available value by iterating through sorted time periods
        for (const timePeriod of sortedTimes) {
          const dimensionPosition = timeIndex[timePeriod];
          const inflationValue = values[dimensionPosition];
          
          if (inflationValue !== null && inflationValue !== undefined) {
            // Convert time format (e.g., "2026M01" to "2026-01")
            const formattedDate = timePeriod.replace('M', '-');
            const label = timeLabels?.[timePeriod] || timePeriod;
            
            // ⚠️ TEMPORARY ADJUSTMENT: Subtract 0.3% to reflect flash estimate for Jan 2026 (1.7%)
            // TODO: Remove this once Eurostat publishes official January 2026 data
            const adjustedValue = inflationValue - 0.3;
            
            console.log(`📊 Eurostat EUR inflation: ${inflationValue}% for ${label} (adjusted to ${adjustedValue}%)`);
            
            return {
              value: parseFloat(adjustedValue.toFixed(1)),
              date: formattedDate
            };
          }
        }

        console.error('❌ Eurostat: No valid values found');
        return null;
      } catch (error) {
        console.error('❌ Eurostat API error:', error.message);
        return null;
      }
    };

    // ==============================
    // FETCH DATA FOR EACH COUNTRY
    // ==============================
    await Promise.all(
      currencies.map(async (currency) => {
        try {
          const eventCountryCode = countryMap[currency];

          console.log(`📊 Fetching ${currency} economic events...`);

          // Special handling for EUR - fetch from Eurostat
          let cpiData;
          if (currency === 'EUR') {
            cpiData = await fetchEurostatInflation();
            console.log(`📊 Eurostat EUR inflation: ${cpiData?.value}% (${cpiData?.date})`);
          }

          const [cpiRes, unemploymentRes, gdpRes] = await Promise.all([
            // Skip CPI fetch for EUR since we use Eurostat
            currency === 'EUR' ? Promise.resolve(null) : axios.get("https://eodhd.com/api/economic-events", {
              params: {
                api_token: EODHD_KEY,
                country: eventCountryCode,
                type: "CPI",
                from: "2024-01-01",
                to: today,
                fmt: "json"
              }
            }).catch(() => null),

            axios.get("https://eodhd.com/api/economic-events", {
              params: {
                api_token: EODHD_KEY,
                country: eventCountryCode,
                type: "Unemployment Rate",
                from: "2024-01-01",
                to: today,
                fmt: "json"
              }
            }).catch(() => null),

            axios.get("https://eodhd.com/api/economic-events", {
              params: {
                api_token: EODHD_KEY,
                country: eventCountryCode,
                type: "GDP Growth Rate",
                from: "2024-01-01",
                to: today,
                fmt: "json"
              }
            }).catch(() => null)
          ]);

          // For South Africa, Canada, and Switzerland, use actual inflation rate directly instead of YoY calculation
          // For EUR, use Eurostat data fetched earlier
          if (currency !== 'EUR') {
            cpiData = (currency === 'ZAR' || currency === 'CAD' || currency === 'CHF')
              ? getLatestEventValue(cpiRes?.data)
              : calculateCPIYoY(cpiRes?.data);
          }
          
          const unemploymentData = getLatestEventValue(unemploymentRes?.data);
          const gdpData = getLatestEventValue(gdpRes?.data);

          indicatorsData[currency] = {
            inflation: cpiData ? { value: parseFloat(cpiData.value.toFixed(1)), date: cpiData.date } : { value: null, date: null },
            unemployment: unemploymentData || { value: null, date: null },
            gdp: gdpData || { value: null, date: null }
          };

          console.log(
            `✅ ${currency}: Inflation: ${cpiData?.value}% (${cpiData?.date}), ` +
            `Unemployment: ${unemploymentData?.value}% (${unemploymentData?.date}), ` +
            `GDP: ${gdpData?.value}% (${gdpData?.date})`
          );

        } catch (error) {
          console.error(`❌ Error fetching ${currency} data:`, error.message);

          indicatorsData[currency] = {
            inflation: { value: null, date: null },
            unemployment: { value: null, date: null },
            gdp: { value: null, date: null }
          };
        }
      })
    );

    const result = {
      timestamp: new Date().toISOString(),
      indicators: indicatorsData
    };

    console.log("📊 Final economic indicators:", JSON.stringify(result, null, 2));

    res.json(result);

  } catch (error) {
    console.error("❌ Economic Indicators Error:", error.message);

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
   SERVE FRONTEND - Catch-all handler for SPA routing
------------------------------------------------------ */
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../Frontend/index.html'));
});

/* ------------------------------------------------------
   START SERVER
------------------------------------------------------ */
const server = httpServer.createServer(app);

server.listen(PORT, () => {
  console.log(`🚀 Marome Backend running on port ${PORT}`);
  console.log(`� Frontend WebSocket server running on ws://localhost:${PORT}`);
  console.log(`�📊 Correlation Matrix API: http://localhost:${PORT}/api/correlation-matrix?period=30`);
  console.log(`🧪 EODHD Test: http://localhost:${PORT}/api/test-eodhd-gold`);
  console.log(`💬 Marome Chat AI: http://localhost:${PORT}/api/chat`);
  console.log(`📡 Initializing EODHD WebSockets...`);
  initEODHDWebSocket();
  initForexWebSocket();
  initCryptoWebSocket(); 
});

/* ------------------------------------------------------
   FRONTEND WEBSOCKET SERVER (PUSH UPDATES)
------------------------------------------------------ */
const wsServer = new WebSocket.Server({ server });

wsServer.on("connection", (socket) => {
  console.log("🔌 Frontend WebSocket client connected");

  // ✅ FIX #2: Push initial snapshots on connect
  // Send crypto data snapshot
  for (const [symbol, data] of Object.entries(wsCryptoData)) {
    if (data) {
      socket.send(JSON.stringify({
        type: "crypto",
        symbol,
        price: data.price,
        changePercent: data.changePercent,
        timestamp: data.timestamp
      }));
    }
  }

  // Send forex data snapshot
  for (const [symbol, data] of Object.entries(wsForexData)) {
    if (data) {
      socket.send(JSON.stringify({
        type: "forex",
        symbol: data.symbol,
        pair: FOREX_SYMBOL_TO_PAIR[symbol] || symbol,
        price: data.price,
        change: data.change,
        changePercent: data.changePercent,
        timestamp: data.timestamp
      }));
    }
  }

  // Send stock data snapshot
  for (const [symbol, data] of Object.entries(wsStocksData)) {
    if (data) {
      socket.send(JSON.stringify({
        type: "stock",
        symbol,
        price: data.price,
        changePercent: data.changePercent,
        timestamp: data.timestamp
      }));
    }
  }

  // Send commodity data snapshot
  for (const [symbol, data] of Object.entries(wsCommodityData)) {
    if (data) {
      socket.send(JSON.stringify({
        type: "commodity",
        symbol,
        price: data.price,
        changePercent: data.changePercent,
        timestamp: data.timestamp
      }));
    }
  }

  socket.on("close", () => {
    console.log("🔌 Frontend WebSocket client disconnected");
  });
});

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

function broadcastUSIndexUpdate(payload) {
  const message = JSON.stringify({ type: "us-index", ...payload });
  wsServer.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastCryptoUpdate(payload) {
  const message = JSON.stringify({ type: "crypto", ...payload });
  wsServer.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

/* ------------------------------------------------------
   EODHD WEBSOCKET FOR REAL-TIME US INDICES & STOCKS
------------------------------------------------------ */
function initEODHDWebSocket() {
  const wsUrl = `wss://ws.eodhistoricaldata.com/ws/us-quote?api_token=${EODHD_KEY}`;
  let ws = null;
  let reconnectInterval = 5000;
  let pingInterval = null;

  function connect() {
    console.log("📡 Connecting to EODHD WebSocket...");
    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      console.log("✅ EODHD WebSocket connected successfully!");
      
      // Subscribe to US indices and major stocks (reduced to avoid EODHD limits)
      const subscribeMsg = {
        action: "subscribe",
        symbols: "GSPC.INDX,NDX.INDX,DJI.INDX,AAPL.US,MSFT.US,AMZN.US,GOOGL.US,TSLA.US,NVDA.US,META.US,JPM.US,V.US,KO.US,JNJ.US,WMT.US"
      };
      ws.send(JSON.stringify(subscribeMsg));
      console.log("📊 Subscribed to: 3 indices + 12 major US stocks");
      console.log("🔄 REST API fallback also active (30s intervals)");


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
          broadcastUSIndexUpdate({
            symbol: msg.s,
            price: msg.p,
            changePercent: msg.cp,
            timestamp: Date.now()
          });
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
      console.log("🔄 Falling back to REST API polling only");
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

  // Add REST API fallback polling every 30 seconds
  function startRestFallback() {
    console.log("🔄 Starting REST API fallback for US stocks and indices...");
    setInterval(async () => {
      try {
        // Update indices
        for (const [name, symbol] of Object.entries(INDEX_SYMBOLS)) {
          if (name === "JSE Top 40") continue; // Skip JSE, only do US indices
          
          try {
            const url = `https://eodhd.com/api/real-time/${symbol}?api_token=${EODHD_KEY}&fmt=json`;
            const r = await api.get(url);
            const data = r.data;

            if (data && data.close && data.change_p) {
              const payload = {
                symbol,
                price: parseFloat(data.close),
                changePercent: parseFloat(data.change_p),
                timestamp: Date.now()
              };

              // Update cache and broadcast
              if (wsIndicesData.hasOwnProperty(symbol)) {
                wsIndicesData[symbol] = payload;
                console.log(`📊 INDEX REST ${symbol}: ${payload.price.toFixed(2)} (${payload.changePercent >= 0 ? "+" : ""}${payload.changePercent.toFixed(2)}%)`);
                broadcastUSIndexUpdate(payload);
              }
            }
          } catch (err) {
            // Silently ignore individual index errors
          }
        }

        // Update stocks
        for (const symbol of Object.keys(wsStocksData)) {
          try {
            const url = `https://eodhd.com/api/real-time/${symbol}?api_token=${EODHD_KEY}&fmt=json`;
            const r = await api.get(url);
            const data = r.data;

            if (data && data.close && data.change_p) {
              const payload = {
                symbol,
                price: parseFloat(data.close),
                changePercent: parseFloat(data.change_p),
                timestamp: Date.now()
              };

              // Update cache and broadcast
              wsStocksData[symbol] = payload;
              console.log(`📈 STOCK REST ${symbol}: ${payload.price.toFixed(2)} (${payload.changePercent >= 0 ? "+" : ""}${payload.changePercent.toFixed(2)}%)`);
              broadcastUSStockUpdate(payload);
            }
          } catch (err) {
            // Silently ignore individual stock errors
          }
        }
      } catch (err) {
        // Silently ignore polling errors
      }
    }, 30000); // Poll every 30 seconds
  }

  connect();
  startRestFallback(); // Start REST fallback immediately
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
      
      // Subscribe to 8 forex pairs + 3 metals (WebSocket uses plain format without .FOREX suffix)
      const subscribeMsg = {
        action: "subscribe",
        symbols: "EURUSD,GBPUSD,USDJPY,USDZAR,EURZAR,GBPZAR,AUDUSD,USDCHF,XAUUSD,XAGUSD,XPTUSD"
      };
      ws.send(JSON.stringify(subscribeMsg));
      console.log("💱 Subscribed to: 8 forex pairs + 3 metals");


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

        // 🔥 Handle spot metals (XAUUSD, XAGUSD, XPTUSD)
        if (["XAUUSD", "XAGUSD", "XPTUSD"].includes(msg.s)) {
          const payload = {
            symbol: msg.s, // keep symbol consistent with /api/commodities and DOM
            price,
            change,
            changePercent,
            timestamp: Date.now()
          };

          wsCommodityData[msg.s] = payload;
          commoditiesWsActive = true;

          // Map symbols to proper names for WebSocket broadcast
          const nameMap = {
            "XAUUSD": "Gold",
            "XAGUSD": "Silver", 
            "XPTUSD": "Platinum"
          };
          const commodityName = nameMap[msg.s];

          broadcastCommodityUpdate({
            symbol: msg.s,
            name: commodityName,
            price: payload.price,
            changePercent: payload.changePercent,
            timestamp: payload.timestamp
          });

          console.log(
            `🥇 COMMODITY ${msg.s}: ${price.toFixed(2)} (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%)`
          );

          return; // ⛔ stop forex logic from touching metals
        }
        
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

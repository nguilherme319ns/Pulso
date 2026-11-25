// Rota HTTP para dados publicos de mercado da brapi.
// Node.js 18+ (fetch nativo). Nao movimenta saldos e nao acessa MySQL.
const express = require('express');
const router = express.Router();
const TICKERS = ['PETR4', 'VALE3', 'ITUB4', 'MGLU3'];
const CACHE_MS = 5 * 60 * 1000;
let cache = null;

async function quoteFor(symbol) {
  // Cada simbolo da lista e permitido pela brapi para testes sem token.
  const url = `https://brapi.dev/api/v2/stocks/quote?symbols=${encodeURIComponent(symbol)}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Pulso-Demo/1.0' },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error(`brapi: HTTP ${response.status}`);
  const json = await response.json();
  // A estrutura v2 usa results[].data. Algumas respostas v1 usam results[] diretamente.
  const result = json.results?.[0];
  const data = result?.data || result;
  if (!data) throw new Error(`Sem dados para ${symbol}`);
  const price = Number(data.regularMarketPrice);
  if (!Number.isFinite(price) || price < 0) throw new Error(`Cotacao invalida para ${symbol}`);
  const rawChange = Number(data.regularMarketChangePercent);
  return {
    symbol,
    name: String(data.longName || data.shortName || result?.shortName || symbol).slice(0, 110),
    price,
    changePercent: Number.isFinite(rawChange) ? rawChange : null,
    marketTime: data.regularMarketTime || data.regularMarketDate || null
  };
}

router.get('/quotes', async (_req, res) => {
  if (cache && Date.now() - cache.savedAt < CACHE_MS) {
    res.set('Cache-Control', 'private, max-age=60');
    return res.json(cache.payload);
  }
  const settled = await Promise.allSettled(TICKERS.map(quoteFor));
  const quotes = settled.filter(x => x.status === 'fulfilled').map(x => x.value);
  if (!quotes.length) {
    if (cache) return res.json({ ...cache.payload, stale: true });
    return res.status(503).json({
      message: 'As cotacoes estao indisponiveis no momento. Tente mais tarde.'
    });
  }
  const payload = {
    source: 'brapi.dev',
    fetchedAt: new Date().toISOString(),
    partial: quotes.length !== TICKERS.length,
    quotes
  };
  cache = { savedAt: Date.now(), payload };
  res.set('Cache-Control', 'private, max-age=60');
  return res.json(payload);
});

module.exports = router;

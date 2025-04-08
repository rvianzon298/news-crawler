require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { HfInference } = require("@huggingface/inference");

const app = express();
const PORT = process.env.PORT || 3000;
const hf = new HfInference(process.env.HUGGINGFACE_TOKEN);
const CACHE_DIR = "./cache";
const CACHE_TTL = 3600 * 1000; // 1 hour

// Ensure cache dir
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// --- Cache helpers ---
function getCachePath(name) {
  return path.join(CACHE_DIR, `${name}.json`);
}

function saveToCache(name, data) {
  const file = getCachePath(name);
  fs.writeFileSync(file, JSON.stringify({ timestamp: Date.now(), data }));
}

function loadFromCache(name) {
  const file = getCachePath(name);
  if (fs.existsSync(file)) {
    const { timestamp, data } = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Date.now() - timestamp < CACHE_TTL) return data;
    fs.unlinkSync(file);
  }
  return null;
}

// --- Google News Search ---
async function searchGoogleNews(query) {
  const cached = loadFromCache(`${query}_search`);
  if (cached) return cached;

  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}+news&tbm=nws&lr=lang_en&cr=countryPH`;
  const headers = {
    "User-Agent": "Mozilla/5.0",
  };

  const res = await axios.get(url, { headers });
  const $ = cheerio.load(res.data);
  const rawLinks = [];

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (href && href.includes("/url?q=")) {
      const match = href.match(/\/url\?q=(https?:\/\/[^&]+)/);
      if (match) rawLinks.push(match[1]);
    }
  });

  const top10 = rawLinks.slice(0, 10);
  saveToCache(`${query}_search`, top10);
  return top10;
}

// --- Scrape article ---
async function scrapeArticle(url) {
  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });
    const $ = cheerio.load(res.data);

    const title = $("title").text() || "";
    const paragraphs = $("p")
      .map((_, el) => $(el).text())
      .get()
      .join(" ")
      .slice(0, 500);

    if (!title || !paragraphs) return null;

    return { url, title, content: paragraphs };
  } catch (err) {
    return null;
  }
}

// --- Relevance classification ---
async function checkRelevance(text, brand) {
  const apiUrl = "https://api-inference.huggingface.co/models/facebook/bart-large-mnli";
  const headers = {
    "Authorization": "Bearer " + process.env.HUGGINGFACE_TOKEN, // Access token from .env file
    "Content-Type": "application/json"
  };

  const data = JSON.stringify({
    "inputs": text,
    "parameters": {
      "candidate_labels": ["business", "finance", "economy", "earnings", "stock", "unrelated"]
    }
  });

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: headers,
      body: data
    });

    const result = await response.json();

    // If the highest confidence score is related to business topics, return "relevant"
    return (result.scores && result.scores[0] > 0.4 && 
            ["business", "finance", "economy", "earnings", "stock"].includes(result.labels[0])) 
            ? "Yes, it is relevant" : "No, it is not relevant";
  } catch (error) {
    console.error("Error checking relevance:", error);
    return "Error: Unable to check relevance";
  }
}



// --- API endpoint ---
app.get("/crawl_news", async (req, res) => {
  const brand = req.query.brand;
  if (!brand) return res.status(400).json({ error: "Missing brand query" });

  const cacheKey = `${brand}_data`;
  const cached = loadFromCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const links = await searchGoogleNews(brand);
    const articles = [];

    for (const link of links) {
      const article = await scrapeArticle(link);
      if (article) {
        article.relevance = await checkRelevance(article.content, brand);
        articles.push(article);
      }
    }

    const result = { brand, articles };
    saveToCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.listen(PORT, () => {
  console.log(`📰 Crawler API running at http://localhost:${PORT}/crawl_news?brand=YourFranchise`);
});

app.get("/", (req, res) => {
  res.send("✅ News Crawler is running");
});

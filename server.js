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
const CACHE_TTL = 60 * 1000; // 1 minute

// Ensure cache dir
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// Cache helpers
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

// Google News Search
async function searchGoogleNews(query) {
  const cached = loadFromCache(`${query}_search`);
  if (cached) return cached;

  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}+news&tbm=nws&lr=lang_en&cr=countryPH`;
  const headers = { "User-Agent": "Mozilla/5.0" };
  
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

// Scrape article and filter unwanted content
async function scrapeArticle(url) {
  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
    });

    // Check if the response status is 403 or 404
    if (res.status === 403 || res.status === 404) {
      console.error(`Error scraping article: Received ${res.status} for ${url}`);
      return null;
    }

    const $ = cheerio.load(res.data);
    const title = $("title").text().trim() || "";

    // Collect paragraphs and filter out unwanted text patterns
    const paragraphs = $("p")
      .map((_, el) => {
        const text = $(el).text().trim();

        // Filter out unwanted text patterns like ads or AI-generated summaries
        const unwantedPatterns = [
          /Already have Rappler\+/i,
          /Sign in to listen/i,
          /SUMMARY/i,
          /AI generated summarization/i,
          /For context, always refer to the full article/i,
        ];

        // Check if the paragraph matches any unwanted patterns
        for (const pattern of unwantedPatterns) {
          if (pattern.test(text)) return '';  // Return an empty string if the pattern matches
        }

        return text;
      })
      .get()
      .join(" ")
      .replace(/\s+/g, " ")  // Normalize whitespace
      .slice(0, 500);  // Limiting text to 500 characters

    // 1. Try to get the image from the Open Graph meta tag (og:image)
    const ogImage = $("meta[property='og:image']").attr("content");
    const twitterImage = $("meta[name='twitter:image']").attr("content");

    // Fallback to first image in content if no Open Graph or Twitter image is found
    const imageUrl = ogImage || twitterImage || $("article img").first().attr("src");

    // Make sure the image URL is complete (prepends 'https:' if not fully qualified)
    const imageSrc = imageUrl ? (imageUrl.startsWith("http") ? imageUrl : `https:${imageUrl}`) : null;

    if (!title || !paragraphs) return null;

    return { url, title, content: paragraphs, image: imageSrc };
  } catch (err) {
    console.error(`Error scraping article from ${url}:`, err.message);
    return null;  // Continue without breaking the flow
  }
}




// Check relevance in batch
async function checkRelevanceBatch(texts) {
  const apiUrl = "https://api-inference.huggingface.co/models/facebook/bart-large-mnli";
  const payload = {
    inputs: texts,
    parameters: {
      candidate_labels: ["business", "finance", "economy", "earnings", "stock", "unrelated"]
    }
  };

  const headers = {
    Authorization: `Bearer ${process.env.HUGGINGFACE_TOKEN}`,
    "Content-Type": "application/json"
  };

  try {
    const response = await axios.post(apiUrl, payload, { headers });
    return response.data.map(({ labels, scores }) => 
      labels[0] === "unrelated" || scores[0] <= 0.4 ? "No, it is not relevant" : "Yes, it is relevant"
    );
  } catch (error) {
    console.error("Error checking relevance:", error.response?.data || error.message);
    return Array(texts.length).fill("Error: Unable to check relevance");
  }
}

// API endpoint
app.get("/crawl_news", async (req, res) => {
  const brand = req.query.brand;
  if (!brand) return res.status(400).json({ error: "Missing brand query" });

  const cacheKey = `${brand}_data`;
  const cached = loadFromCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const links = await searchGoogleNews(brand);
    const articlePromises = links.map(async (link) => {
      return await scrapeArticle(link);
    });

    const articlesFetched = await Promise.all(articlePromises);
    const filteredArticles = articlesFetched.filter((article) => article !== null);

    const texts = filteredArticles.map((article) => article.content);
    const relevanceResults = await checkRelevanceBatch(texts);

    filteredArticles.forEach((article, idx) => {
      article.relevance = relevanceResults[idx];
    });

    const result = { brand, articles: filteredArticles };
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

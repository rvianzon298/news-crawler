import os
import json
import time
from fastapi import FastAPI, Query
import aiohttp
from bs4 import BeautifulSoup
from typing import List, Dict
import re
import uvicorn
import asyncio
from transformers import pipeline

app = FastAPI()

# Load Hugging Face zero-shot classification model
classifier = pipeline("zero-shot-classification", model="facebook/bart-large-mnli")

# Ensure the cache directory exists
CACHE_DIR = "./cache"
CACHE_TTL = 3600  # Cache time-to-live (in seconds)

os.makedirs(CACHE_DIR, exist_ok=True)

# Function to save to cache with timestamp
def save_to_cache(filename: str, data: Dict):
    filepath = os.path.join(CACHE_DIR, filename)
    cache_data = {
        "timestamp": time.time(),
        "data": data
    }
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(cache_data, f)

# Function to load from cache with expiration check
def load_from_cache(filename: str) -> Dict:
    filepath = os.path.join(CACHE_DIR, filename)
    if os.path.exists(filepath):
        with open(filepath, "r", encoding="utf-8") as f:
            try:
                cache_data = json.load(f)
                # Check if cache has expired
                if time.time() - cache_data["timestamp"] < CACHE_TTL:
                    return cache_data["data"]
                else:
                    os.remove(filepath)  # Remove expired cache
            except (json.JSONDecodeError, KeyError):
                os.remove(filepath)  # Remove corrupted cache
    return None

# Function to search for news articles
async def search_news(query: str) -> List[str]:
    cache_file = f"{query}_search.json"
    cached_data = load_from_cache(cache_file)
    if cached_data:
        return cached_data  # Return cached result

    search_url = f"https://www.google.com/search?q={query}+news&tbm=nws&lr=lang_en&cr=countryPH"
    headers = {"User-Agent": "Mozilla/5.0"}

    async with aiohttp.ClientSession() as session:
        async with session.get(search_url, headers=headers) as response:
            if response.status != 200:
                return []
            html = await response.text()

    soup = BeautifulSoup(html, "html.parser")
    raw_links = [a['href'] for a in soup.select("a") if 'url?q=' in a['href']]
    links = [re.search(r'/url\?q=(https?://[^&]+)', link) for link in raw_links]
    links = [match.group(1) for match in links if match]

    # Save the result to cache
    save_to_cache(cache_file, links[:10])
    return links[:10]

# Function to scrape article content
async def scrape_article(session: aiohttp.ClientSession, url: str) -> Dict:
    headers = {"User-Agent": "Mozilla/5.0"}
    async with session.get(url, headers=headers) as response:
        if response.status != 200:
            return {}

        raw_html = await response.read()
        try:
            html = raw_html.decode('utf-8', errors='ignore')
        except UnicodeDecodeError:
            html = raw_html.decode('latin-1', errors='ignore')

    soup = BeautifulSoup(html, "html.parser")
    title = soup.find("title").text if soup.find("title") else None
    paragraphs = soup.find_all("p")
    content = " ".join([p.text for p in paragraphs])[:500] if paragraphs else None

    if not title or not content:
        return {}

    return {"url": url, "title": title, "content": content}

# Function to check article relevance
def check_relevance(text: str, brand: str) -> str:
    labels = [brand]
    result = classifier(text, labels)
    
    relevance_score = result["scores"][0] * 100  # Convert to percentage
    return "Yes, it is relevant" if relevance_score >= 50 else "No, it is not relevant"

# API Endpoint
@app.get("/crawl_news/")
async def crawl_news(brand: str = Query(..., description="Franchise name to search for")):
    # Check if search results and articles are cached
    cache_file = f"{brand}_data.json"
    cached_data = load_from_cache(cache_file)

    if cached_data:
        return cached_data  # Return cached result if available

    # Perform search if not cached
    links = await search_news(brand)

    # Scrape articles
    articles = []
    async with aiohttp.ClientSession() as session:
        for url in links:
            article = await scrape_article(session, url)
            if article:
                # Add relevance classification
                article["relevance"] = check_relevance(article["content"], brand)
                articles.append(article)

    # Cache the entire brand and articles data
    data_to_cache = {
        "brand": brand,
        "articles": articles
    }
    save_to_cache(cache_file, data_to_cache)

    return data_to_cache

const express = require('express');
const puppeteer = require('puppeteer');

const app = express();

app.get('/news', async (req, res) => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('https://news.ycombinator.com/', { waitUntil: 'networkidle2' });

  const articles = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('.athing').forEach(item => {
      const title = item.querySelector('.titleline a')?.innerText;
      const link = item.querySelector('.titleline a')?.href;
      if (title && link) results.push({ title, link });
    });
    return results;
  });

  await browser.close();
  res.json(articles.slice(0, 10));
});

app.listen(3000, () => console.log('🚀 News API running on http://localhost:3000/news'));

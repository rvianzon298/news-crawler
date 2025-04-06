const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/news', async (req, res) => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
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

app.listen(PORT, () => console.log(`🚀 News API running on port ${PORT}`));

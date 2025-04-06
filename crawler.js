const puppeteer = require('puppeteer');

async function fetchNews() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('https://news.ycombinator.com/', { waitUntil: 'networkidle2' });

  // Simple extraction
  const articles = await page.evaluate(() => {
    const items = document.querySelectorAll('.athing');
    const results = [];

    items.forEach(item => {
      const title = item.querySelector('.titleline a')?.innerText;
      const link = item.querySelector('.titleline a')?.href;

      if (title && link) {
        results.push({ title, link });
      }
    });

    return results;
  });

  console.log(JSON.stringify(articles.slice(0, 10), null, 2));

  await browser.close();
}

fetchNews();

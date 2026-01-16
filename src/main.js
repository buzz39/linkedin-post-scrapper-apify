import { Actor } from 'apify';
import { chromium } from 'playwright-extra';

// Removed: stealthPlugin is incompatible with Playwright
// Using playwright-extra for evasion instead

await Actor.main(async () => {
    const { postUrl } = await Actor.getInput();
    const username = process.env.linkedin_username;
    const password = process.env.linkedin_password;

    if (!postUrl || !username || !password) {
        await Actor.fail('Missing postUrl, LinkedIn username, or password.');
    }

    // ✅ Use correct HTTP proxy URL for Playwright
    const proxyConfig = await Actor.createProxyConfiguration();
    const proxyUrl = await proxyConfig.newUrl(); // e.g., http://user:pass@host:port

    const browser = await chromium.launch({
        headless: true,
        proxy: { server: proxyUrl },
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                   'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                   'Chrome/115.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
    });

    context.setDefaultTimeout(60000); // extend default timeout

    const page = await context.newPage();

    // Random delay helper
    const waitRandom = (min = 300, max = 1000) =>
        page.waitForTimeout(min + Math.random() * (max - min));

    // --- LinkedIn Login ---
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle' });

    // Handle possible iframe embedding
    let frame = page;
    if (page.frames().length > 1) {
        frame = page.frame({ url: /linkedin\.com\/checkpoint/ }) || page;
        console.log('Using login iframe due to bot check');
    }

    await frame.waitForSelector('input[name="session_key"]');
    await waitRandom();
    await frame.fill('input[name="session_key"]', username);
    await waitRandom();
    await frame.fill('input[name="session_password"]', password);
    await waitRandom(800, 1500);
    await frame.click('button[type="submit"]');
    await waitRandom(2000, 5000);

    if (await frame.$('iframe[src*="captcha"]')) {
        const screenshot = await page.screenshot({ fullPage: true });
        await Actor.setValue('captcha-detected.png', screenshot, { contentType: 'image/png' });
        await Actor.fail('CAPTCHA detected; screenshot saved.');
    }

    try {
        await page.waitForSelector('.feed-identity-module', { timeout: 60000 });
        console.log('✅ LinkedIn login successful');
    } catch {
        const screenshot = await page.screenshot({ fullPage: true });
        await Actor.setValue('login-failed.png', screenshot, { contentType: 'image/png' });
        await Actor.fail('Login failed; screenshot saved.');
    }

    // --- Navigate and Scrape Post ---
    await page.goto(postUrl, { waitUntil: 'networkidle' });
    await waitRandom();

    const urn = postUrl.match(/urn:li:activity:\d+/)?.[0];
    if (!urn) await Actor.fail('Cannot extract URN from postUrl');

    const selector = `div[data-urn="${urn}"]`;
    try {
        await page.waitForSelector(selector, { timeout: 60000 });
    } catch {
        const screenshot = await page.screenshot({ fullPage: true });
        await Actor.setValue('post-notfound.png', screenshot, { contentType: 'image/png' });
        await Actor.fail('Post container not found; screenshot saved.');
    }

    const postData = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.querySelector('.see-more-less-html__button')?.click();
        const txt = s => el.querySelector(s)?.innerText.trim() || '';
        const attr = (s, a) => el.querySelector(s)?.getAttribute(a) || '';
        return {
            postUrl: window.location.href,
            authorName: txt('.update-components-actor__name .visually-hidden'),
            authorUrl: attr('.update-components-actor__meta-link', 'href'),
            timestamp: txt('.update-components-actor__sub-description'),
            postText: txt('.update-components-text'),
            likes: txt('.social-details-social-counts__reactions-count'),
            commentsCount: txt('.social-details-social-counts__comments'),
        };
    }, selector);

    if (!postData) {
        await Actor.fail('Failed to extract post data.');
    }

    await Actor.pushData(postData);
    console.log('✅ Post scraped successfully');
    await browser.close();
});
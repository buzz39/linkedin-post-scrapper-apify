import { Actor, log } from 'apify';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Add this before browser launch:
chromium.use(StealthPlugin());

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

await Actor.main(async () => {
    try {
        const { postUrl } = await Actor.getInput();
        const username = process.env.linkedin_username;
        const password = process.env.linkedin_password;

        log.info(`Starting LinkedIn scrape for: ${postUrl}`);

        if (!postUrl || !username || !password) {
            await Actor.fail('Missing postUrl, LinkedIn username, or password in environment variables.');
        }

        // Proxy configuration
        const proxyConfig = await Actor.createProxyConfiguration();
        const proxyUrl = await proxyConfig.newUrl();

        const browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
            ],
            proxy: {
                server: proxyUrl
            }
        });

        const context = await browser.newContext({
            userAgent: getRandomUserAgent(),
            viewport: { width: 1920, height: 1080 },
        });

    context.setDefaultTimeout(60000);

    const page = await context.newPage();

    // --- LinkedIn Login with Retry Logic ---
    const MAX_RETRIES = 3;
    const INITIAL_DELAY = 2000;

    async function loginToLinkedIn(page, frame, username, password, retryCount = 0) {
        try {
            // Add random delay to appear more human-like
            await page.waitForTimeout(INITIAL_DELAY + Math.random() * 3000);

            // Wait for selector with longer timeout (120 seconds)
            await frame.waitForSelector('input[name="session_key"]', { timeout: 120000 });

            // Fill credentials with random delays between keystrokes
            await frame.fill('input[name="session_key"]', username);
            await page.waitForTimeout(800 + Math.random() * 400);

            // Use 'password' or 'session_password' - trying instructions' suggestion first
            // If checking fails, we might need to fallback, but let's stick to instructions.
            // Using a specific selector that likely matches.
            const passwordSelector = 'input[type="password"]';
            await frame.waitForSelector(passwordSelector);
            await frame.fill(passwordSelector, password);
            await page.waitForTimeout(800 + Math.random() * 400);

            // Click login button
            await frame.click('button[type="submit"]');

            // Wait for navigation
            await page.waitForNavigation({ timeout: 60000 });

            log.info('Successfully logged in to LinkedIn');
            return true;

        } catch (error) {
            log.error(`Login attempt ${retryCount + 1} failed: ${error.message}`);

            if (retryCount < MAX_RETRIES) {
                const delay = INITIAL_DELAY * Math.pow(2, retryCount);
                log.info(`Retrying login in ${delay}ms...`);
                await page.waitForTimeout(delay);
                return loginToLinkedIn(page, frame, username, password, retryCount + 1);
            } else {
                await Actor.fail(`Failed to login after ${MAX_RETRIES} attempts. LinkedIn may be blocking this automation.`);
            }
        }
    }

    await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle' });

    // Handle possible iframe embedding
    let frame = page;
    if (page.frames().length > 1) {
        frame = page.frame({ url: /linkedin\.com\/checkpoint/ }) || page;
        log.info('Using login iframe due to bot check');
    }

    await loginToLinkedIn(page, frame, username, password);

    // --- Navigate and Scrape Post ---
    log.info(`Navigating to post: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000 + Math.random() * 3000);

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
    log.info('✅ Post scraped successfully');
    await browser.close();

    } catch (error) {
        log.error(`Actor execution failed: ${error.message}`);
        log.error(`Stack: ${error.stack}`);
        await Actor.fail(`Fatal error: ${error.message}`);
    }
});
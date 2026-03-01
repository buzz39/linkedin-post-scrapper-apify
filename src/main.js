const { Actor } = require('apify');

function extractActivityId(url) {
    let match = url.match(/activity[- ](\d+)/i);
    if (match) return match[1];
    match = url.match(/urn:li:activity:(\d+)/);
    if (match) return match[1];
    match = url.match(/urn:li:ugcPost:(\d+)/);
    if (match) return match[1];
    return null;
}

function toFeedUrl(url) {
    const activityId = extractActivityId(url);
    if (activityId) return `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;
    return url;
}

async function extractPostData(page, originalUrl) {
    return page.evaluate((origUrl) => {
        const r = {
            success: false, url: origUrl,
            authorName: '', authorHeadline: '', authorProfileUrl: '',
            postText: '', timestamp: '',
            likeCount: 0, commentCount: 0, shareCount: 0,
            images: [], videoUrl: null,
            articleTitle: '', articleLink: '',
            hashtags: [], type: 'text',
            fetchedAt: new Date().toISOString(),
        };

        const qs = (s) => document.querySelector(s);
        const qsa = (s) => document.querySelectorAll(s);

        // Author
        const authorEl = qs('.update-components-actor__name span[dir="ltr"] span[aria-hidden="true"], .feed-shared-actor__name span[dir="ltr"] span[aria-hidden="true"], .feed-shared-actor__title span');
        if (authorEl) r.authorName = authorEl.textContent.trim();

        const headlineEl = qs('.update-components-actor__description span[dir="ltr"], .feed-shared-actor__description span[dir="ltr"]');
        if (headlineEl) r.authorHeadline = headlineEl.textContent.trim();

        const authorLink = qs('.update-components-actor__container-link, .feed-shared-actor__container-link, a.update-components-actor__meta-link');
        if (authorLink) r.authorProfileUrl = authorLink.href.split('?')[0];

        // Post text
        const textEl = qs('.feed-shared-update-v2__description .update-components-text, .update-components-text__text-view, .feed-shared-text__text-view, .break-words .update-components-text, [data-ad-preview="message"] span[dir="ltr"]');
        if (textEl) r.postText = textEl.innerText.trim();

        // Timestamp
        const timeEl = qs('.update-components-actor__sub-description span[aria-hidden="true"], .feed-shared-actor__sub-description span[aria-hidden="true"], time');
        if (timeEl) r.timestamp = timeEl.getAttribute('datetime') || timeEl.textContent.trim();

        // Social counts
        const socialBar = qs('.social-details-social-counts, .feed-shared-social-counts');
        if (socialBar) {
            const parse = (sel) => {
                const el = socialBar.querySelector(sel);
                return el ? parseInt(el.textContent.replace(/[^0-9]/g, '')) || 0 : 0;
            };
            r.likeCount = parse('.social-details-social-counts__reactions-count, button[aria-label*="reaction"], button[aria-label*="like"]');
            r.commentCount = parse('button[aria-label*="comment"]');
            r.shareCount = parse('button[aria-label*="repost"], button[aria-label*="share"]');
        }

        // Images
        qsa('.update-components-image__image img, .feed-shared-image__image img').forEach(img => {
            if (img.src && !img.src.includes('data:')) r.images.push(img.src);
        });

        // Video
        const videoEl = qs('video source, video[src]');
        if (videoEl) { r.videoUrl = videoEl.src || videoEl.getAttribute('src'); r.type = 'video'; }

        // Article
        const articleEl = qs('.update-components-article, .feed-shared-article');
        if (articleEl) {
            const titleEl = articleEl.querySelector('.update-components-article__title, .feed-shared-article__title');
            const linkEl = articleEl.querySelector('a');
            if (titleEl) r.articleTitle = titleEl.textContent.trim();
            if (linkEl) r.articleLink = linkEl.href;
            r.type = 'article';
        }

        if (r.postText) { const tags = r.postText.match(/#[\w\u00C0-\u024F]+/g); if (tags) r.hashtags = tags; }
        if (r.images.length > 0 && r.type === 'text') r.type = 'image';
        r.success = !!(r.postText || r.authorName);
        return r;
    }, originalUrl);
}


Actor.main(async () => {
    const input = await Actor.getInput() || {};
    const { postUrl, postUrls, li_at, jsessionid, email, password } = input;

    if (!li_at && !email) throw new Error('Provide either li_at cookie OR email+password for login');

    const urls = [];
    if (postUrl) urls.push(postUrl);
    if (Array.isArray(postUrls)) urls.push(...postUrls);
    if (urls.length === 0) throw new Error('Provide postUrl or postUrls');

    console.log(`📝 Scraping ${urls.length} LinkedIn post(s)...`);

    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });

    const { chromium } = require('playwright');

    const proxyUrl = await proxyConfiguration.newUrl();
    const [protocol, rest] = proxyUrl.split('://');
    const [proxyAuth, hostPort] = rest.split('@');
    const [proxyUser, proxyPass] = proxyAuth.split(':');

    const browser = await chromium.launch({
        headless: true,
        proxy: { server: `${protocol}://${hostPort}`, username: proxyUser, password: proxyPass },
        args: ['--disable-blink-features=AutomationControlled', '--disable-features=IsolateOrigins,site-per-process'],
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
    });

    const page = await context.newPage();

    // Anti-detection
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    try {
        // ===== AUTHENTICATION =====
        if (email && password) {
            console.log('🔐 Logging in with email/password...');
            await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(1000 + Math.random() * 2000);

            // Type email with human-like delays
            const emailInput = page.locator('#username');
            await emailInput.click();
            await page.waitForTimeout(300);
            for (const char of email) {
                await emailInput.type(char, { delay: 50 + Math.random() * 100 });
            }

            await page.waitForTimeout(500 + Math.random() * 500);

            // Type password
            const passwordInput = page.locator('#password');
            await passwordInput.click();
            await page.waitForTimeout(300);
            for (const char of password) {
                await passwordInput.type(char, { delay: 50 + Math.random() * 100 });
            }

            await page.waitForTimeout(500 + Math.random() * 1000);
            await page.locator('button[type="submit"]').click();

            await page.waitForTimeout(3000);
            await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

            const loginUrl = page.url();
            console.log(`  Post-login URL: ${loginUrl}`);

            if (loginUrl.includes('checkpoint') || loginUrl.includes('challenge')) {
                console.error('❌ LinkedIn requires verification (CAPTCHA/OTP)');
                const screenshot = await page.screenshot({ fullPage: true });
                await Actor.setValue('debug-challenge.png', screenshot, { contentType: 'image/png' });
                for (const url of urls) {
                    await Actor.pushData({ url, success: false, error: 'Verification challenge required', fetchedAt: new Date().toISOString() });
                }
                await browser.close();
                return;
            }

            if (loginUrl.includes('feed')) {
                console.log('✅ Login successful! On feed.');
            } else {
                console.log(`⚠️ Unexpected post-login URL: ${loginUrl}`);
                const screenshot = await page.screenshot();
                await Actor.setValue('debug-login-result.png', screenshot, { contentType: 'image/png' });
            }

        } else {
            // Cookie-based auth
            console.log('🔐 Using li_at cookie...');
            await context.addCookies([
                { name: 'li_at', value: li_at, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
                { name: 'JSESSIONID', value: jsessionid || `"ajax:${Date.now()}"`, domain: '.linkedin.com', path: '/', httpOnly: false, secure: true, sameSite: 'None' },
                { name: 'lang', value: 'v=2&lang=en-us', domain: '.linkedin.com', path: '/', secure: true, sameSite: 'None' },
            ]);

            console.log('📄 Loading LinkedIn feed...');
            await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle', timeout: 45000 });

            const feedUrl = page.url();
            console.log(`  Feed URL: ${feedUrl}`);

            if (feedUrl.includes('login') || feedUrl.includes('authwall') || feedUrl.includes('signup')) {
                console.error('❌ Cookie invalid — redirected to login');
                const screenshot = await page.screenshot();
                await Actor.setValue('debug-login.png', screenshot, { contentType: 'image/png' });
                for (const url of urls) {
                    await Actor.pushData({ url, success: false, error: 'Cookie invalid — redirected to login', fetchedAt: new Date().toISOString() });
                }
                await browser.close();
                return;
            }
        }

        // Debug: save feed state
        const feedHtml = await page.content();
        console.log(`  Feed HTML size: ${feedHtml.length} bytes`);
        const feedScreenshot = await page.screenshot({ fullPage: false });
        await Actor.setValue('debug-feed.png', feedScreenshot, { contentType: 'image/png' });

        await page.waitForTimeout(2000 + Math.random() * 2000);

        // ===== SCRAPE POSTS =====
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            const activityId = extractActivityId(url) || 'unknown';
            const targetUrl = toFeedUrl(url);
            console.log(`\n📝 [${i + 1}/${urls.length}] Navigating to: ${targetUrl}`);

            try {
                await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 45000 });

                const currentUrl = page.url();
                console.log(`  Current URL: ${currentUrl}`);

                if (currentUrl.includes('login') || currentUrl.includes('authwall')) {
                    console.error('  ❌ Redirected to login');
                    await Actor.pushData({ url, success: false, error: 'Redirected to login on post page', fetchedAt: new Date().toISOString() });
                    continue;
                }

                // Wait for content
                try {
                    await page.waitForSelector(
                        '.update-components-text, .feed-shared-text__text-view, .feed-shared-update-v2__description, .break-words, [data-urn], .scaffold-finite-scroll',
                        { timeout: 20000 }
                    );
                } catch {
                    console.log('  ⚠️ Content selector not found');
                }

                await page.waitForTimeout(3000);

                const result = await extractPostData(page, url);

                if (result.success) {
                    console.log(`  ✅ ${result.authorName}: ${result.postText.substring(0, 80)}...`);
                } else {
                    console.log('  ⚠️ Extraction failed, saving debug data');
                    const screenshot = await page.screenshot({ fullPage: true });
                    await Actor.setValue(`debug-post-${activityId}.png`, screenshot, { contentType: 'image/png' });
                    const html = await page.content();
                    await Actor.setValue(`debug-post-${activityId}.html`, html, { contentType: 'text/html' });
                    console.log(`  Debug HTML size: ${html.length} bytes`);
                    result.error = 'Content extraction failed — check debug files';
                    result.currentUrl = currentUrl;
                }

                await Actor.pushData(result);
            } catch (e) {
                console.error(`  ❌ Error: ${e.message}`);
                const screenshot = await page.screenshot().catch(() => null);
                if (screenshot) await Actor.setValue(`debug-error-${activityId}.png`, screenshot, { contentType: 'image/png' });
                await Actor.pushData({ url, success: false, error: e.message, fetchedAt: new Date().toISOString() });
            }

            if (i < urls.length - 1) await page.waitForTimeout(2000 + Math.random() * 3000);
        }
    } finally {
        await browser.close();
    }

    console.log('\n✅ Done!');
});

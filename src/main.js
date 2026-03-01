const { Actor } = require('apify');
const { PlaywrightCrawler } = require('crawlee');

Actor.main(async () => {
    const input = await Actor.getInput() || {};
    const { profileUrl, postUrl, postUrls, count = 10, li_at, jsessionid } = input;

    if (!li_at) {
        throw new Error('li_at cookie is required.');
    }

    const urls = [];
    if (postUrl) urls.push(postUrl);
    if (Array.isArray(postUrls)) urls.push(...postUrls);

    const cookies = [
        { name: 'li_at', value: li_at, domain: '.linkedin.com', path: '/', secure: true, httpOnly: true },
        { name: 'lang', value: 'v=2&lang=en-us', domain: '.linkedin.com', path: '/' },
    ];
    if (jsessionid) {
        cookies.push({ name: 'JSESSIONID', value: jsessionid.replace(/"/g, ''), domain: '.linkedin.com', path: '/', secure: true });
    }

    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });

    // ── Mode 1: Scrape individual posts ──
    if (urls.length > 0) {
        console.log(`Fetching ${urls.length} post(s) via browser...`);

        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxConcurrency: 1,
            requestHandlerTimeoutSecs: 90,
            headless: true,
            browserPoolOptions: {
                useFingerprints: true,
                fingerprintOptions: {
                    fingerprintGeneratorOptions: {
                        browsers: ['chrome'],
                        operatingSystems: ['windows'],
                        locales: ['en-US'],
                    },
                },
            },
            launchContext: {
                launchOptions: {
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--no-sandbox',
                    ],
                },
            },
            preNavigationHooks: [
                async ({ page, request }) => {
                    // Stealth: remove webdriver flag
                    await page.addInitScript(() => {
                        Object.defineProperty(navigator, 'webdriver', { get: () => false });
                        // Override plugins
                        Object.defineProperty(navigator, 'plugins', {
                            get: () => [1, 2, 3, 4, 5],
                        });
                        // Override languages
                        Object.defineProperty(navigator, 'languages', {
                            get: () => ['en-US', 'en'],
                        });
                        // Chrome runtime
                        window.chrome = { runtime: {} };
                    });

                    // Set cookies before navigation
                    await page.context().addCookies(cookies);

                    // Set realistic headers
                    await page.setExtraHTTPHeaders({
                        'Accept-Language': 'en-US,en;q=0.9',
                        'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
                        'sec-ch-ua-mobile': '?0',
                        'sec-ch-ua-platform': '"Windows"',
                    });
                },
            ],
            async requestHandler({ request, page, log }) {
                const targetUrl = request.userData.originalUrl;
                log.info(`Step 1: Loading LinkedIn feed to establish session...`);

                // First navigate to LinkedIn feed to establish session with cookies
                await page.goto('https://www.linkedin.com/feed/', { 
                    waitUntil: 'domcontentloaded',
                    timeout: 30000 
                });

                // Check if we're logged in
                await page.waitForTimeout(3000);
                const feedTitle = await page.title();
                log.info(`Feed page title: ${feedTitle}`);

                if (feedTitle.toLowerCase().includes('log in') || feedTitle.toLowerCase().includes('sign in')) {
                    log.error('❌ Not logged in — cookie may be invalid');
                    const screenshot = await page.screenshot({ fullPage: false });
                    await Actor.setValue(`debug-feed-${Date.now()}.png`, screenshot, { contentType: 'image/png' });
                    await Actor.pushData({
                        url: targetUrl,
                        success: false,
                        error: 'Login failed — li_at cookie is invalid or expired',
                        fetchedAt: new Date().toISOString(),
                    });
                    return;
                }

                log.info(`Step 2: Navigating to post...`);
                
                // Convert /posts/ URL to /feed/update/ format if needed
                // LinkedIn /posts/ URLs are client-side routes that 404 on server nav
                let navUrl = targetUrl;
                const activityMatch = targetUrl.match(/activity-(\d+)/);
                if (activityMatch) {
                    navUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${activityMatch[1]}/`;
                    log.info(`Converted to feed URL: ${navUrl}`);
                }
                
                await page.goto(navUrl, { 
                    waitUntil: 'domcontentloaded',
                    timeout: 30000 
                });

                // Wait for post content
                await page.waitForSelector('.feed-shared-update-v2, .update-components-text, .scaffold-finite-scroll__content', {
                    timeout: 15000,
                }).catch(() => {});

                await page.waitForTimeout(3000);

                // Try clicking "see more" if present
                const seeMore = await page.$('.feed-shared-inline-show-more-text button, .see-more-less-text button');
                if (seeMore) {
                    await seeMore.click().catch(() => {});
                    await page.waitForTimeout(1000);
                }

                const data = await page.evaluate(() => {
                    const authorEl = document.querySelector('.update-components-actor__title span[dir="ltr"] span[aria-hidden="true"], .update-components-actor__name span[aria-hidden="true"]');
                    const authorName = authorEl ? authorEl.textContent.trim() : 
                        (document.querySelector('.update-components-actor__title')?.textContent?.trim()?.split('\n')[0]?.trim() || '');

                    const headlineEl = document.querySelector('.update-components-actor__description span[aria-hidden="true"]');
                    const authorHeadline = headlineEl ? headlineEl.textContent.trim() :
                        (document.querySelector('.update-components-actor__description')?.textContent?.trim() || '');

                    let postText = '';
                    const textSelectors = [
                        '.update-components-text .break-words span[dir="ltr"]',
                        '.update-components-text .break-words',
                        '.feed-shared-update-v2__description .break-words',
                        '.feed-shared-text__text-view',
                    ];
                    for (const sel of textSelectors) {
                        const el = document.querySelector(sel);
                        if (el && el.textContent.trim().length > 10) {
                            postText = el.textContent.trim();
                            break;
                        }
                    }

                    const timeEl = document.querySelector('.update-components-actor__sub-description span[aria-hidden="true"]');
                    const timestamp = timeEl ? timeEl.textContent.trim() :
                        (document.querySelector('time')?.textContent?.trim() || '');

                    const reactionsEl = document.querySelector('.social-details-social-counts__reactions-count');
                    const commentsEl = document.querySelector('.social-details-social-counts__comments');
                    const parseCount = (el) => {
                        if (!el) return 0;
                        const text = el.textContent.replace(/[^0-9,]/g, '').replace(/,/g, '');
                        return parseInt(text || '0');
                    };

                    const images = [];
                    document.querySelectorAll('.update-components-image__container img').forEach(img => {
                        const src = img.src || img.getAttribute('data-delayed-url');
                        if (src && src.startsWith('http')) images.push(src);
                    });

                    const videoEl = document.querySelector('video');
                    const videoUrl = videoEl ? (videoEl.src || '') : '';

                    const articleEl = document.querySelector('.update-components-article');
                    const articleTitle = articleEl?.querySelector('.update-components-article__title')?.textContent?.trim() || '';
                    const articleLink = articleEl?.querySelector('a')?.href || '';

                    const hashtags = [];
                    document.querySelectorAll('a[href*="hashtag"]').forEach(a => hashtags.push(a.textContent.trim()));

                    return {
                        authorName, authorHeadline, postText, timestamp,
                        likeCount: parseCount(reactionsEl),
                        commentCount: parseCount(commentsEl),
                        images, videoUrl: videoUrl || null,
                        articleTitle, articleLink, hashtags,
                        pageTitle: document.title,
                    };
                });

                const result = {
                    url: targetUrl,
                    success: !!(data.postText || data.authorName),
                    ...data,
                    fetchedAt: new Date().toISOString(),
                };

                if (result.success) {
                    log.info(`✅ ${data.authorName}: ${data.postText.substring(0, 80)}...`);
                } else {
                    log.warning(`⚠️ Could not extract. Title: ${data.pageTitle}`);
                    const screenshot = await page.screenshot({ fullPage: false });
                    await Actor.setValue(`debug-${Date.now()}.png`, screenshot, { contentType: 'image/png' });

                    // Save page HTML for debugging
                    const html = await page.content();
                    await Actor.setValue(`debug-html-${Date.now()}.html`, html, { contentType: 'text/html' });

                    result.error = 'Could not extract post content';
                }

                await Actor.pushData(result);
            },
            async failedRequestHandler({ request }, error) {
                await Actor.pushData({
                    url: request.userData.originalUrl,
                    success: false,
                    error: error.message,
                    fetchedAt: new Date().toISOString(),
                });
            },
        });

        // Use feed URL as entry point, store actual target in userData
        await crawler.run(urls.map(url => ({ 
            url, 
            userData: { originalUrl: url },
            skipNavigation: true,  // We handle navigation manually
        })));
        return;
    }

    // ── Mode 2: Profile posts ──
    let username = profileUrl || input.username;
    if (!username) throw new Error('Provide postUrl, postUrls, or profileUrl');

    const match = username.match(/linkedin\.com\/in\/([^/?#]+)/);
    if (match) username = match[1];

    console.log(`Fetching ${count} posts for: ${username}`);

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 90,
        headless: true,
        browserPoolOptions: {
            useFingerprints: true,
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: ['chrome'],
                    operatingSystems: ['windows'],
                    locales: ['en-US'],
                },
            },
        },
        launchContext: {
            launchOptions: {
                args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
            },
        },
        preNavigationHooks: [
            async ({ page }) => {
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                    window.chrome = { runtime: {} };
                });
                await page.context().addCookies(cookies);
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'sec-ch-ua': '"Chromium";v="122", "Google Chrome";v="122"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"',
                });
            },
        ],
        async requestHandler({ page, log }) {
            // First establish session on feed
            await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);

            log.info(`Navigating to activity page for: ${username}`);
            await page.goto(`https://www.linkedin.com/in/${username}/recent-activity/all/`, {
                waitUntil: 'domcontentloaded', timeout: 30000
            });

            await page.waitForSelector('.scaffold-finite-scroll__content, .profile-creator-shared-feed-update', {
                timeout: 20000,
            }).catch(() => {});

            let lastCount = 0;
            for (let i = 0; i < 5; i++) {
                await page.evaluate(() => window.scrollBy(0, 2000));
                await page.waitForTimeout(2000);
                const currentCount = await page.evaluate(() => 
                    document.querySelectorAll('.feed-shared-update-v2').length
                );
                if (currentCount >= count || currentCount === lastCount) break;
                lastCount = currentCount;
            }

            const posts = await page.evaluate((maxCount) => {
                const results = [];
                const postEls = document.querySelectorAll('.feed-shared-update-v2');
                for (let i = 0; i < Math.min(postEls.length, maxCount); i++) {
                    const el = postEls[i];
                    const textEl = el.querySelector('.update-components-text .break-words');
                    const text = textEl ? textEl.textContent.trim() : '';
                    if (!text) continue;
                    const timeEl = el.querySelector('.update-components-actor__sub-description span[aria-hidden="true"]');
                    const urnEl = el.closest('[data-urn]');
                    const urn = urnEl ? urnEl.getAttribute('data-urn') : '';
                    const activityMatch = urn ? urn.match(/:(\d+)$/) : null;
                    const reactionsEl = el.querySelector('.social-details-social-counts__reactions-count');
                    const hashtags = [];
                    el.querySelectorAll('a[href*="hashtag"]').forEach(a => hashtags.push(a.textContent.trim()));
                    results.push({
                        postText: text,
                        timestamp: timeEl ? timeEl.textContent.trim() : '',
                        url: activityMatch ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityMatch[1]}/` : '',
                        likeCount: reactionsEl ? parseInt(reactionsEl.textContent.replace(/[^0-9]/g, '') || '0') : 0,
                        hashtags,
                    });
                }
                return results;
            }, count);

            if (posts.length === 0) {
                const screenshot = await page.screenshot({ fullPage: false });
                await Actor.setValue('debug-profile.png', screenshot, { contentType: 'image/png' });
                await Actor.pushData({ error: 'No posts found', username, fetchedAt: new Date().toISOString() });
                return;
            }

            log.info(`✅ Found ${posts.length} posts`);
            for (const post of posts) {
                await Actor.pushData({ ...post, authorUsername: username, success: true, fetchedAt: new Date().toISOString() });
            }
        },
    });

    await crawler.run([`https://www.linkedin.com/in/${username}/recent-activity/all/`]);
});

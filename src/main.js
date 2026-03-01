const { Actor } = require('apify');
const { PlaywrightCrawler } = require('crawlee');

Actor.main(async () => {
    const input = await Actor.getInput() || {};
    const { profileUrl, postUrl, postUrls, count = 10, li_at, jsessionid } = input;

    if (!li_at) {
        throw new Error('li_at cookie is required. Get it from your LinkedIn browser session (DevTools → Application → Cookies → li_at)');
    }

    // Collect all post URLs
    const urls = [];
    if (postUrl) urls.push(postUrl);
    if (Array.isArray(postUrls)) urls.push(...postUrls);

    const cookies = [
        { name: 'li_at', value: li_at, domain: '.linkedin.com', path: '/' },
    ];
    if (jsessionid) {
        cookies.push({ name: 'JSESSIONID', value: jsessionid.replace(/"/g, ''), domain: '.linkedin.com', path: '/' });
    }

    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });

    // ── Mode 1: Scrape individual posts ──
    if (urls.length > 0) {
        console.log(`Fetching ${urls.length} post(s)...`);

        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxConcurrency: 2,
            requestHandlerTimeoutSecs: 60,
            browserPoolOptions: {
                useFingerprints: true,
            },
            preNavigationHooks: [
                async ({ page }) => {
                    await page.context().addCookies(cookies);
                },
            ],
            async requestHandler({ request, page, log }) {
                const originalUrl = request.userData.originalUrl;
                log.info(`Processing: ${originalUrl}`);

                // Wait for content
                await page.waitForSelector('.feed-shared-update-v2, .update-components-text, .scaffold-finite-scroll', {
                    timeout: 20000,
                }).catch(() => {});

                // Additional wait for dynamic content
                await page.waitForTimeout(3000);

                const data = await page.evaluate(() => {
                    // Author
                    const authorEl = document.querySelector('.update-components-actor__title span[dir="ltr"] span[aria-hidden="true"], .update-components-actor__name span[aria-hidden="true"]');
                    const authorName = authorEl ? authorEl.textContent.trim() : 
                        (document.querySelector('.update-components-actor__title')?.textContent?.trim()?.split('\n')[0]?.trim() || '');

                    const headlineEl = document.querySelector('.update-components-actor__description span[aria-hidden="true"]');
                    const authorHeadline = headlineEl ? headlineEl.textContent.trim() :
                        (document.querySelector('.update-components-actor__description')?.textContent?.trim() || '');

                    // Post text - try multiple selectors
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

                    // Timestamp
                    const timeEl = document.querySelector('.update-components-actor__sub-description span[aria-hidden="true"]');
                    const timestamp = timeEl ? timeEl.textContent.trim() :
                        (document.querySelector('time')?.textContent?.trim() || '');

                    // Social counts
                    const reactionsEl = document.querySelector('.social-details-social-counts__reactions-count');
                    const commentsEl = document.querySelector('[data-test-id="social-actions__comments"], .social-details-social-counts__comments');
                    const repostsEl = document.querySelector('.social-details-social-counts__item--with-social-proof');
                    
                    const parseCount = (el) => {
                        if (!el) return 0;
                        const text = el.textContent.replace(/[^0-9,]/g, '').replace(/,/g, '');
                        return parseInt(text || '0');
                    };

                    // Images
                    const images = [];
                    document.querySelectorAll('.update-components-image__container img, .ivm-view-attr__img--centered').forEach(img => {
                        const src = img.src || img.getAttribute('data-delayed-url');
                        if (src && src.startsWith('http') && !src.includes('profile-displayphoto') && !src.includes('company-logo')) {
                            images.push(src);
                        }
                    });

                    // Video
                    const videoEl = document.querySelector('video');
                    const videoUrl = videoEl ? (videoEl.src || videoEl.querySelector('source')?.src || '') : '';

                    // Article link
                    const articleEl = document.querySelector('.update-components-article');
                    const articleTitle = articleEl?.querySelector('.update-components-article__title')?.textContent?.trim() || '';
                    const articleLink = articleEl?.querySelector('a')?.href || '';

                    // Hashtags
                    const hashtags = [];
                    document.querySelectorAll('a[href*="hashtag"]').forEach(a => {
                        hashtags.push(a.textContent.trim());
                    });

                    return {
                        authorName,
                        authorHeadline,
                        postText,
                        timestamp,
                        likeCount: parseCount(reactionsEl),
                        commentCount: parseCount(commentsEl),
                        images,
                        videoUrl: videoUrl || null,
                        articleTitle,
                        articleLink,
                        hashtags,
                        pageTitle: document.title,
                    };
                });

                const result = {
                    url: originalUrl,
                    success: !!(data.postText || data.authorName),
                    ...data,
                    fetchedAt: new Date().toISOString(),
                };

                if (result.success) {
                    log.info(`✅ ${data.authorName}: ${data.postText.substring(0, 80)}...`);
                } else {
                    log.warning(`⚠️ Could not extract content. Page title: ${data.pageTitle}`);
                    // Take a screenshot for debugging
                    const screenshot = await page.screenshot({ fullPage: false });
                    const key = `debug-${Date.now()}.png`;
                    await Actor.setValue(key, screenshot, { contentType: 'image/png' });
                    log.info(`Debug screenshot saved as ${key}`);
                    result.error = 'Could not extract post content';
                }

                await Actor.pushData(result);
            },
            async failedRequestHandler({ request }, error) {
                console.error(`❌ Failed: ${request.userData.originalUrl} — ${error.message}`);
                await Actor.pushData({
                    url: request.userData.originalUrl,
                    success: false,
                    error: error.message,
                    fetchedAt: new Date().toISOString(),
                });
            },
        });

        await crawler.run(urls.map(url => ({ url, userData: { originalUrl: url } })));
        return;
    }

    // ── Mode 2: Profile posts ──
    let username = profileUrl || input.username;
    if (!username) {
        throw new Error('Provide postUrl, postUrls, or profileUrl');
    }

    const match = username.match(/linkedin\.com\/in\/([^/?#]+)/);
    if (match) username = match[1];

    console.log(`Fetching ${count} posts for: ${username}`);

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 90,
        browserPoolOptions: {
            useFingerprints: true,
        },
        preNavigationHooks: [
            async ({ page }) => {
                await page.context().addCookies(cookies);
            },
        ],
        async requestHandler({ page, log }) {
            log.info(`Loading activity page for: ${username}`);

            await page.waitForSelector('.scaffold-finite-scroll__content, .profile-creator-shared-feed-update', {
                timeout: 20000,
            }).catch(() => {});

            // Scroll to load more posts
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
                    
                    // Text
                    const textEl = el.querySelector('.update-components-text .break-words');
                    const text = textEl ? textEl.textContent.trim() : '';
                    if (!text) continue;

                    // Time
                    const timeEl = el.querySelector('.update-components-actor__sub-description span[aria-hidden="true"]');
                    const timestamp = timeEl ? timeEl.textContent.trim() : '';

                    // Post URL
                    const urnEl = el.closest('[data-urn]');
                    const urn = urnEl ? urnEl.getAttribute('data-urn') : '';
                    const activityMatch = urn ? urn.match(/:(\d+)$/) : null;
                    const postUrl = activityMatch 
                        ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityMatch[1]}/`
                        : '';

                    // Reactions
                    const reactionsEl = el.querySelector('.social-details-social-counts__reactions-count');
                    const likeCount = reactionsEl ? parseInt(reactionsEl.textContent.replace(/[^0-9]/g, '') || '0') : 0;

                    // Hashtags
                    const hashtags = [];
                    el.querySelectorAll('a[href*="hashtag"]').forEach(a => hashtags.push(a.textContent.trim()));

                    results.push({ postText: text, timestamp, url: postUrl, likeCount, hashtags });
                }
                return results;
            }, count);

            if (posts.length === 0) {
                log.warning('No posts found');
                const screenshot = await page.screenshot({ fullPage: false });
                await Actor.setValue('debug-profile.png', screenshot, { contentType: 'image/png' });
                await Actor.pushData({
                    error: 'No posts found. Check debug screenshot in key-value store.',
                    username,
                    fetchedAt: new Date().toISOString(),
                });
                return;
            }

            log.info(`✅ Found ${posts.length} posts for ${username}`);
            for (const post of posts) {
                await Actor.pushData({
                    ...post,
                    authorUsername: username,
                    success: true,
                    fetchedAt: new Date().toISOString(),
                });
            }
        },
    });

    await crawler.run([`https://www.linkedin.com/in/${username}/recent-activity/all/`]);
});

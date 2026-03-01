const { Actor } = require('apify');
const { PlaywrightCrawler } = require('crawlee');

/**
 * Extract activity ID from various LinkedIn post URL formats
 */
function extractActivityId(url) {
    let match = url.match(/activity[- ](\d+)/i);
    if (match) return match[1];
    match = url.match(/urn:li:activity:(\d+)/);
    if (match) return match[1];
    match = url.match(/urn:li:ugcPost:(\d+)/);
    if (match) return match[1];
    return null;
}

/**
 * Convert any LinkedIn post URL to the feed/update format
 */
function toFeedUrl(url) {
    const activityId = extractActivityId(url);
    if (activityId) {
        return `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;
    }
    return url;
}

/**
 * Extract post data from the rendered LinkedIn page
 */
async function extractPostData(page, originalUrl) {
    return page.evaluate((origUrl) => {
        const result = {
            success: false,
            url: origUrl,
            authorName: '',
            authorHeadline: '',
            authorProfileUrl: '',
            postText: '',
            timestamp: '',
            likeCount: 0,
            commentCount: 0,
            shareCount: 0,
            images: [],
            videoUrl: null,
            articleTitle: '',
            articleLink: '',
            hashtags: [],
            type: 'text',
            fetchedAt: new Date().toISOString(),
        };

        // Author name
        const authorEl = document.querySelector(
            '.update-components-actor__name span[dir="ltr"] span[aria-hidden="true"], ' +
            '.feed-shared-actor__name span[dir="ltr"] span[aria-hidden="true"], ' +
            '.update-components-actor__title span[dir="ltr"] span[aria-hidden="true"], ' +
            '.feed-shared-actor__title span'
        );
        if (authorEl) result.authorName = authorEl.textContent.trim();

        // Author headline
        const headlineEl = document.querySelector(
            '.update-components-actor__description span[dir="ltr"], ' +
            '.feed-shared-actor__description span[dir="ltr"], ' +
            '.update-components-actor__supplementary-actor-info'
        );
        if (headlineEl) result.authorHeadline = headlineEl.textContent.trim();

        // Author profile URL
        const authorLink = document.querySelector(
            '.update-components-actor__container-link, ' +
            '.feed-shared-actor__container-link, ' +
            'a.update-components-actor__meta-link'
        );
        if (authorLink) result.authorProfileUrl = authorLink.href.split('?')[0];

        // Post text — multiple possible selectors
        const textEl = document.querySelector(
            '.feed-shared-update-v2__description .update-components-text, ' +
            '.update-components-text__text-view, ' +
            '.feed-shared-text__text-view, ' +
            '.break-words .update-components-text, ' +
            '[data-ad-preview="message"] span[dir="ltr"]'
        );
        if (textEl) {
            result.postText = textEl.innerText.trim();
        }

        // Timestamp
        const timeEl = document.querySelector(
            '.update-components-actor__sub-description span[aria-hidden="true"], ' +
            '.feed-shared-actor__sub-description span[aria-hidden="true"], ' +
            'time'
        );
        if (timeEl) {
            result.timestamp = timeEl.getAttribute('datetime') || timeEl.textContent.trim();
        }

        // Social counts — parse from the social bar
        const socialBar = document.querySelector(
            '.social-details-social-counts, ' +
            '.feed-shared-social-counts'
        );
        if (socialBar) {
            const reactionsEl = socialBar.querySelector(
                '.social-details-social-counts__reactions-count, ' +
                'button[aria-label*="reaction"], button[aria-label*="like"]'
            );
            if (reactionsEl) {
                const num = reactionsEl.textContent.replace(/[^0-9,]/g, '').replace(',', '');
                result.likeCount = parseInt(num) || 0;
            }

            const commentsEl = socialBar.querySelector(
                'button[aria-label*="comment"]'
            );
            if (commentsEl) {
                const num = commentsEl.textContent.replace(/[^0-9,]/g, '').replace(',', '');
                result.commentCount = parseInt(num) || 0;
            }

            const sharesEl = socialBar.querySelector(
                'button[aria-label*="repost"], button[aria-label*="share"]'
            );
            if (sharesEl) {
                const num = sharesEl.textContent.replace(/[^0-9,]/g, '').replace(',', '');
                result.shareCount = parseInt(num) || 0;
            }
        }

        // Images
        const imgEls = document.querySelectorAll(
            '.update-components-image__image img, ' +
            '.feed-shared-image__image img, ' +
            '.update-components-linkedin-video__container img'
        );
        imgEls.forEach(img => {
            if (img.src && !img.src.includes('data:')) {
                result.images.push(img.src);
            }
        });

        // Video
        const videoEl = document.querySelector(
            'video source, video[src]'
        );
        if (videoEl) {
            result.videoUrl = videoEl.src || videoEl.getAttribute('src');
            result.type = 'video';
        }

        // Article
        const articleEl = document.querySelector(
            '.update-components-article, .feed-shared-article'
        );
        if (articleEl) {
            const titleEl = articleEl.querySelector(
                '.update-components-article__title, .feed-shared-article__title'
            );
            const linkEl = articleEl.querySelector('a');
            if (titleEl) result.articleTitle = titleEl.textContent.trim();
            if (linkEl) result.articleLink = linkEl.href;
            result.type = 'article';
        }

        // Hashtags
        if (result.postText) {
            const tags = result.postText.match(/#[\w\u00C0-\u024F]+/g);
            if (tags) result.hashtags = tags;
        }

        // Type detection
        if (result.images.length > 0 && result.type === 'text') result.type = 'image';

        result.success = !!(result.postText || result.authorName);
        return result;
    }, originalUrl);
}


Actor.main(async () => {
    const input = await Actor.getInput() || {};
    const { postUrl, postUrls, li_at } = input;

    if (!li_at) {
        throw new Error('li_at cookie is required. Get it from DevTools → Application → Cookies → linkedin.com → li_at');
    }

    // Collect URLs
    const urls = [];
    if (postUrl) urls.push(postUrl);
    if (Array.isArray(postUrls)) urls.push(...postUrls);
    if (urls.length === 0) throw new Error('Provide postUrl or postUrls');

    console.log(`📝 Scraping ${urls.length} LinkedIn post(s)...`);

    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 60,
        browserPoolOptions: {
            maxOpenPagesPerBrowser: 1,
            retireBrowserAfterPageCount: 3,
        },
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=IsolateOrigins,site-per-process',
                ],
            },
        },
        preNavigationHooks: [
            async ({ page, request }, gotoOptions) => {
                // Remove webdriver flag
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                    // Fake Chrome runtime
                    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
                    // Fake plugins
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => [1, 2, 3, 4, 5],
                    });
                    Object.defineProperty(navigator, 'languages', {
                        get: () => ['en-US', 'en'],
                    });
                });

                // Inject li_at cookie into browser context
                const context = page.context();
                await context.addCookies([
                    {
                        name: 'li_at',
                        value: request.userData.li_at,
                        domain: '.linkedin.com',
                        path: '/',
                        httpOnly: true,
                        secure: true,
                        sameSite: 'None',
                    },
                    {
                        name: 'JSESSIONID',
                        value: `"ajax:${Date.now()}"`,
                        domain: '.linkedin.com',
                        path: '/',
                        httpOnly: false,
                        secure: true,
                        sameSite: 'None',
                    },
                    {
                        name: 'lang',
                        value: 'v=2&lang=en-us',
                        domain: '.linkedin.com',
                        path: '/',
                        secure: true,
                        sameSite: 'None',
                    },
                ]);
            },
        ],

        requestHandler: async ({ page, request, log }) => {
            const originalUrl = request.userData.originalUrl;
            const feedUrl = request.url;

            log.info(`Navigating to: ${feedUrl}`);

            // Wait for the page to load
            await page.waitForLoadState('domcontentloaded');
            await page.waitForTimeout(2000 + Math.random() * 2000);

            // Check if we're on a login page
            const currentUrl = page.url();
            if (currentUrl.includes('login') || currentUrl.includes('authwall') || currentUrl.includes('signup')) {
                log.error('Redirected to login page — cookie is invalid or expired');
                
                // Save screenshot for debugging
                const screenshot = await page.screenshot({ fullPage: false });
                await Actor.setValue(`debug-login-${request.userData.activityId}.png`, screenshot, { contentType: 'image/png' });
                
                await Actor.pushData({
                    url: originalUrl,
                    success: false,
                    error: 'Redirected to login — li_at cookie is invalid or expired',
                    fetchedAt: new Date().toISOString(),
                });
                return;
            }

            // Wait for post content to render
            try {
                await page.waitForSelector(
                    '.update-components-text, .feed-shared-text__text-view, .feed-shared-update-v2__description',
                    { timeout: 15000 }
                );
            } catch {
                log.warning('Post text selector not found, trying to extract anyway...');
            }

            // Small delay for dynamic content
            await page.waitForTimeout(1000);

            // Extract post data from DOM
            const result = await extractPostData(page, originalUrl);

            if (result.success) {
                log.info(`✅ ${result.authorName}: ${result.postText.substring(0, 80)}...`);
            } else {
                log.warning('Could not extract post content, saving debug screenshot');
                const screenshot = await page.screenshot({ fullPage: true });
                await Actor.setValue(`debug-nodata-${request.userData.activityId}.png`, screenshot, { contentType: 'image/png' });
                
                // Save HTML too
                const html = await page.content();
                await Actor.setValue(`debug-nodata-${request.userData.activityId}.html`, html, { contentType: 'text/html' });
                
                result.error = 'Post loaded but content extraction failed — check debug screenshots';
                result.currentUrl = currentUrl;
            }

            await Actor.pushData(result);
        },

        failedRequestHandler: async ({ request, log }) => {
            log.error(`Failed: ${request.url} — ${request.errorMessages.join(', ')}`);
            await Actor.pushData({
                url: request.userData.originalUrl,
                success: false,
                error: request.errorMessages.join(', '),
                fetchedAt: new Date().toISOString(),
            });
        },
    });

    // Build requests — navigate to feed URL format
    const requests = urls.map(url => {
        const activityId = extractActivityId(url);
        return {
            url: toFeedUrl(url),
            userData: {
                originalUrl: url,
                activityId: activityId || 'unknown',
                li_at,
            },
        };
    });

    await crawler.run(requests);

    console.log('\n✅ Done!');
});

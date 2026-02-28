const { Actor } = require('apify');
const { PlaywrightCrawler } = require('crawlee');
const { extractUrlsFromInput } = require('./utils');

Actor.main(async () => {
    const input = await Actor.getInput() || {};
    const { postUrl, postUrls = [], maxPosts = 10 } = input;

    // Collect all URLs to scrape
    const urls = extractUrlsFromInput({ postUrl, postUrls });

    if (urls.length === 0) {
        throw new Error(
            'No valid LinkedIn post URLs provided. Please provide either:\n' +
            '  - "postUrl": a single LinkedIn post URL\n' +
            '  - "postUrls": an array of LinkedIn post URLs\n\n' +
            'Supported URL formats:\n' +
            '  - https://www.linkedin.com/posts/username_slug-activity-1234567890\n' +
            '  - https://www.linkedin.com/feed/update/urn:li:activity:1234567890'
        );
    }

    console.log(`Processing ${urls.length} LinkedIn post URL(s)...`);

    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
    }).catch(() => {
        console.log('Residential proxy not available, trying default...');
        return Actor.createProxyConfiguration();
    }).catch(() => {
        console.log('No proxy available, running without proxy');
        return undefined;
    });

    const results = [];

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 60,
        headless: true,
        launchContext: {
            launchOptions: {
                args: ['--disable-blink-features=AutomationControlled'],
            },
        },
        async requestHandler({ page, request, log }) {
            log.info(`Scraping: ${request.url}`);

            // Wait for page to load
            await page.waitForTimeout(3000);

            // Dismiss login/signup modals and overlays
            const dismissSelectors = [
                'button[aria-label="Dismiss"]',
                'button[data-tracking-control-name="public_post_feed-cta-modal-dismiss"]',
                '.contextual-sign-in-modal__modal-dismiss',
                '.modal__dismiss',
                'button.cta-modal__dismiss-btn',
                '[data-test-id="modal-dismiss"]',
                'icon-close-medium',
            ];
            for (const sel of dismissSelectors) {
                try {
                    const btn = await page.$(sel);
                    if (btn) {
                        await btn.click();
                        log.info(`Dismissed modal: ${sel}`);
                        await page.waitForTimeout(1000);
                    }
                } catch {}
            }

            // Also try pressing Escape to close any modal
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);

            // Scroll down to trigger lazy loading
            await page.evaluate(() => window.scrollTo(0, 500));
            await page.waitForTimeout(2000);

            // Wait for post content to render
            try {
                await page.waitForSelector(
                    '.feed-shared-update-v2, .share-update-card, .attributed-text-segment-list__content, .update-components-text, [data-test-id="main-feed-activity-card"], .show-more-less-html__markup, .break-words',
                    { timeout: 15000 }
                );
            } catch {
                log.warning('Post content selector not found, trying to parse whatever loaded...');
                await page.waitForTimeout(3000);
            }

            const html = await page.content();

            // Debug: log page title and body text length to help diagnose issues
            const pageTitle = await page.title();
            log.info(`Page title: "${pageTitle}" | HTML length: ${html.length}`);

            const pageData = await page.evaluate(() => {
                // Extract data from the rendered DOM
                const getText = (selectors) => {
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el && el.innerText.trim()) return el.innerText.trim();
                    }
                    return '';
                };

                const getNumber = (text) => {
                    if (!text) return 0;
                    const match = text.replace(/,/g, '').match(/(\d+)/);
                    return match ? parseInt(match[1], 10) : 0;
                };

                // Post text — logged out view uses different selectors
                const postText = getText([
                    '.show-more-less-html__markup',
                    '.break-words .break-words span[dir="ltr"]',
                    '.break-words',
                    '.feed-shared-update-v2__description .break-words span[dir="ltr"]',
                    '.feed-shared-update-v2__description',
                    '.update-components-text__text-view span[dir="ltr"]',
                    '.update-components-text',
                    '.attributed-text-segment-list__content',
                    '[data-ad-preview="message"]',
                    '.share-update-card__update-text',
                    '.feed-shared-inline-show-more-text',
                ]);

                // Author — logged out view
                const authorName = getText([
                    '.top-card-layout__title',
                    '.base-main-card__title',
                    '.update-components-actor__name .hoverable-link-text span[aria-hidden="true"]',
                    '.update-components-actor__name',
                    '.feed-shared-actor__name',
                    '.share-update-card__actor-text',
                    'a.app-aware-link span[dir="ltr"]',
                ]);

                const authorTitle = getText([
                    '.top-card-layout__headline',
                    '.base-main-card__subtitle',
                    '.update-components-actor__description',
                    '.feed-shared-actor__description',
                    '.update-components-actor__supplementary-actor-info',
                ]);

                const authorProfileEl = document.querySelector(
                    '.update-components-actor__container-link, .feed-shared-actor__container-link'
                );
                const authorProfileUrl = authorProfileEl ? authorProfileEl.href : '';

                // Engagement
                const likesText = getText([
                    '.social-details-social-counts__reactions-count',
                    '.social-details-social-counts__social-proof-text',
                    '[data-test-id="social-actions__reaction-count"]',
                ]);

                const commentsText = getText([
                    '.social-details-social-counts__comments',
                    'button[aria-label*="comment"]',
                ]);

                const sharesText = getText([
                    '.social-details-social-counts__reposts',
                    'button[aria-label*="repost"]',
                ]);

                // Posted date
                const timeEl = document.querySelector(
                    '.update-components-actor__sub-description time, time.feed-shared-actor__sub-description'
                );
                const postedAt = timeEl ? (timeEl.getAttribute('datetime') || timeEl.innerText) : '';

                // Hashtags
                const hashtags = [...document.querySelectorAll('a[href*="hashtag"]')]
                    .map(a => a.innerText.trim())
                    .filter(Boolean);

                // Media
                const images = [...document.querySelectorAll(
                    '.feed-shared-image__image, .update-components-image__image, img[data-delayed-url]'
                )].map(img => ({
                    type: 'image',
                    url: img.src || img.getAttribute('data-delayed-url') || '',
                })).filter(m => m.url && !m.url.includes('profile-displayphoto'));

                const videos = [...document.querySelectorAll('video source, video')]
                    .map(v => ({
                        type: 'video',
                        url: v.src || v.getAttribute('data-sources') || '',
                    })).filter(m => m.url);

                return {
                    postText,
                    authorName,
                    authorTitle,
                    authorProfileUrl,
                    likesCount: getNumber(likesText),
                    commentsCount: getNumber(commentsText),
                    sharesCount: getNumber(sharesText),
                    postedAt,
                    hashtags,
                    media: [...images, ...videos],
                };
            });

            const result = {
                postUrl: request.url,
                ...pageData,
                scrapedAt: new Date().toISOString(),
            };

            // Validate we got meaningful data
            if (!result.postText && !result.authorName) {
                log.warning(`No content extracted from ${request.url} — LinkedIn may require login for this post`);
                result.error = 'Could not extract post content. The post may be private or require login.';
            }

            await Actor.pushData(result);
            results.push(result);
            log.info(`✅ Scraped: ${result.authorName || 'Unknown'} — ${(result.postText || '').substring(0, 80)}...`);
        },

        failedRequestHandler({ request, log }) {
            log.error(`Failed: ${request.url}`);
            Actor.pushData({
                postUrl: request.url,
                error: 'Failed to scrape this post after multiple retries',
                scrapedAt: new Date().toISOString(),
            });
        },
    });

    await crawler.run(urls);

    console.log(`\nDone! Scraped ${results.length}/${urls.length} posts successfully.`);
});

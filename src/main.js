const { Actor } = require('apify');
const { PlaywrightCrawler, ProxyConfiguration } = require('crawlee');

Actor.main(async () => {
    const input = await Actor.getInput() || {};
    const { profileUrl, postUrl, postUrls, count = 10 } = input;

    // Collect all post URLs
    const urls = [];
    if (postUrl) urls.push(postUrl);
    if (Array.isArray(postUrls)) urls.push(...postUrls);

    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });

    // ── Mode 1: Scrape individual posts ──
    if (urls.length > 0) {
        console.log(`Fetching ${urls.length} post(s) via browser...`);

        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxConcurrency: 2,
            requestHandlerTimeoutSecs: 60,
            browserPoolOptions: {
                useFingerprints: true,
            },
            async requestHandler({ request, page, log }) {
                const originalUrl = request.userData.originalUrl;
                log.info(`Processing: ${originalUrl}`);

                // Wait for the post content to load
                await page.waitForSelector('.feed-shared-update-v2, .scaffold-finite-scroll__content, .update-components-text', {
                    timeout: 15000,
                }).catch(() => {});

                // Check if we hit a login wall
                const loginWall = await page.$('.join-form, .sign-in-form, [data-tracking-control-name="public_post_join-cta"]');
                
                // Extract post data from the page
                const data = await page.evaluate(() => {
                    // Author info
                    const authorEl = document.querySelector('.update-components-actor__title, .top-card-layout__title, .base-main-card__title');
                    const authorName = authorEl ? authorEl.textContent.trim() : '';
                    
                    const headlineEl = document.querySelector('.update-components-actor__description, .top-card-layout__headline, .base-main-card__subtitle');
                    const authorHeadline = headlineEl ? headlineEl.textContent.trim() : '';

                    // Post text
                    const textEl = document.querySelector('.feed-shared-update-v2__description, .update-components-text, .attributed-text');
                    const postText = textEl ? textEl.textContent.trim() : '';

                    // Fallback: try getting text from any visible content area
                    const fallbackText = !postText ? (document.querySelector('.break-words, .feed-shared-text')?.textContent?.trim() || '') : postText;

                    // Timestamp
                    const timeEl = document.querySelector('.update-components-actor__sub-description, time, .top-card-layout__first-subline');
                    const timestamp = timeEl ? timeEl.textContent.trim() : '';

                    // Social counts
                    const likesEl = document.querySelector('.social-details-social-counts__reactions-count, .social-counts-reactions');
                    const commentsEl = document.querySelector('.social-details-social-counts__comments, .social-counts-comments');
                    
                    const likeCount = likesEl ? parseInt(likesEl.textContent.replace(/[^0-9]/g, '') || '0') : 0;
                    const commentCount = commentsEl ? parseInt(commentsEl.textContent.replace(/[^0-9]/g, '') || '0') : 0;

                    // Images
                    const images = [];
                    document.querySelectorAll('.update-components-image img, .feed-shared-image img').forEach(img => {
                        const src = img.src || img.getAttribute('data-delayed-url');
                        if (src && !src.includes('profile-photo') && !src.includes('/li/') && src.startsWith('http')) {
                            images.push(src);
                        }
                    });

                    // Article/link preview
                    const articleEl = document.querySelector('.update-components-article__title, .feed-shared-article__title');
                    const articleTitle = articleEl ? articleEl.textContent.trim() : '';
                    const articleLink = document.querySelector('.update-components-article a, .feed-shared-article a')?.href || '';

                    return {
                        authorName,
                        authorHeadline,
                        postText: postText || fallbackText,
                        timestamp,
                        likeCount,
                        commentCount,
                        images,
                        articleTitle,
                        articleLink,
                        pageTitle: document.title,
                    };
                });

                const result = {
                    url: originalUrl,
                    success: !!(data.postText || data.authorName),
                    ...data,
                    loginWallDetected: !!loginWall,
                    fetchedAt: new Date().toISOString(),
                };

                if (result.success) {
                    log.info(`✅ ${data.authorName}: ${data.postText.substring(0, 80)}...`);
                } else {
                    log.warning(`⚠️ Could not extract content. Page title: ${data.pageTitle}`);
                    result.error = 'Could not extract post content — may require login';
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

        const requests = urls.map(url => ({
            url,
            userData: { originalUrl: url },
        }));

        await crawler.run(requests);
        return;
    }

    // ── Mode 2: Profile posts ──
    let username = profileUrl || input.username;
    if (!username) {
        throw new Error(
            'No input provided. Use one of:\n' +
            '  - "profileUrl": LinkedIn profile URL or username\n' +
            '  - "postUrl": single LinkedIn post URL\n' +
            '  - "postUrls": array of LinkedIn post URLs'
        );
    }

    const match = username.match(/linkedin\.com\/in\/([^/?#]+)/);
    if (match) username = match[1];

    console.log(`Fetching recent posts for profile: ${username}`);

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 90,
        browserPoolOptions: {
            useFingerprints: true,
        },
        async requestHandler({ page, log }) {
            log.info(`Loading activity page for: ${username}`);

            // Wait for posts to load
            await page.waitForSelector('.scaffold-finite-scroll__content, .profile-creator-shared-feed-update', {
                timeout: 20000,
            }).catch(() => {});

            // Scroll a few times to load more posts
            for (let i = 0; i < 3; i++) {
                await page.evaluate(() => window.scrollBy(0, 1500));
                await page.waitForTimeout(2000);
            }

            const posts = await page.evaluate((maxCount) => {
                const results = [];
                const postEls = document.querySelectorAll('.feed-shared-update-v2, .profile-creator-shared-feed-update__container, [data-urn]');
                
                for (let i = 0; i < Math.min(postEls.length, maxCount); i++) {
                    const el = postEls[i];
                    const textEl = el.querySelector('.feed-shared-text, .update-components-text, .break-words');
                    const timeEl = el.querySelector('time, .update-components-actor__sub-description');
                    const linkEl = el.querySelector('a[href*="activity"]');
                    const likesEl = el.querySelector('.social-details-social-counts__reactions-count');
                    
                    const text = textEl ? textEl.textContent.trim() : '';
                    if (!text) continue;

                    results.push({
                        postText: text,
                        timestamp: timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim()) : '',
                        url: linkEl ? linkEl.href : '',
                        likeCount: likesEl ? parseInt(likesEl.textContent.replace(/[^0-9]/g, '') || '0') : 0,
                    });
                }
                return results;
            }, count);

            if (posts.length === 0) {
                log.warning('No posts found — LinkedIn may require login for this profile');
                await Actor.pushData({
                    error: 'No posts found. Profile may be private or requires authentication.',
                    username,
                    suggestion: 'Try individual post URLs with postUrl/postUrls parameter.',
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

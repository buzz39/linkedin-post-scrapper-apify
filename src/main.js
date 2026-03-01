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
    const { postUrl, postUrls, li_at, jsessionid } = input;

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

    // Use Playwright directly (not PlaywrightCrawler) for better control
    const { chromium } = require('playwright');

    const proxyUrl = await proxyConfiguration.newUrl();
    const [protocol, rest] = proxyUrl.split('://');
    const [auth, hostPort] = rest.split('@');
    const [username, password] = auth.split(':');

    const browser = await chromium.launch({
        headless: true,
        proxy: {
            server: `${protocol}://${hostPort}`,
            username,
            password,
        },
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
        ],
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
    });

    // Inject cookies BEFORE any navigation
    await context.addCookies([
        {
            name: 'li_at',
            value: li_at,
            domain: '.linkedin.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None',
        },
        {
            name: 'JSESSIONID',
            value: jsessionid || `"ajax:${Date.now()}"`,
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

    const page = await context.newPage();

    // Anti-detection
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    try {
        // Step 1: Load LinkedIn feed first to establish session
        console.log('🔐 Step 1: Loading LinkedIn feed to establish session...');
        const feedResponse = await page.goto('https://www.linkedin.com/feed/', {
            waitUntil: 'networkidle',
            timeout: 45000,
        });

        const feedUrl = page.url();
        console.log(`  Current URL: ${feedUrl} (status: ${feedResponse?.status()})`);

        if (feedUrl.includes('login') || feedUrl.includes('authwall') || feedUrl.includes('signup')) {
            console.error('❌ Cookie is invalid — redirected to login');
            const screenshot = await page.screenshot();
            await Actor.setValue('debug-login.png', screenshot, { contentType: 'image/png' });
            
            // Check if cookie was killed
            const cookies = await context.cookies('https://www.linkedin.com');
            const liAt = cookies.find(c => c.name === 'li_at');
            console.error(`  li_at cookie value: ${liAt?.value?.substring(0, 20)}...`);
            
            for (const url of urls) {
                await Actor.pushData({
                    url,
                    success: false,
                    error: 'li_at cookie is invalid or expired — redirected to login',
                    cookieStatus: liAt?.value?.includes('delete') ? 'KILLED' : 'present',
                    fetchedAt: new Date().toISOString(),
                });
            }
            await browser.close();
            return;
        }

        console.log('✅ Session established! On feed page.');
        
        // Debug: save feed screenshot + HTML size
        const feedHtml = await page.content();
        console.log(`  Feed HTML size: ${feedHtml.length} bytes`);
        const feedScreenshot = await page.screenshot({ fullPage: false });
        await Actor.setValue('debug-feed.png', feedScreenshot, { contentType: 'image/png' });
        
        await page.waitForTimeout(2000 + Math.random() * 2000);

        // Step 2: Navigate to each post
        for (const url of urls) {
            const activityId = extractActivityId(url);
            const postUrl = toFeedUrl(url);
            console.log(`\n📝 Step 2: Navigating to post: ${postUrl}`);

            try {
                await page.goto(postUrl, {
                    waitUntil: 'networkidle',
                    timeout: 45000,
                });

                const currentUrl = page.url();
                console.log(`  Current URL: ${currentUrl}`);

                if (currentUrl.includes('login') || currentUrl.includes('authwall')) {
                    console.error('  ❌ Redirected to login on post page');
                    await Actor.pushData({
                        url,
                        success: false,
                        error: 'Redirected to login when accessing post',
                        fetchedAt: new Date().toISOString(),
                    });
                    continue;
                }

                // Wait for post content
                try {
                    await page.waitForSelector(
                        '.update-components-text, .feed-shared-text__text-view, .feed-shared-update-v2__description, .break-words, [data-urn], .scaffold-finite-scroll',
                        { timeout: 20000 }
                    );
                } catch {
                    console.log('  ⚠️ Post text selector not found, extracting anyway...');
                }

                await page.waitForTimeout(3000);

                const result = await extractPostData(page, url);

                if (result.success) {
                    console.log(`  ✅ ${result.authorName}: ${result.postText.substring(0, 80)}...`);
                } else {
                    console.log('  ⚠️ Content extraction failed, saving debug data');
                    const screenshot = await page.screenshot({ fullPage: true });
                    await Actor.setValue(`debug-post-${activityId}.png`, screenshot, { contentType: 'image/png' });
                    const html = await page.content();
                    await Actor.setValue(`debug-post-${activityId}.html`, html, { contentType: 'text/html' });
                    result.error = 'Post loaded but content extraction failed';
                    result.currentUrl = currentUrl;
                }

                await Actor.pushData(result);
            } catch (e) {
                console.error(`  ❌ Failed: ${e.message}`);
                const screenshot = await page.screenshot().catch(() => null);
                if (screenshot) {
                    await Actor.setValue(`debug-error-${activityId}.png`, screenshot, { contentType: 'image/png' });
                }
                await Actor.pushData({
                    url,
                    success: false,
                    error: e.message,
                    fetchedAt: new Date().toISOString(),
                });
            }

            // Delay between posts
            if (urls.indexOf(url) < urls.length - 1) {
                await page.waitForTimeout(2000 + Math.random() * 3000);
            }
        }
    } finally {
        await browser.close();
    }

    console.log('\n✅ Done!');
});

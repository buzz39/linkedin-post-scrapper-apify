/**
 * Extract and validate LinkedIn post URLs from input
 */
function extractUrlsFromInput({ postUrl, postUrls = [] }) {
    const urls = [];

    if (postUrl && typeof postUrl === 'string') {
        urls.push(postUrl.trim());
    }

    if (Array.isArray(postUrls)) {
        for (const url of postUrls) {
            if (typeof url === 'string' && url.trim()) {
                urls.push(url.trim());
            }
        }
    }

    // Filter valid LinkedIn URLs
    return urls.filter(url => {
        try {
            const parsed = new URL(url);
            return parsed.hostname.includes('linkedin.com');
        } catch {
            console.warn(`Skipping invalid URL: ${url}`);
            return false;
        }
    });
}

module.exports = { extractUrlsFromInput };

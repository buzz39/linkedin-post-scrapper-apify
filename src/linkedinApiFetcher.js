import axios from 'axios';
import { createLinkedInHeaders } from './headers.js';
import { parseLinkedInHTML } from './parser.js';

const DEFAULT_MAX_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches LinkedIn post data using public APIs (NO LOGIN REQUIRED)
 *
 * @param {string} linkedinUrl - LinkedIn post URL or profile URL
 * @param {{ maxRetries?: number }} [options] - Fetch options
 * @returns {Promise<Object>} Parsed post/profile data
 * @throws {Error} If fetch fails
 */
export async function fetchLinkedInViaAPI(linkedinUrl, options = {}) {
  const headers = createLinkedInHeaders();
  const requestedRetries = Number.parseInt(options.maxRetries, 10);
  const maxRetries = Number.isNaN(requestedRetries)
    ? DEFAULT_MAX_RETRIES
    : Math.max(1, Math.min(5, requestedRetries));
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(linkedinUrl, {
        headers,
        timeout: 15000,
        validateStatus: (status) => status < 500, // Accept 4xx, reject 5xx
      });

      if (response.status === 200) {
        return parseLinkedInHTML(response.data);
      }

      if (response.status === 429) {
        throw new Error('Rate limited - waiting before retry');
      }

      if (response.status === 403) {
        throw new Error('Access denied - may need Apify Proxy');
      }

      if (response.status === 404) {
        throw new Error('Page not found (404)');
      }

      throw new Error(`Request failed with status ${response.status}`);
    } catch (error) {
      lastError = error;

      // Don't retry on known permanent errors
      if (error.message.includes('404') || error.message.includes('Access denied')) {
        throw error;
      }

      if (attempt < maxRetries) {
        const delay = 2 ** attempt * 1000; // Exponential backoff
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error('Unknown error occurred during fetch');
}

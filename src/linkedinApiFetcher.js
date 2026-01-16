import axios from 'axios';
import { createLinkedInHeaders } from './headers.js';
import { parseLinkedInHTML } from './parser.js';

/**
 * Fetches LinkedIn post data using public APIs (NO LOGIN REQUIRED)
 *
 * @param {string} linkedinUrl - LinkedIn post URL or profile URL
 * @returns {Promise<Object>} Parsed post/profile data
 * @throws {Error} If fetch fails
 */
export async function fetchLinkedInViaAPI(linkedinUrl) {
  const headers = createLinkedInHeaders();
  const maxRetries = 3;
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
      } else if (response.status === 429) {
        throw new Error('Rate limited - waiting before retry');
      } else if (response.status === 403) {
        throw new Error('Access denied - may need Apify Proxy');
      } else if (response.status === 404) {
        throw new Error('Page not found (404)');
      } else {
         throw new Error(`Request failed with status ${response.status}`);
      }
    } catch (error) {
      lastError = error;

      // Don't retry on 404 or known permanent errors
      if (error.message.includes('404')) {
          throw error;
      }

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Unknown error occurred during fetch');
}

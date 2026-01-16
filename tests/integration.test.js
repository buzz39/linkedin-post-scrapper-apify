import { jest } from '@jest/globals';

jest.unstable_mockModule('axios', () => ({
  default: {
    get: jest.fn(),
  }
}));

const axios = (await import('axios')).default;
const { fetchLinkedInViaAPI } = await import('../src/linkedinApiFetcher.js');

describe('LinkedIn API Fetcher', () => {

  // Increase timeout to 30s for the whole suite
  jest.setTimeout(30000);

  beforeEach(() => {
    jest.resetAllMocks(); // Use reset to clear implementation stack
  });

  test('Should fetch public profile successfully', async () => {
    const url = 'https://www.linkedin.com/in/satyanadella/';

    axios.get.mockResolvedValue({
      status: 200,
      data: '<html><head><meta property="og:title" content="Satya Nadella | LinkedIn"></head><body></body></html>'
    });

    const result = await fetchLinkedInViaAPI(url);

    expect(result).toHaveProperty('title', 'Satya Nadella | LinkedIn');
  });

  test('Should handle rate limiting (429) and retry', async () => {
    const url = 'https://www.linkedin.com/in/test/';

    axios.get
        .mockResolvedValueOnce({ status: 429 })
        .mockResolvedValueOnce({ status: 429 })
        .mockResolvedValueOnce({
            status: 200,
            data: '<html><meta property="og:title" content="Success"></html>'
        });

    // This will take approx 2s + 4s = 6s
    const result = await fetchLinkedInViaAPI(url);
    expect(result.title).toBe('Success');
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  test('Should throw error after max retries', async () => {
     const url = 'https://www.linkedin.com/in/fail/';

     axios.get.mockResolvedValue({ status: 429 });

     // This will take 2s + 4s + ? It fails on 3rd attempt?
     // Code:
     // attempt 1: fails, waits 2s
     // attempt 2: fails, waits 4s
     // attempt 3: fails, throws.
     // Total wait: 6s.
     await expect(fetchLinkedInViaAPI(url)).rejects.toThrow('Rate limited - waiting before retry');
     expect(axios.get).toHaveBeenCalledTimes(3);
  });

  test('Should throw error immediately on 404', async () => {
     const url = 'https://www.linkedin.com/in/notfound/';
     axios.get.mockResolvedValue({ status: 404 });

     await expect(fetchLinkedInViaAPI(url)).rejects.toThrow('Page not found (404)');
     expect(axios.get).toHaveBeenCalledTimes(1); // Should not retry
  });
});

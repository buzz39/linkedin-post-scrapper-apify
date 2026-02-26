import { jest } from '@jest/globals';

jest.unstable_mockModule('axios', () => ({
  default: {
    get: jest.fn(),
  }
}));

const axios = (await import('axios')).default;
const { fetchLinkedInViaAPI } = await import('../src/linkedinApiFetcher.js');

describe('LinkedIn API Fetcher', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(global, 'setTimeout').mockImplementation((handler) => {
      handler();
      return 0;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('should fetch public profile successfully', async () => {
    const url = 'https://www.linkedin.com/in/satyanadella/';

    axios.get.mockResolvedValue({
      status: 200,
      data: '<html><head><meta property="og:title" content="Satya Nadella | LinkedIn"></head><body></body></html>'
    });

    const result = await fetchLinkedInViaAPI(url);

    expect(result).toHaveProperty('title', 'Satya Nadella | LinkedIn');
  });

  test('should handle rate limiting (429) and retry', async () => {
    const url = 'https://www.linkedin.com/in/test/';

    axios.get
      .mockResolvedValueOnce({ status: 429 })
      .mockResolvedValueOnce({ status: 429 })
      .mockResolvedValueOnce({
        status: 200,
        data: '<html><meta property="og:title" content="Success"></html>'
      });

    const result = await fetchLinkedInViaAPI(url);
    expect(result.title).toBe('Success');
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  test('should throw error after max retries', async () => {
    const url = 'https://www.linkedin.com/in/fail/';

    axios.get.mockResolvedValue({ status: 429 });

    await expect(fetchLinkedInViaAPI(url)).rejects.toThrow('Rate limited - waiting before retry');
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  test('should throw error immediately on 404', async () => {
    const url = 'https://www.linkedin.com/in/notfound/';
    axios.get.mockResolvedValue({ status: 404 });

    await expect(fetchLinkedInViaAPI(url)).rejects.toThrow('Page not found (404)');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('should throw error immediately on 403', async () => {
    const url = 'https://www.linkedin.com/in/forbidden/';
    axios.get.mockResolvedValue({ status: 403 });

    await expect(fetchLinkedInViaAPI(url)).rejects.toThrow('Access denied - may need Apify Proxy');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('should honor maxRetries from options', async () => {
    const url = 'https://www.linkedin.com/in/custom-retries/';
    axios.get.mockResolvedValue({ status: 429 });

    await expect(fetchLinkedInViaAPI(url, { maxRetries: 2 })).rejects.toThrow('Rate limited - waiting before retry');
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});

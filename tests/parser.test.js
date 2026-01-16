import { parseLinkedInHTML } from '../src/parser.js';

describe('LinkedIn HTML Parser', () => {
  test('Should extract title from OpenGraph meta tags', () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="Test Title">
          <meta property="og:description" content="Test Description">
          <meta property="og:image" content="http://example.com/image.jpg">
          <meta property="og:url" content="http://example.com/post">
          <meta property="og:type" content="article">
        </head>
        <body></body>
      </html>
    `;
    const result = parseLinkedInHTML(html);
    expect(result.title).toBe('Test Title');
    expect(result.description).toBe('Test Description');
    expect(result.image).toBe('http://example.com/image.jpg');
    expect(result.url).toBe('http://example.com/post');
    expect(result.type).toBe('article');
  });

  test('Should fallback to h1 for title', () => {
    const html = `
      <html>
        <body>
          <h1>Fallback Title</h1>
        </body>
      </html>
    `;
    const result = parseLinkedInHTML(html);
    expect(result.title).toBe('Fallback Title');
  });

  test('Should parse structured data (JSON-LD)', () => {
    const jsonLd = {
      "@context": "http://schema.org",
      "@type": "SocialMediaPosting",
      "headline": "Structured Headline"
    };
    const html = `
      <html>
        <head>
          <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
        </head>
        <body></body>
      </html>
    `;
    const result = parseLinkedInHTML(html);
    expect(result.structured).toEqual(jsonLd);
  });
});

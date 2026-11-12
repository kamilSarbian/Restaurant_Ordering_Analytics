import { readFileSync } from 'node:fs';

describe('static search metadata', () => {
  it('publishes Nordic Hearth metadata without promoting private routes', () => {
    const index = readFileSync('index.html', 'utf8');
    const robots = readFileSync('public/robots.txt', 'utf8');

    expect(index).toContain('<title>Nordic Hearth | Restaurant ordering demo</title>');
    expect(index).toContain('rel="canonical" href="https://nordic.kamilsarbian.dev/"');
    expect(index).toContain('property="og:title" content="Nordic Hearth');
    expect(index).toContain('name="twitter:card" content="summary_large_image"');
    expect(robots).toContain('Allow: /menu');
    for (const path of ['/account', '/admin', '/cart', '/login', '/orders']) {
      expect(robots).toContain(`Disallow: ${path}`);
    }
  });
});

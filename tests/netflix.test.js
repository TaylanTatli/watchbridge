import test from 'node:test';
import assert from 'node:assert/strict';
import { netflixProvider } from '../src/providers/netflix/index.js';

test('Netflix keeps the known working Falcor progress request shape', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/WiViewingActivity')) {
      return {
        ok: true,
        async text() { return '<script>{"userGuid":"PROFILE-GUID"}</script>'; }
      };
    }
    if (String(url).includes('/api/aui/pathEvaluator/')) {
      return {
        ok: true,
        async json() {
          return {
            jsonGraph: {
              aui: {
                viewingActivity: {
                  value: {
                    viewedItems: [{
                      movieID: 81234567,
                      date: 1767225600000,
                      title: 'Episode title',
                      series: 80000001,
                      seriesTitle: 'Series title',
                      episodeTitle: 'Episode title'
                    }]
                  }
                }
              }
            }
          };
        }
      };
    }
    if (String(url).includes('/nq/website/memberapi/release/pathEvaluator')) {
      const requestUrl = new URL(url);
      assert.equal(requestUrl.searchParams.get('original_path'), '/shakti/mre/pathEvaluator');
      const body = new URLSearchParams(options.body);
      assert.equal(body.has('authURL'), false);
      assert.deepEqual(JSON.parse(body.get('path')), [
        'videos',
        ['81234567'],
        ['summary', 'runtime', 'bookmarkPosition']
      ]);
      return {
        ok: true,
        async json() {
          return {
            jsonGraph: {
              videos: {
                81234567: {
                  runtime: { value: 1000 },
                  bookmarkPosition: { value: 800 },
                  summary: { value: { seasonNumber: 2, episodeNumber: 4 } }
                }
              }
            }
          };
        }
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await netflixProvider.fetchEvents({ threshold: 70, maxPages: 1 });
    assert.equal(result.scanned, 1);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].progress, 80);
    assert.equal(result.events[0].season, 2);
    assert.equal(result.events[0].episode, 4);
    assert.equal(requests.length, 3);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

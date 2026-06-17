import {
  computeRelevance,
  combinedRelevance,
  jaccardSimilarity,
  shouldApproach,
  getInteractionType,
  computeRelevanceMatrix,
  THRESHOLDS,
} from '../collaboration/relevance.js';

describe('jaccardSimilarity', () => {
  test('returns 0 for empty sets', () => {
    expect(jaccardSimilarity([], [])).toBe(0);
    expect(jaccardSimilarity(null, ['a'])).toBe(0);
    expect(jaccardSimilarity(['a'], null)).toBe(0);
  });

  test('returns 1 for identical sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  test('returns 0 for disjoint sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  test('returns correct ratio for partial overlap', () => {
    expect(jaccardSimilarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(0.5);
  });
});

describe('computeRelevance', () => {
  test('returns 0 for agents with no matching needs/offers/keywords', () => {
    const a = { needs: ['frontend'], offers: ['backend'], keywords: ['node'] };
    const b = { needs: ['design'], offers: ['css'], keywords: ['react'] };
    expect(computeRelevance(a, b)).toBe(0);
  });

  test('scores NEEDS_OFFERS when A needs what B offers', () => {
    const a = { needs: ['auth'], offers: [], keywords: [] };
    const b = { needs: [], offers: ['auth spec'], keywords: [] };
    expect(computeRelevance(a, b)).toBe(THRESHOLDS.NEEDS_OFFERS);
  });

  test('scores OFFERS_NEEDS when B needs what A offers', () => {
    const a = { needs: [], offers: ['test cases'], keywords: [] };
    const b = { needs: ['test'], offers: [], keywords: [] };
    expect(computeRelevance(a, b)).toBe(THRESHOLDS.OFFERS_NEEDS);
  });

  test('scores keyword overlap', () => {
    const a = { needs: [], offers: [], keywords: ['auth', 'jwt', 'token'] };
    const b = { needs: [], offers: [], keywords: ['auth', 'jwt', 'oauth'] };
    expect(computeRelevance(a, b)).toBe(THRESHOLDS.KEYWORD_MATCH * 2);
  });

  test('combines all scoring factors', () => {
    const a = { needs: ['frontend consumer'], offers: ['auth spec'], keywords: ['auth', 'jwt'] };
    const b = { needs: ['auth'], offers: ['frontend'], keywords: ['auth', 'react'] };
    const score = computeRelevance(a, b);
    expect(score).toBeGreaterThan(0);
    expect(score).toBe(
      THRESHOLDS.NEEDS_OFFERS +
      THRESHOLDS.OFFERS_NEEDS +
      THRESHOLDS.KEYWORD_MATCH
    );
  });

  test('handles missing arrays gracefully', () => {
    expect(computeRelevance({}, {})).toBe(0);
  });
});

describe('combinedRelevance', () => {
  test('returns base score for empty memory', () => {
    const observer = { keywords: ['auth'], needs: [], offers: [] };
    const memory = {
      domainTags: [],
      typicalOffers: [],
      typicalNeeds: [],
      totalMingles: 0,
      successfulMingles: 0,
      lastMingleTs: null,
    };
    const score = combinedRelevance(observer, {}, memory);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test('increases with domain tag overlap', () => {
    const observer = { keywords: ['auth', 'jwt', 'token'], needs: [], offers: [] };
    const memoryLow = { domainTags: ['react'], typicalOffers: [], typicalNeeds: [], totalMingles: 0, successfulMingles: 0, lastMingleTs: null };
    const memoryHigh = { domainTags: ['auth', 'jwt', 'token'], typicalOffers: [], typicalNeeds: [], totalMingles: 0, successfulMingles: 0, lastMingleTs: null };
    expect(combinedRelevance(observer, {}, memoryHigh)).toBeGreaterThan(combinedRelevance(observer, {}, memoryLow));
  });

  test('increases with successful mingles', () => {
    const observer = { keywords: [], needs: [], offers: [] };
    const memoryBad = { domainTags: [], typicalOffers: [], typicalNeeds: [], totalMingles: 10, successfulMingles: 1, lastMingleTs: null };
    const memoryGood = { domainTags: [], typicalOffers: [], typicalNeeds: [], totalMingles: 10, successfulMingles: 9, lastMingleTs: null };
    expect(combinedRelevance(observer, {}, memoryGood)).toBeGreaterThan(combinedRelevance(observer, {}, memoryBad));
  });

  test('recency boost increases for recent mingles', () => {
    const observer = { keywords: [], needs: [], offers: [] };
    const recentMemory = { domainTags: [], typicalOffers: [], typicalNeeds: [], totalMingles: 1, successfulMingles: 1, lastMingleTs: new Date().toISOString() };
    const oldMemory = { domainTags: [], typicalOffers: [], typicalNeeds: [], totalMingles: 1, successfulMingles: 1, lastMingleTs: '2020-01-01T00:00:00.000Z' };
    expect(combinedRelevance(observer, {}, recentMemory)).toBeGreaterThan(combinedRelevance(observer, {}, oldMemory));
  });

  test('recency boost is 0 for very old mingles', () => {
    const observer = { keywords: [], needs: [], offers: [] };
    const oldMemory = { domainTags: [], typicalOffers: [], typicalNeeds: [], totalMingles: 0, successfulMingles: 0, lastMingleTs: '2020-01-01T00:00:00.000Z' };
    const noMingleMemory = { domainTags: [], typicalOffers: [], typicalNeeds: [], totalMingles: 0, successfulMingles: 0, lastMingleTs: null };
    expect(combinedRelevance(observer, {}, oldMemory)).toBe(combinedRelevance(observer, {}, noMingleMemory));
  });
});

describe('shouldApproach', () => {
  test('returns false for same agent', () => {
    expect(shouldApproach({ agentId: 'sage' }, { agentId: 'sage' }, 100)).toBe(false);
  });

  test('returns true when score meets APPROACH threshold', () => {
    expect(shouldApproach({ agentId: 'sage' }, { agentId: 'forge' }, THRESHOLDS.APPROACH)).toBe(true);
  });

  test('returns false when score below APPROACH threshold', () => {
    expect(shouldApproach({ agentId: 'sage' }, { agentId: 'forge' }, THRESHOLDS.APPROACH - 1)).toBe(false);
  });
});

describe('getInteractionType', () => {
  test('returns null below CHIT_CHAT threshold', () => {
    expect(getInteractionType(THRESHOLDS.CHIT_CHAT - 1)).toBeNull();
  });

  test('returns gossip at CHIT_CHAT threshold', () => {
    expect(getInteractionType(THRESHOLDS.CHIT_CHAT)).toBe('gossip');
  });

  test('returns chit_chat at MINGLE threshold', () => {
    expect(getInteractionType(THRESHOLDS.MINGLE)).toBe('chit_chat');
  });

  test('returns deep_talk at DEEP_TALK threshold', () => {
    expect(getInteractionType(THRESHOLDS.DEEP_TALK)).toBe('deep_talk');
  });
});

describe('computeRelevanceMatrix', () => {
  test('returns empty matrix for empty signals', () => {
    expect(computeRelevanceMatrix([])).toEqual({});
  });

  test('computes pairwise scores', () => {
    const signals = [
      { agentId: 'sage', needs: ['frontend'], offers: ['auth'], keywords: ['jwt'] },
      { agentId: 'forge', needs: ['auth'], offers: ['frontend'], keywords: ['jwt'] },
    ];
    const matrix = computeRelevanceMatrix(signals);
    expect(matrix.sage.forge).toBeGreaterThan(0);
    expect(matrix.forge.sage).toBeGreaterThan(0);
    expect(matrix.sage.sage).toBeUndefined();
  });

  test('matrix is not necessarily symmetric', () => {
    const signals = [
      { agentId: 'a', needs: ['x'], offers: [], keywords: [] },
      { agentId: 'b', needs: [], offers: ['x'], keywords: [] },
    ];
    const matrix = computeRelevanceMatrix(signals);
    expect(matrix.a.b).toBe(THRESHOLDS.NEEDS_OFFERS);
    expect(matrix.b.a).toBe(THRESHOLDS.OFFERS_NEEDS);
  });
});

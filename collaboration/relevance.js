const THRESHOLDS = {
  APPROACH: 40,
  CHIT_CHAT: 50,
  MINGLE: 60,
  DEEP_TALK: 70,
  NEEDS_OFFERS: 50,
  OFFERS_NEEDS: 40,
  KEYWORD_MATCH: 10,
};

export { THRESHOLDS };

export function jaccardSimilarity(setA, setB) {
  if (!setA?.length || !setB?.length) return 0;
  const a = new Set(setA);
  const b = new Set(setB);
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function computeRelevance(agentA, agentB) {
  let score = 0;

  const needsA = agentA.needs || [];
  const offersA = agentA.offers || [];
  const needsB = agentB.needs || [];
  const offersB = agentB.offers || [];
  const keywordsA = agentA.keywords || [];
  const keywordsB = agentB.keywords || [];

  for (const need of needsA) {
    if (offersB.some((o) => o.includes(need) || need.includes(o))) {
      score += THRESHOLDS.NEEDS_OFFERS;
    }
  }

  for (const offer of offersA) {
    if (needsB.some((n) => n.includes(offer) || offer.includes(n))) {
      score += THRESHOLDS.OFFERS_NEEDS;
    }
  }

  const overlapCount = keywordsA.filter((k) => keywordsB.includes(k)).length;
  score += overlapCount * THRESHOLDS.KEYWORD_MATCH;

  return score;
}

function matchScore(listA, listB) {
  if (!listA?.length || !listB?.length) return 0;
  let matches = 0;
  for (const item of listA) {
    if (listB.some((b) => b.includes(item) || item.includes(b))) {
      matches++;
    }
  }
  return matches / Math.max(listA.length, 1);
}

export function combinedRelevance(observer, _subject, memory) {
  const base = jaccardSimilarity(observer.domainTags || observer.keywords || [], memory.domainTags || []) * 0.2;

  const needsOffersMatch = matchScore(observer.needs || [], memory.typicalOffers || []);
  const offersNeedsMatch = matchScore(observer.offers || [], memory.typicalNeeds || []);
  const recent = (needsOffersMatch + offersNeedsMatch) * 0.5;

  let interaction = 0.5;
  if (memory.totalMingles > 0) {
    interaction = memory.successfulMingles / memory.totalMingles;
  }

  let recencyBoost = 0;
  if (memory.lastMingleTs) {
    const daysSinceMingle = (Date.now() - new Date(memory.lastMingleTs).getTime()) / 86400000;
    recencyBoost = Math.max(0, 0.2 - (daysSinceMingle / 7) * 0.2);
  }

  return (base * 0.2) + (recent * 0.5) + (interaction * 0.2) + recencyBoost;
}

export function shouldApproach(agentA, agentB, relevanceScore) {
  if (agentA.agentId === agentB.agentId) return false;
  return relevanceScore >= THRESHOLDS.APPROACH;
}

export function getInteractionType(relevanceScore) {
  if (relevanceScore >= THRESHOLDS.DEEP_TALK) return 'deep_talk';
  if (relevanceScore >= THRESHOLDS.MINGLE) return 'chit_chat';
  if (relevanceScore >= THRESHOLDS.CHIT_CHAT) return 'gossip';
  return null;
}

export function computeRelevanceMatrix(signals) {
  const matrix = {};
  for (const a of signals) {
    matrix[a.agentId] = {};
    for (const b of signals) {
      if (a.agentId === b.agentId) continue;
      matrix[a.agentId][b.agentId] = computeRelevance(a, b);
    }
  }
  return matrix;
}

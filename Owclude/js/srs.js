/* =============================================================================
   srs.js — spaced repetition scheduling (simplified SM-2) + difficulty tiers.

   Locked spec (from planning):
     Easy      >= 80% accuracy
     Medium    50–79%
     Difficult < 50%
     "New"     fewer than MIN_REVIEWS_FOR_TIER reviews — no tier assigned yet

   SM-2 is simplified to binary correct/incorrect (no 0–5 quality scale,
   since the review UI is a single right/wrong tap, not a graded scale).
   ============================================================================= */

const MIN_REVIEWS_FOR_TIER = 3;
const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;

/**
 * Given an occlusion's prior SRS state (derived from its most recent review,
 * or defaults if none yet) and a new result, compute the next state.
 */
function computeNextReviewState(priorState, result){
  const prior = priorState || { ease: DEFAULT_EASE, interval: 0, repetitions: 0 };
  let { ease, interval, repetitions } = prior;

  if(result === 'correct'){
    repetitions += 1;
    if(repetitions === 1) interval = 1;
    else if(repetitions === 2) interval = 6;
    else interval = Math.round(interval * ease);
    ease = Math.min(3.0, ease + 0.1);
  } else {
    repetitions = 0;
    interval = 1;
    ease = Math.max(MIN_EASE, ease - 0.2);
  }

  const dueAt = Date.now() + interval * 24 * 60 * 60 * 1000;
  return { ease, interval, repetitions, dueAt };
}

/** Derive the "prior state" SM-2 needs from a list of past reviews, newest first. */
function priorStateFromReviews(reviews){
  if(!reviews || reviews.length === 0) return null;
  const sorted = [...reviews].sort((a,b) => b.timestamp - a.timestamp);
  const last = sorted[0];
  return {
    ease: typeof last.ease === 'number' ? last.ease : DEFAULT_EASE,
    interval: typeof last.interval === 'number' ? last.interval : 0,
    repetitions: sorted.filter((r, i) => {
      // count the current unbroken streak of corrects from the top
      for(let j = 0; j <= i; j++) if(sorted[j].result !== 'correct') return false;
      return true;
    }).length,
  };
}

function computeAccuracy(reviews){
  if(!reviews || reviews.length === 0) return null;
  const correct = reviews.filter(r => r.result === 'correct').length;
  return correct / reviews.length;
}

function computeDifficultyTier(reviews){
  if(!reviews || reviews.length < MIN_REVIEWS_FOR_TIER) return 'new';
  const acc = computeAccuracy(reviews);
  if(acc >= 0.8) return 'easy';
  if(acc >= 0.5) return 'medium';
  return 'difficult';
}

const TIER_LABEL = { new:'New', easy:'Easy', medium:'Medium', difficult:'Difficult' };

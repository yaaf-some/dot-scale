// Tunable thresholds for the insights engine. Everything the rules compare against lives here,
// so tuning the coach never means touching analyze.js.
//
// Provenance: these are community rules of thumb (not lab facts), written for a 16 g double on a
// NON-pressurized basket on a 15-bar vibration pump machine (De'Longhi EC260, no preinfusion control).
// Typical sources: James Hoffmann / Lance Hedrick / Scott Rao style dial-in guidance (a 1:2 shot in
// ~25-30 s; fast = sour, slow = bitter; fix channeling with puck prep, not grind), plus Timemore Dot data.
// Anything marked "unverified" has not been checked against real hardware yet. When a rule feels wrong
// in daily use, change the number here and add or adjust the matching test.

export const METHOD_FAMILY = {
  espresso: 'espresso',
  'pour-over': 'pourover',
  pourover: 'pourover',
  'french-press': 'immersion',
  aeropress: 'immersion',
  prestina: 'immersion',
  moka: 'moka',
};

// Learn card ids referenced by tips. A test checks each one exists in app/learn/cards.js.
export const LEARN = {
  numbers: 'reading-the-numbers',
  ratio: 'ratio-and-strength',
  fastSour: 'why-fast-sour',
  slowBitter: 'why-slow-bitter',
  grindFirst: 'grind-first',
  oneChange: 'one-change',
  firstDrops: 'first-drops',
  flowCurve: 'flow-curve',
  channeling: 'channeling',
  puckPrep: 'puck-prep',
  nakedSpurts: 'naked-spurts',
  freshness: 'bean-freshness',
  dose: 'dose-and-basket',
  stopEarly: 'stop-early',
  blonding: 'blonding',
  tasteVsTime: 'taste-vs-time',
  sourBitter: 'sour-or-bitter',
  temperature: 'water-temperature',
  dialledIn: 'dialled-in',
  stepSize: 'grind-step-size',
  pours: 'pourover-pours',
  bloom: 'bloom',
  drawdown: 'pourover-drawdown',
  immersion: 'immersion-timing',
  press: 'press-pressure',
  moka: 'moka-heat',
};

export const RULES = {
  // Signal processing ---------------------------------------------------------------------------
  smoothS: 0.6, // flow smoothing window. Long enough to calm 0.1 g scale steps, short enough to keep a 1 s spike.
  activeFlowGps: 1.0, // pour-over / immersion: flow above this counts as "pouring/pressing".
  segmentGapS: 2.5, // active spells closer than this are one pour.

  espresso: {
    // Shot time for the whole 1:2 shot (PRODUCT.md §8). 25-30 s is the sweet spot; 22-35 s is "taste decides".
    time: { fastBelowS: 22, sweetFromS: 25, sweetToS: 30, slowAboveS: 35, gusherBelowS: 15, crawlAboveS: 45 },
    // Normalise time to the target yield when a shot was stopped well short/long (linear, rough).
    projectIfOffByFraction: 0.1,
    projectClamp: [0.6, 1.6],
    yieldToleranceG: 2, // within this of the target counts as on target.
    // First drops: PRODUCT.md §8. No preinfusion control, so a long wait is informative.
    firstDrop: { weightG: 0.5, earlyBelowS: 5, lateAboveS: 12 },
    // Main phase = from firstDrop+startAfterS to the stop. "Body" is its first bodyFraction; the rest is "late".
    main: { startAfterS: 2, bodyFraction: 0.75, minLengthS: 4, stopFlowGps: 0.4, endTrimS: 0.3 },
    // Flow stability. A healthy shot has CV ~0.1-0.2 (it ramps a bit). Spikes > 2x median flow are
    // typical of channeling or naked-portafilter spurts.
    stability: { cvUnstable: 0.3, spikeRatio: 2.0 },
    // Late-shot flow vs body flow. ~1.2 is a normal gentle rise; >=1.5 is blonding/channel territory.
    lateRamp: { blondingRatio: 1.5 },
    // Drip after the pump stops. 1-2 g is normal; from 2 g up it is worth stopping early.
    drip: { noticeG: 2, minSecondsAfterStop: 1 },
    // Under-filled basket (dose below basket size by this much) -> gusher / uneven.
    basketDefaultG: 16,
    doseLowByG: 1.5,
    // Bean age from roast date, days. Under 5: gassy and erratic. Over 42: expect faster shots. (rule of thumb)
    beanAgeDays: { tooFresh: 5, stale: 42 },
    // Suggested step sizes.
    grindStepsNear: 1, // within ~8 s of the window
    grindStepsFar: 2,
    farOffS: 8,
    gusherSteps: '2-3',
    yieldAdjustG: 4, // sour/bitter/strength: change yield by about 4 g (about 0.25 of a ratio step on 16 g)
    // History: "you went finer and time rose 6 s".
    history: { meaningfulTimeChangeS: 3, noEffectBelowS: 2, sameGrindTimeSwingS: 6, streakForConfidence: 3 },
    dialIn: { minStars: 4, consecutive: 2 },
  },

  pourover: {
    // Total time for a ~250 g cone brew (PRODUCT.md §9: 3:00-3:30 planned). Rule of thumb, unverified here.
    time: { fastBelowS: 150, slowAboveS: 240 },
    drawdown: { slowAboveS: 90 },
    pourRateFastGps: 8, // gentle pours are usually ~4-7 g/s
    steps: { toleranceS: 8, reachToleranceG: 2, minAdherence: 0.5 },
    yieldAdjustG: 20, // strength: ~1:1.3 of the 1:16.7 ratio is about 15 g dose -> change water by ~20 g
  },

  immersion: {
    // Steep windows (s). Starting points; the Prestina numbers are unverified.
    steep: {
      'french-press': { shortBelowS: 210, longAboveS: 720 },
      aeropress: { shortBelowS: 75, longAboveS: 210 },
      prestina: { shortBelowS: 60, longAboveS: 180 },
    },
    steepStepS: 30,
    steps: { toleranceS: 8, reachToleranceG: 2, minAdherence: 0.5 },
  },

  moka: {
    // Very rough, low confidence. Low-and-slow vs. spurting.
    time: { fastBelowS: 120, slowAboveS: 420 },
    lateRamp: { spurtRatio: 1.8 },
  },

  // Ranking: higher wins. The UI shows the top tip and up to two more, one per variable.
  priority: {
    dialledIn: 100,
    tasteWins: 95,
    freshBeans: 92,
    puckPrep: 90,
    technique: 85,
    lowDose: 88,
    historyWrongWay: 85,
    historyKeepGoing: 80,
    historyOvershoot: 80,
    historyNoEffect: 78,
    tasteAndTime: 75,
    timeGrind: 70,
    tasteRatio: 66,
    strength: 60,
    pourOverGeneral: 62,
    followSteps: 58,
    firstDrops: 55,
    staleBeans: 52,
    blonding: 50,
    stopEarly: 45,
    targetMiss: 42,
    repeat: 30,
    logTaste: 20,
  },

  maxTips: 3,
};

// Learn cards: short, one idea each, plain language. Tips in app/insights reference them by id
// (see LEARN in app/insights/rules.js). Numbers are rule-of-thumb starting points, not laws.
// Card shape: { id, title, body (one plain string, 3-6 sentences), topic, methods, diagram? (tiny inline SVG string) }.

const ESP = ['espresso'];
const ALL = ['espresso', 'pour-over', 'french-press', 'aeropress', 'prestina', 'moka'];
const IMM = ['french-press', 'aeropress', 'prestina'];

const svg = (inner, label) =>
  `<svg viewBox="0 0 200 80" role="img" aria-label="${label}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const FLOW_DIAGRAM = svg(
  '<path d="M10 70 H190 M10 70 V10" opacity=".35"/>' +
    '<path d="M10 68 C30 60 40 30 60 28 C90 26 120 24 150 20 L185 16"/>' +
    '<path d="M10 68 C30 60 40 40 60 36 L90 34 L96 8 L104 36 L140 32 L150 12 L158 34 L185 30" stroke-dasharray="4 4" opacity=".7"/>' +
    '<text x="130" y="60" font-size="9" fill="currentColor" stroke="none">solid: even · dashed: spiky</text>',
  'Two flow curves: a smooth even one and a spiky one',
);

const TASTE_DIAGRAM = svg(
  '<path d="M20 40 H180"/><path d="M100 32 V48"/>' +
    '<text x="14" y="26" font-size="10" fill="currentColor" stroke="none">sour</text>' +
    '<text x="76" y="26" font-size="10" fill="currentColor" stroke="none">balanced</text>' +
    '<text x="146" y="26" font-size="10" fill="currentColor" stroke="none">bitter</text>' +
    '<text x="14" y="66" font-size="9" fill="currentColor" stroke="none">extract more →</text>' +
    '<text x="110" y="66" font-size="9" fill="currentColor" stroke="none">← extract less</text>',
  'A scale from sour through balanced to bitter',
);

const RATIO_DIAGRAM = svg(
  '<rect x="20" y="30" width="24" height="30"/><text x="16" y="24" font-size="9" fill="currentColor" stroke="none">16 g in</text>' +
    '<path d="M54 45 H84"/><path d="M78 39 L84 45 L78 51"/>' +
    '<rect x="94" y="14" width="30" height="46"/><text x="94" y="10" font-size="9" fill="currentColor" stroke="none">32 g out</text>' +
    '<text x="140" y="50" font-size="12" fill="currentColor" stroke="none">1 : 2</text>',
  'Sixteen grams of coffee in, thirty-two grams of espresso out: a 1 to 2 ratio',
);

export const CARDS = [
  {
    id: 'reading-the-numbers', topic: 'basics', methods: ALL,
    title: 'What the numbers mean',
    body: 'Dose is the dry coffee you put in; yield is the liquid that comes out, both in grams. Ratio is yield divided by dose, so 16 g in and 32 g out is 1:2. Time runs from the moment the shot or the first pour starts. Flow is how many grams per second reach the cup. Together they show how a brew went before you even taste it.',
  },
  {
    id: 'ratio-and-strength', topic: 'basics', methods: ALL, diagram: RATIO_DIAGRAM,
    title: 'Ratio sets strength',
    body: 'More liquid through the same coffee makes a longer ratio: a bigger drink that dissolves more of the coffee but tastes thinner. A shorter ratio tastes more concentrated and can come out sharp or sour. A 1:2 espresso is a common starting point, and many people enjoy anything from about 1:1.5 to 1:3. If strength is the problem, change the yield. Grind changes the speed, not the strength.',
  },
  {
    id: 'why-fast-sour', topic: 'espresso', methods: ESP,
    title: 'Why fast shots taste sour',
    body: 'Water that rushes through the puck has little time to dissolve coffee. The first things to dissolve are acids and some sugars, and the heavier, bitter flavours come later. So a fast shot often tastes sour, thin or a bit salty. Coffee people call this under-extracted. Grinding finer slows the water down and lets more dissolve.',
  },
  {
    id: 'why-slow-bitter', topic: 'espresso', methods: ESP,
    title: 'Why slow shots taste bitter',
    body: 'A slow shot keeps water in contact with the coffee for longer, so more of the harsh late flavours dissolve. That tastes bitter, dry or astringent (the puckering, drying feeling, like strong black tea). Grinding a little coarser speeds the shot up. If a slow shot still tastes sour, the water probably found easy paths instead of flowing evenly. See channeling.',
  },
  {
    id: 'grind-first', topic: 'espresso', methods: ESP,
    title: 'Grind first, then everything else',
    body: 'For espresso, grind size is the lever that moves shot time the most. Finer means slower and a longer shot; coarser means faster. Get the time into range with the grind, then use the yield to tune strength. Grinders number their settings differently and "finer" is not always the lower number, so check yours once and note it in Settings.',
  },
  {
    id: 'one-change', topic: 'basics', methods: ALL,
    title: 'One change at a time',
    body: 'If you change grind, dose and tamp together, you cannot tell which one helped. Change one thing, pull the shot, and compare. It feels slower, but it usually gets you to a good cup in fewer tries. This is why Dot Scale suggests just one change after each brew.',
  },
  {
    id: 'first-drops', topic: 'espresso', methods: ESP,
    title: 'First drops: your early clue',
    body: 'First drops is the time from starting the shot until coffee first reaches the cup. The EC260 has no preinfusion control, so a long wait (over about 12 s) often means the puck is too fine or packed too hard. A very short wait (under about 5 s) can mean the grind is too coarse, the dose is low, or water is racing around the puck. Treat it as a clue and read it together with the total time.',
  },
  {
    id: 'flow-curve', topic: 'espresso', methods: ESP, diagram: FLOW_DIAGRAM,
    title: 'Reading the flow curve',
    body: 'A healthy shot starts slowly, climbs, then settles into a fairly steady stream, sometimes rising a little near the end. Sharp spikes, sudden jumps or a big surge late in the shot suggest the water found shortcuts. Smooth does not guarantee tasty, but a spiky curve is worth fixing first. Flow is the speed of coffee reaching the cup, in grams per second.',
  },
  {
    id: 'channeling', topic: 'espresso', methods: ESP,
    title: 'What is channeling?',
    body: 'Channeling means water finds a few weak paths through the puck instead of flowing evenly. Those paths get over-extracted (bitter) while the rest of the coffee is under-extracted (sour), so one cup can taste both. On the curve it often shows as a flow spike or a shot that runs faster than the grind suggests. Better puck prep, not a different grind, is the usual fix.',
  },
  {
    id: 'puck-prep', topic: 'espresso', methods: ESP,
    title: 'Puck prep and WDT',
    body: 'Puck prep is everything between the grinder and the machine. WDT (Weiss Distribution Technique) means stirring the grounds with fine needles, or even a straightened paperclip, to break up clumps. Then level the bed and tamp straight with firm, consistent pressure. Even density gives even flow. Doing it the same way every time means any change in the cup comes from what you changed on purpose.',
  },
  {
    id: 'naked-spurts', topic: 'espresso', methods: ESP,
    title: 'Spurts on a naked portafilter',
    body: 'A bottomless (naked) portafilter lets you watch the coffee come out. A smooth stream that gathers into one steady flow is a good sign. Little jets or sideways sprays mean water is breaking through weak spots in the puck. That is a puck-prep problem, so look at distribution and levelling before the grind. They are easiest to spot in the first 10 seconds.',
  },
  {
    id: 'bean-freshness', topic: 'beans', methods: ALL,
    title: 'Fresh, peak and stale beans',
    body: 'Freshly roasted beans release carbon dioxide for days, which makes espresso gassy and its flow erratic. Many people find about a week after roasting is a good time to start, and that espresso tastes best within the first few weeks. This varies by roast and bean, so take it as a rule of thumb. After roughly six weeks beans are usually staler and shots run faster, so you may need to grind finer. Keep beans sealed, cool and dark.',
  },
  {
    id: 'dose-and-basket', topic: 'espresso', methods: ESP,
    title: 'Dose and basket size',
    body: 'Every basket is designed for a dose range; for your double that is about 16 to 16.5 g. Under-filling leaves a gap above the puck, so water splashes and digs, and shots run fast and uneven. Overfilling can press the puck against the shower screen and hurt flow too. Weigh the dose to 0.1 g every time.',
  },
  {
    id: 'stop-early', topic: 'espresso', methods: ESP,
    title: 'Why stop before the target',
    body: 'Coffee keeps dripping for a moment after you stop the shot, because pressure is still draining out of the coffee. That is usually a gram or two. To land on 32 g, stop a little before it. Dot Scale learns your typical drip and can cue you early.',
  },
  {
    id: 'blonding', topic: 'espresso', methods: ESP,
    title: 'Blonding: when the shot runs out',
    body: 'Blonding is when the stream turns pale and thin near the end of a shot, because most of the good flavour has already dissolved. The flow often speeds up too. Letting the shot run into it adds watery, sometimes bitter flavours to the cup. Stopping a few grams sooner is the simplest fix.',
  },
  {
    id: 'taste-vs-time', topic: 'basics', methods: ALL,
    title: 'Taste beats the clock',
    body: 'Time ranges are starting points, not rules. If a shot ran outside the usual window and tastes great, keep it and note the time that worked for those beans. When taste and time disagree, say a fast shot that tastes bitter, look for unevenness before touching the grind. Your tongue has the final say.',
  },
  {
    id: 'sour-or-bitter', topic: 'basics', methods: ALL, diagram: TASTE_DIAGRAM,
    title: 'Sour or bitter?',
    body: 'Sour (sharp, lemony, thin) usually means under-extracted, so extract more: finer grind, longer ratio or steep, hotter water. Bitter (harsh, dry, ashy) usually means over-extracted, so extract less. Weak or strong is a separate question about concentration, which the ratio answers. If one cup tastes both sour and bitter, suspect uneven extraction.',
  },
  {
    id: 'water-temperature', topic: 'basics', methods: ALL,
    title: 'Water temperature',
    body: 'Hotter water dissolves coffee faster, so a higher temperature extracts more. Lighter roasts often like hotter water, around 93 to 96 °C, and darker roasts do better a bit cooler. The EC260 has no temperature control, but a warm portafilter and cup and a quick flush of the group head make shots more consistent. For brewers where you pour the water yourself, a degree or two matters much less than grind and time.',
  },
  {
    id: 'dialled-in', topic: 'basics', methods: ALL,
    title: 'What "dialled in" means',
    body: 'A bean is dialled in when you can repeat the same recipe and get a tasty, in-range result. Dot Scale marks it after two shots in a row in the time range and rated 4 stars or more. Beans change as they age, so expect to nudge the grind every week or two. Dialling in is a habit, not a one-off.',
  },
  {
    id: 'grind-step-size', topic: 'espresso', methods: ESP,
    title: 'How big is one grind step?',
    body: 'It depends on your grinder. On many grinders one step shifts espresso time by roughly 2 to 5 seconds, but treat that as a loose guess. If a step changed nothing, take two. If it overshot, go back half a step. Writing the grind setting into each brew lets the app show how your changes moved the time.',
  },
  {
    id: 'pourover-pours', topic: 'pour-over', methods: ['pour-over'],
    title: 'Pouring well',
    body: 'A pour-over is a bloom followed by a few pours to set target weights. Pour slowly in small circles, away from the filter wall, so the bed stays level. Faster pours stir the bed and speed up the drain; gentler ones keep extraction calmer. Hit each target weight close to its planned time so one brew can be compared with the next.',
  },
  {
    id: 'bloom', topic: 'pour-over', methods: ['pour-over'],
    title: 'The bloom',
    body: 'The bloom is a first small pour, about twice the weight of the coffee, followed by a wait of 30 to 45 seconds. Fresh coffee releases carbon dioxide, and the gas would otherwise push water away from the grounds. A bubbling dome means the beans are fresh. Stir or swirl gently so every bit of coffee gets wet.',
  },
  {
    id: 'pourover-drawdown', topic: 'pour-over', methods: ['pour-over'],
    title: 'Drawdown time',
    body: 'Drawdown is the time from the last pour until the water has drained through. A long drawdown, over about a minute and a half for a cone dripper, usually means the grind is too fine or fine particles have clogged the paper. A total brew time of roughly 2:30 to 4:00 for 250 g is typical, but your dripper and filter change it. Go one step coarser if the bed is choking.',
  },
  {
    id: 'immersion-timing', topic: 'immersion', methods: IMM,
    title: 'Timing an immersion brew',
    body: 'In French press, AeroPress and Prestina the coffee sits in the water together, so steep time is the main lever. A longer steep extracts more; a shorter one extracts less. Change the steep in steps of about 30 seconds before changing the grind. If it tastes sour, steep longer; if bitter, steep shorter.',
  },
  {
    id: 'press-pressure', topic: 'immersion', methods: IMM,
    title: 'How the press should feel',
    body: 'Press slowly and steadily, over roughly 20 to 40 seconds. If it is very hard to push, the grind may be too fine and clogging the filter. If it drops with no resistance, the grind may be too coarse. Stop at the hiss and leave the last drops. Forcing a press can push bitter fines into your cup.',
  },
  {
    id: 'moka-heat', topic: 'moka', methods: ['moka'],
    title: 'Moka pot heat',
    body: 'A moka pot is driven by steam pressure, so the heat sets the pace. Medium-low heat with the lid open lets you watch the coffee and keeps it from scorching. When the stream turns pale and starts sputtering, take it off the heat. Running the base under cold water stops extraction at once. These are rules of thumb; pots vary.',
  },
];

export const CARDS_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));

export function getCard(id) {
  return CARDS_BY_ID[id] ?? null;
}

export function cardsForMethod(method) {
  return CARDS.filter((c) => c.methods.includes(method));
}

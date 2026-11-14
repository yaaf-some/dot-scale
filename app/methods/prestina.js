// Wacaco Prestina (240 ml cup-driven immersion press). UNVERIFIED: Wacaco's official ratio and times were not found,
// so every number here (14 g : 220 g, medium-fine, 1:30-2:00 immersion) is the starting guess from docs/PRODUCT.md §9
// ("refine with use"). Do not present these as official. Mark/verify when the household has dialled it in.

export default {
  id: 'prestina',
  name: 'Wacaco Prestina',
  icon: 'prestina',
  kind: 'immersion',
  unverified: true,
  note: 'Starting guess, not official Wacaco numbers. Refine with use.',
  tareAfterDose: 'now',
  captures: ['dose'],
  timeRangeS: [90, 120],
  defaults: { method: 'prestina', name: 'Prestina 14 g : 220 g', dose: 14, yield: 220, ratio: 15.71, tempC: 95, grind: { text: 'medium-fine' } },
  steps: [
    { kind: 'pour', label: 'Pour to {t} g', atS: 0, durationS: 10, of: { yield: 1 } },
    { kind: 'stir', label: 'Stir', atS: 10, durationS: 5 },
    { kind: 'wait', label: 'Immerse', atS: 15, durationS: 90 },
    { kind: 'press', label: 'Press', atS: 105, durationS: 15 },
  ],
  prep: ['Preheat the cup and unit', 'Grind {dose} g into the basket', 'Kettle at {temp} °C'],
  learn: ['immersion-basics', 'grind-size'],
};

// French press, the "long steep" style: 30 g : 500 g (1:16.7), about 95 C, 4:00 steep, break the crust and skim,
// wait 5 more minutes, then press gently. Based on James Hoffmann's "ultimate French press" technique; docs/PRODUCT.md §9.

export default {
  id: 'french-press',
  name: 'French press',
  icon: 'french-press',
  kind: 'immersion',
  tareAfterDose: 'now',
  captures: ['dose'],
  timeRangeS: [540, 600],
  defaults: { method: 'french-press', name: 'French press 30 g : 500 g', dose: 30, yield: 500, ratio: 16.67, tempC: 95, grind: { text: 'coarse' } },
  steps: [
    { kind: 'pour', label: 'Pour to {t} g, all at once', atS: 0, durationS: 15, of: { yield: 1 } },
    { kind: 'wait', label: 'Steep, lid on', atS: 15, durationS: 225 },
    { kind: 'stir', label: 'Break the crust and stir gently', atS: 240, durationS: 15 },
    { kind: 'stir', label: 'Skim the foam', atS: 255, durationS: 15 },
    { kind: 'wait', label: 'Let it settle for 5 minutes', atS: 270, durationS: 300 },
    { kind: 'plunge', label: 'Press gently, just below the surface', atS: 570, durationS: 30 },
  ],
  prep: ['Preheat the press', 'Grind {dose} g coarse into it', 'Kettle at {temp} °C'],
  learn: ['immersion-basics', 'french-press-crust', 'grind-size'],
};

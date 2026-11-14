// AeroPress, standard (upright) orientation: 11-12 g : 200 g, about 95 C, 2:00 steep, swirl, wait 30 s, press gently.
// Community starting point in the spirit of James Hoffmann's AeroPress recipe; docs/PRODUCT.md §9. Pressing on the scale
// loads it, so the weight is read before the press.

export default {
  id: 'aeropress',
  name: 'AeroPress',
  icon: 'aeropress',
  kind: 'immersion',
  tareAfterDose: 'now',
  captures: ['dose'],
  timeRangeS: [150, 210],
  defaults: { method: 'aeropress', name: 'AeroPress 12 g : 200 g', dose: 12, yield: 200, ratio: 16.67, tempC: 95, grind: { text: 'medium-fine' } },
  steps: [
    { kind: 'pour', label: 'Pour to {t} g', atS: 0, durationS: 15, of: { yield: 1 } },
    { kind: 'wait', label: 'Steep', atS: 15, durationS: 105 },
    { kind: 'swirl', label: 'Swirl gently', atS: 120, durationS: 5 },
    { kind: 'wait', label: 'Wait 30 seconds', atS: 125, durationS: 25 },
    { kind: 'press', label: 'Press gently, about 30 s', atS: 150, durationS: 30 },
  ],
  prep: ['Rinse the paper filter and the cap', 'Grind {dose} g into the AeroPress', 'Kettle at {temp} °C'],
  learn: ['immersion-basics', 'aeropress-press', 'grind-size'],
};

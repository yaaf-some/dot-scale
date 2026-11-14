// Pour-over, V60-style cone. Starting point: 15 g : 250 g (about 1:16.7), 93-96 C, bloom 2x dose for 45 s,
// then pours to 60% and 100% of the water, total about 3:00-3:30. Shape follows James Hoffmann's "ultimate V60" technique
// (bloom 2-3x, 60% by about 1:15, finish by about 2:00) and docs/PRODUCT.md §9. Times are guides, not rules.

export default {
  id: 'pour-over',
  name: 'Pour-over',
  icon: 'pour-over',
  kind: 'pour',
  tareAfterDose: 'now', // coffee is weighed in the filter on the server; tare straight after, then pour
  captures: ['dose'],
  timeRangeS: [180, 210],
  defaults: { method: 'pour-over', name: 'V60 15 g : 250 g', dose: 15, yield: 250, ratio: 16.67, tempC: 94, grind: { text: 'medium-fine' } },
  steps: [
    { kind: 'bloom', label: 'Bloom: pour to {t} g, wet everything', atS: 0, durationS: 45, of: { dose: 2 } },
    { kind: 'pour', label: 'Pour slowly to {t} g', atS: 45, durationS: 40, of: { yield: 0.6 } },
    { kind: 'pour', label: 'Pour to {t} g', atS: 90, durationS: 30, of: { yield: 1 } },
    { kind: 'wait', label: 'Let it draw down', atS: 120, durationS: 75 },
  ],
  prep: ['Rinse the filter, dripper on the server', 'Grind {dose} g into the filter', 'Kettle at {temp} °C'],
  learn: ['pour-over-bloom', 'grind-size', 'water-temperature'],
};

// Moka pot: fill the basket level (about 15-20 g, depending on pot size) and fill the base with hot water to just below the valve.
// The scale is only used for dose and water weight; then a timer with a heat-off cue. Defaults assume a 3-cup pot
// (about 15-17 g basket, about 130 g water): both are pot-specific starting points, not verified for a particular pot.
// The 4:00 heat-off time is a rough guide: the real cue is the first gurgle / blond flow. Docs: docs/PRODUCT.md §9.
// For this method `yield` is the weight of water put in the base (the cup output is about 85-90% of it).

export default {
  id: 'moka',
  name: 'Moka pot',
  icon: 'moka',
  kind: 'moka',
  tareAfterDose: 'cup', // weigh the coffee, then the base is put on: tare when it is placed, then weigh the water
  captures: ['dose', 'water'],
  timeRangeS: [240, 300],
  defaults: { method: 'moka', name: 'Moka 3-cup', dose: 16, yield: 130, ratio: 8.13, tempC: null, grind: { text: 'medium-fine' } },
  steps: [
    { kind: 'heat', label: 'Medium heat, lid open', atS: 0, durationS: 210 },
    { kind: 'heat', label: 'Remove from heat when it starts to gurgle or runs blond', atS: 210, durationS: 40 },
    { kind: 'wait', label: 'Cool the base under cold water to stop the brew', atS: 250, durationS: 20 },
  ],
  prep: ['Fill the base with hot water to the valve', 'Fill the basket level, do not tamp', 'Weigh coffee first, then the water'],
  learn: ['moka-basics', 'grind-size'],
};

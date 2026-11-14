// Espresso on the De'Longhi Stilosa EC260 (15-bar vibration pump, 51 mm group, unpressurised ~16 g double basket).
// Starting points (labelled as such in the UI): 1:2 (16 g -> 32 g) in 25-30 s, the common community baseline
// (e.g. James Hoffmann's espresso guides, Scott Rao). docs/PRODUCT.md §9. The EC260 has no temperature control: tempC is null.
// The Stilosa's 15 bar is the pump's maximum, not the extraction pressure; hence "time and flow are grind diagnostics".

export default {
  id: 'espresso',
  name: 'Espresso',
  icon: 'espresso',
  kind: 'espresso',
  tareAfterDose: 'cup', // dose is weighed in the portafilter; the cup is a separate object -> tare when the cup is placed
  captures: ['dose'],
  timeRangeS: [25, 30],
  defaults: {
    method: 'espresso', name: 'Espresso 1:2', dose: 16, yield: 32, ratio: 2, tempC: null,
    portafilter: 'spouted', // 'naked' | 'spouted'
    grind: { text: '' },
  },
  // One step: the whole shot. The live phases (waiting, first drops, main flow, finishing) are driven by the brew session.
  steps: [{ kind: 'pour', label: 'Pull the shot', atS: 0, durationS: 28, of: { yield: 1 } }],
  prep: ['Purge the grinder, then grind {dose} g', 'Distribute, tamp, lock the portafilter in', 'Cup on the scale'],
  learn: ['espresso-ratio', 'espresso-time', 'fast-shot-sour', 'puck-prep'],
};

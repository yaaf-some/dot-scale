// First-run seed records (PRODUCT.md §1). Ids are FIXED so two devices that both seed before they first sync end up
// with the same records instead of duplicates, and updatedAt is 1 so any real edit or delete (from any device) wins.
export const SEED_IDS = {
  yaaf: 'e478dd53-d3c9-49f1-b231-b69132a5ebf4',
  alexa: '19766f85-834c-4b9c-8199-eca50b8e387f',
  machine: '191a0ef8-e8ab-4fea-82f1-b01959a8e08e',
  basket: '550ed88a-406d-46e7-a377-20532a3ca0e8',
  naked: '79006ecf-931a-4543-8a7a-b0b395240ec0',
  spouted: 'f260f678-8915-4fb2-b4be-ce873805618e',
};

export const PROFILE_COLORS = ['#2442b8', '#b5532e', '#2e7d5b', '#8a4fb0', '#b08a1e', '#c23a6b'];
export const PROFILE_EMOJI = ['☕', '🫘', '🍵', '🧋', '🥛', '🌱', '🔥', '⭐'];

export function seedRecords() {
  const base = { updatedAt: 1, createdAt: 1 };
  return [
    { ...base, id: SEED_IDS.yaaf, type: 'profile', name: 'Yaaf', color: PROFILE_COLORS[0], emoji: '☕', methods: [],
      defaults: { machineId: SEED_IDS.machine, portafilter: 'naked', basketG: 16 } },
    { ...base, createdAt: 2, id: SEED_IDS.alexa, type: 'profile', name: 'Alexa', color: PROFILE_COLORS[2], emoji: '🌱', methods: [],
      defaults: { machineId: SEED_IDS.machine, portafilter: 'spouted', basketG: 16 } },
    { ...base, id: SEED_IDS.machine, type: 'gear', kind: 'espresso-machine', name: 'De’Longhi Stilosa EC260',
      props: { groupMm: 51, pumpBar: 15, pressureGauge: false, tempControl: false, preinfusionControl: false } },
    { ...base, id: SEED_IDS.basket, type: 'gear', kind: 'basket', name: 'Unpressurized double basket, 16 g',
      props: { doseG: 16, sizeMm: 51, pressurized: false } },
    { ...base, id: SEED_IDS.naked, type: 'gear', kind: 'portafilter', name: 'Naked portafilter',
      props: { style: 'naked', sizeMm: 51 } },
    { ...base, id: SEED_IDS.spouted, type: 'gear', kind: 'portafilter', name: '2-spout portafilter',
      props: { style: 'spouted', sizeMm: 51 } },
  ];
}

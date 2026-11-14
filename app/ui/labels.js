// Display names for the brew methods. Placeholder until app/methods/ lands (PRODUCT.md §9); that module's
// `name` and `icon` should replace this. Order here is the default tile order.
export const METHODS = [
  { id: 'espresso', name: 'Espresso', icon: 'espresso' },
  { id: 'pour-over', name: 'Pour-over', icon: 'pour-over' },
  { id: 'french-press', name: 'French press', icon: 'french-press' },
  { id: 'aeropress', name: 'AeroPress', icon: 'aeropress' },
  { id: 'moka', name: 'Moka pot', icon: 'moka' },
  { id: 'prestina', name: 'Prestina', icon: 'prestina' },
];
export const methodById = (id) => METHODS.find((m) => m.id === id) ?? { id, name: String(id).replace(/-/g, ' '), icon: 'brew' };

export const GEAR_KINDS = [
  { id: 'espresso-machine', name: 'Espresso machine', plural: 'Machines' },
  { id: 'grinder', name: 'Grinder', plural: 'Grinders' },
  { id: 'basket', name: 'Basket', plural: 'Baskets' },
  { id: 'portafilter', name: 'Portafilter', plural: 'Portafilters' },
  { id: 'brewer', name: 'Other brewer', plural: 'Other brewers' },
];

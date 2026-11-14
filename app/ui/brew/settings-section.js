// Brewing preferences that the Brew flow reads (device-local, in store.prefs). "Beep at target" and "Start the timer when
// pouring starts" already live in the Scale section.
import { registerSettingsSection } from '../settings-sections.js';
import { section, group, switchRow } from '../components.js';

registerSettingsSection({
  id: 'brewing', title: 'Brewing', order: 45,
  render: ({ prefs }) => section('Brewing', group(
    switchRow({ title: 'Tare the scale for me', sub: 'After the dose and when the cup goes on.', checked: prefs.get('autoTare', true), onchange: (v) => prefs.set('autoTare', v) }),
    switchRow({ title: 'Finish espresso by itself', sub: 'Stops the timer when the yield is reached and the flow has stopped.', checked: prefs.get('autoStop', true), onchange: (v) => prefs.set('autoStop', v) })),
  { id: 'brewing' }),
});

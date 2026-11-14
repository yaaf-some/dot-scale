// Extension point for Settings. A module adds a section without editing settings.js:
//   registerSettingsSection({ id: 'sync', title: 'Sync', order: 55, render: (ctx) => Node | Promise<Node> })
// Built-in orders: profiles 10, gear 20, beans 30, scale 40, appearance 60, advanced 90. Import your module from app/modules.js.
const sections = [];
export function registerSettingsSection(section) {
  const i = sections.findIndex((s) => s.id === section.id);
  if (i >= 0) sections.splice(i, 1);
  sections.push(section);
  sections.sort((a, b) => a.order - b.order);
}
export const settingsSections = () => sections.slice();

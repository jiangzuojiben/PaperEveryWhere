import icons from './plugin-icon-data.mjs';

const aliases = { document: 'file-text', home: 'house', 'help-circle': 'circle-help', dice: 'dices' };
export function getPluginIcon(id) {
  const name = String(id || '').replace(/^lucide-/, ''), data = icons[aliases[name] || name];
  if (!data) return null;
  const create = tag => document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  const svg = create('svg');
  for (const [key, value] of Object.entries({ xmlns: 'http://www.w3.org/2000/svg', width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: `svg-icon lucide-${name}`, 'aria-hidden': 'true' })) svg.setAttribute(key, String(value));
  for (const [tag, attributes] of data) { const node = create(tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); svg.appendChild(node); }
  return svg;
}
export function setPluginIcon(element, id) {
  const icon = getPluginIcon(id); element.replaceChildren(); if (icon) element.appendChild(icon);
}
